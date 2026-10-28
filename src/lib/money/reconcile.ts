import type { PayoutDestination, ReadBack, Ready, SendContext } from "../adapters/types";
import type { Session } from "../auth/claims";
import type { Queryable, TenantDb } from "../db";
import {
  adapterReady,
  categoryOf,
  isHooked,
  needsDestination,
  paymentFor,
  payoutOf,
  resolveDeps,
  systemFor,
  withTimeout,
  type MoneyDeps,
} from "./execute";
import { isOutsideRecord, switchOn, type Settlement } from "./ledger";
import type { PendingSubject } from "./read";
import {
  KIND_SHAPES,
  MONEY_ACTION_KINDS,
  railOf,
  type MoneyAction,
  type MoneyActionKind,
  type MoneyFailure,
} from "./types";

// Finishes what a send left open: rows unknown, and rows still sent after the window (their
// sender died or its settle did not commit). Each is read back from the outside system by its
// request id. Found succeeded for the whole approved amount: confirmed by read-back, plus the
// same follow-up write the executor would have made. Succeeded for another amount: failed as
// amount_mismatch, for a person. Found failed or canceled: failed as outside_failed (no money
// moved; a person may retry). Still pending, a status outside the contract, nothing found, an
// error or a timeout: still unknown, one more check counted; at the check limit the row needs a
// person and the pass skips it, except in a person's check on one record's page
// (ignoreCheckLimit, accepted only with a subject), which still reads that record's rows back the
// same read-only way. Never sends anything new. Agent code cannot import this file
// (eslint.config.mjs).

export type ReconcileHooks = {
  // The follow-up write a confirmed action needs (an advance to paid, say). Required: a row is
  // never confirmed without it.
  onConfirmed(q: Queryable, action: MoneyAction): Promise<void>;
  onFailed?(q: Queryable, action: MoneyAction): Promise<void>;
  // Hooked kinds only (an accounting post, or a payment kind with no rail): the read-back for
  // this action. Payouts on a rail read back through the payment adapter and must not pass this.
  readBack?(action: MoneyAction, ctx: SendContext): Promise<ReadBack>;
  // Payment kinds with no rail only: the caller's adapter asked whether it can answer now.
  ready?(): Promise<Ready>;
  // Payment kinds on a rail only, the executor's hook: where the payout went, read again for the
  // read-back. A kind whose adapter needs a destination is skipped without it, never guessed at.
  destination?(q: Queryable, action: MoneyAction): Promise<PayoutDestination | null>;
};

export type ReconcileOptions = {
  limit?: number;
  olderThanSeconds?: number;
  // A kind without hooks is not read, never guessed at.
  hooks: Partial<Record<MoneyActionKind, ReconcileHooks>>;
  // Only this subject's rows (a check pressed on one record's page); every subject when absent.
  subject?: PendingSubject;
  // A person's check on that one record: its rows are read back even at the check limit (still
  // read-only toward the outside system). Refused without a subject, so an unscoped or scheduled
  // pass always keeps the limit.
  ignoreCheckLimit?: boolean;
};

export type ReconcileSummary = {
  checked: number;
  confirmed: number;
  failed: number;
  stillUnknown: number;
  skipped: number;
  errors: number;
};

type Found = Extract<ReadBack, { found: true }>;

async function readBackOf(
  db: TenantDb,
  tenantId: string,
  action: MoneyAction,
  hooks: ReconcileHooks,
  ctx: SendContext,
  d: MoneyDeps,
): Promise<Found | { category: MoneyFailure }> {
  let work: () => Promise<ReadBack>;
  if (!isHooked(action.kind)) {
    const payment = paymentFor(action.kind, d);
    // The destination the send used, read again in its own short transaction.
    let destination: PayoutDestination | null = null;
    if (hooks.destination) {
      const read = hooks.destination;
      try {
        destination = await db.withTenant(tenantId, (q) => read(q, action));
      } catch (err) {
        return { category: categoryOf(err) };
      }
      if (destination === null) return { category: "validation" };
    } else if (needsDestination(payment)) {
      return { category: "validation" };
    }
    const payout = payoutOf(action, destination);
    work = () =>
      payment.readBack({ requestId: action.requestId, outsideId: action.outsideId, payout }, ctx);
  } else {
    work = () => (hooks.readBack as NonNullable<ReconcileHooks["readBack"]>)(action, ctx);
  }
  try {
    const rb = await withTimeout<ReadBack | null>(work, d.timeoutMs, () => null);
    if (rb === null) return { category: "timeout" };
    if (rb?.found === true) return rb;
    return { category: "unknown" };
  } catch (err) {
    return { category: categoryOf(err) };
  }
}

// What a found record means for the row, its status compared whole. Only "succeeded" confirms;
// "failed" and "canceled" are a definite end with no money moved; anything else (pending, or a
// value outside the contract) stays unknown.
function settlementOf(
  action: MoneyAction,
  rb: Found,
  d: MoneyDeps,
): Settlement | { category: MoneyFailure } {
  const outside = {
    system: rb.system,
    type: rb.type,
    id: rb.id,
    ref: rb.ref ?? null,
    amountCents: rb.amountCents,
  };
  const expected = systemFor(action.kind, d);
  if (!isOutsideRecord(outside) || outside.system !== expected) return { category: "unknown" };
  const status: unknown = rb.status;
  if (status === "succeeded") {
    if (outside.amountCents === action.amountCents) {
      return { to: "confirmed", via: "read_back", outside };
    }
    return { to: "failed", via: "read_back", category: "amount_mismatch", outside };
  }
  if (status === "failed" || status === "canceled") {
    return { to: "failed", via: "read_back", category: "outside_failed", outside };
  }
  return { category: "unknown" };
}

// The hooks a kind needs: onConfirmed always; a readBack for hooked kinds only (accounting, or
// payment with no rail), and a ready check for the rail-less payment kinds only; a destination
// for payment kinds on a rail only, and that destination whenever the kind's adapter needs one.
function hooksFit(
  kind: MoneyActionKind,
  hooks: ReconcileHooks | undefined,
  d: MoneyDeps,
): hooks is ReconcileHooks {
  if (typeof hooks !== "object" || hooks === null || typeof hooks.onConfirmed !== "function") {
    return false;
  }
  const hooked = isHooked(kind);
  if (hooked !== (typeof hooks.readBack === "function")) return false;
  const railless = hooked && KIND_SHAPES[kind].channel === "payment";
  if (railless !== (typeof hooks.ready === "function")) return false;
  if (hooked) return hooks.destination === undefined;
  return typeof hooks.destination === "function" || !needsDestination(paymentFor(kind, d));
}

// The adapter a kind is asked through, keyed so one pass asks each adapter once: per rail, once
// for accounting, and per kind for a rail-less payment kind (its own hook).
function readyKey(kind: MoneyActionKind): string {
  if (KIND_SHAPES[kind].channel === "accounting") return "accounting";
  const rail = railOf(kind);
  return rail === null ? `payment:kind:${kind}` : `payment:${rail}`;
}

// The kinds this pass can finish now: hooks that fit, the channel's switch on and its adapter
// ready (asked once per rail, once for accounting, once per rail-less payment kind). The pending read asks for these kinds
// only, so rows the pass would skip never take the places of rows it can finish.
async function servableKinds(
  db: TenantDb,
  tenantId: string,
  hooks: ReconcileOptions["hooks"] | undefined,
  d: MoneyDeps,
): Promise<MoneyActionKind[]> {
  const ready = new Map<string, boolean>();
  const kinds: MoneyActionKind[] = [];
  for (const kind of MONEY_ACTION_KINDS) {
    const { channel } = KIND_SHAPES[kind];
    if (!hooksFit(kind, hooks?.[kind], d) || !switchOn(channel)) continue;
    const key = readyKey(kind);
    let ok = ready.get(key);
    if (ok === undefined) {
      ok = (await adapterReady(db, tenantId, kind, d, hooks?.[kind]?.ready)).ok;
      ready.set(key, ok);
    }
    if (ok) kinds.push(kind);
  }
  return kinds;
}

export async function reconcileMoneyActions(
  db: TenantDb,
  session: Session,
  options: ReconcileOptions,
  deps: Partial<MoneyDeps> = {},
): Promise<ReconcileSummary> {
  if (options.ignoreCheckLimit !== undefined && typeof options.ignoreCheckLimit !== "boolean") {
    throw new RangeError("ignoreCheckLimit must be a boolean");
  }
  if (options.ignoreCheckLimit === true && options.subject === undefined) {
    throw new RangeError("the check limit is lifted only for one named subject");
  }
  // The subject whose rows may be read back past the limit, or none.
  const pastLimit = options.ignoreCheckLimit === true ? options.subject : undefined;
  const d = resolveDeps(deps);
  const limit = options.limit ?? 5;
  const olderThanSeconds = options.olderThanSeconds ?? 120;
  const tenantId = session?.tenantId;
  if (typeof tenantId !== "string") throw new RangeError("no tenant");
  const summary: ReconcileSummary = {
    checked: 0,
    confirmed: 0,
    failed: 0,
    stillUnknown: 0,
    skipped: 0,
    errors: 0,
  };

  // A person with a membership in this tenant pressed the button (or the schedule acts for one).
  const tenantZone = await db.withTenant(tenantId, async (q) => {
    await d.store.approvalFrom(q, session);
    return d.store.tenantZone(q);
  });
  const kinds = await servableKinds(db, tenantId, options.hooks, d);
  if (kinds.length === 0) return summary;
  const pending = await db.withTenant(tenantId, (q) =>
    d.store.readPending(q, olderThanSeconds, limit, kinds, options.subject, pastLimit !== undefined),
  );

  for (const action of pending) {
    const { channel } = KIND_SHAPES[action.kind];
    const hooks = options.hooks?.[action.kind];
    // Asked again per row: a switch or an adapter can change during the pass.
    if (
      !hooksFit(action.kind, hooks, d) ||
      !switchOn(channel) ||
      !(await adapterReady(db, tenantId, action.kind, d, hooks.ready)).ok
    ) {
      summary.skipped += 1;
      continue;
    }
    summary.checked += 1;
    const ctx: SendContext = { requestId: action.requestId, timeoutMs: d.timeoutMs, tenantZone };
    const rb = await readBackOf(db, tenantId, action, hooks, ctx, d);
    const s = "found" in rb ? settlementOf(action, rb, d) : rb;
    try {
      const state = await db.withTenant(tenantId, async (q) => {
        if (!("to" in s)) {
          return (await d.store.bumpCheck(q, action.id, s.category, pastLimit)) ? "unknown" : "moved";
        }
        if (!(await d.store.settle(q, action.id, s, pastLimit))) return "moved";
        const after = await d.store.readAction(q, action.id);
        if (after.state === "confirmed") await hooks.onConfirmed(q, after);
        if (after.state === "failed" && hooks.onFailed) await hooks.onFailed(q, after);
        return after.state;
      });
      if (state === "confirmed") summary.confirmed += 1;
      else if (state === "failed") summary.failed += 1;
      else if (state === "unknown") summary.stillUnknown += 1;
      else summary.skipped += 1;
      d.log(`money: checked ${action.id} ${state}`);
    } catch (err) {
      // A hook or the database failed and the settle rolled back. Count a check anyway, so a row
      // that always fails reaches the limit and a person instead of coming back forever.
      summary.errors += 1;
      d.log(`money: check of ${action.id} did not commit (${categoryOf(err)})`);
      try {
        await db.withTenant(tenantId, (q) => d.store.bumpCheck(q, action.id, "unknown", pastLimit));
      } catch {
        // The next pass finds the row as it was.
      }
    }
  }
  return summary;
}
