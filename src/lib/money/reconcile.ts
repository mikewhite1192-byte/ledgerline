import type { ReadBack, SendContext } from "../adapters/types";
import type { Session } from "../auth/claims";
import type { Queryable, TenantDb } from "../db";
import {
  adapterReady,
  categoryOf,
  payoutOf,
  resolveDeps,
  systemFor,
  withTimeout,
  type MoneyDeps,
} from "./execute";
import { isOutsideRecord, switchOn, type Settlement } from "./ledger";
import {
  KIND_SHAPES,
  MONEY_ACTION_KINDS,
  type MoneyAction,
  type MoneyActionKind,
  type MoneyChannel,
  type MoneyFailure,
} from "./types";

// Finishes what a send left open: rows unknown, and rows still sent after the window (their
// sender died or its settle did not commit). Each is read back from the outside system by its
// request id. Found succeeded for the whole approved amount: confirmed by read-back, plus the
// same follow-up write the executor would have made. Succeeded for another amount: failed as
// amount_mismatch, for a person. Found failed or canceled: failed as outside_failed (no money
// moved; a person may retry). Still pending, a status outside the contract, nothing found, an
// error or a timeout: still unknown, one more check counted; at the check limit the row needs a
// person and the pass skips it. Never sends anything new. Agent code cannot import this file
// (eslint.config.mjs).

export type ReconcileHooks = {
  // The follow-up write a confirmed action needs (an advance to paid, say). Required: a row is
  // never confirmed without it.
  onConfirmed(q: Queryable, action: MoneyAction): Promise<void>;
  onFailed?(q: Queryable, action: MoneyAction): Promise<void>;
  // Accounting kinds only: the read-back for this action. Payouts read back through the payment
  // adapter and must not pass this.
  readBack?(action: MoneyAction, ctx: SendContext): Promise<ReadBack>;
};

export type ReconcileOptions = {
  limit?: number;
  olderThanSeconds?: number;
  // A kind without hooks is not read, never guessed at.
  hooks: Partial<Record<MoneyActionKind, ReconcileHooks>>;
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
  action: MoneyAction,
  hooks: ReconcileHooks,
  ctx: SendContext,
  d: MoneyDeps,
): Promise<Found | { category: MoneyFailure }> {
  const { channel } = KIND_SHAPES[action.kind];
  const work =
    channel === "payment"
      ? () =>
          d.payment.readBack(
            { requestId: action.requestId, outsideId: action.outsideId, payout: payoutOf(action) },
            ctx,
          )
      : () => (hooks.readBack as NonNullable<ReconcileHooks["readBack"]>)(action, ctx);
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
  const expected = systemFor(KIND_SHAPES[action.kind].channel, d);
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

// The hooks a kind needs: onConfirmed always, and a readBack for accounting kinds only.
function hooksFit(kind: MoneyActionKind, hooks: ReconcileHooks | undefined): hooks is ReconcileHooks {
  return (
    typeof hooks === "object" &&
    hooks !== null &&
    typeof hooks.onConfirmed === "function" &&
    (KIND_SHAPES[kind].channel === "accounting") === (typeof hooks.readBack === "function")
  );
}

// The kinds this pass can finish now: hooks that fit, the channel's switch on and its adapter
// ready (asked once per channel). The pending read asks for these kinds only, so rows the pass
// would skip never take the places of rows it can finish.
async function servableKinds(
  db: TenantDb,
  tenantId: string,
  hooks: ReconcileOptions["hooks"] | undefined,
  d: MoneyDeps,
): Promise<MoneyActionKind[]> {
  const ready = new Map<MoneyChannel, boolean>();
  const kinds: MoneyActionKind[] = [];
  for (const kind of MONEY_ACTION_KINDS) {
    const { channel } = KIND_SHAPES[kind];
    if (!hooksFit(kind, hooks?.[kind]) || !switchOn(channel)) continue;
    let ok = ready.get(channel);
    if (ok === undefined) {
      ok = (await adapterReady(db, tenantId, channel, d)).ok;
      ready.set(channel, ok);
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
    d.store.readPending(q, olderThanSeconds, limit, kinds),
  );

  for (const action of pending) {
    const { channel } = KIND_SHAPES[action.kind];
    const hooks = options.hooks?.[action.kind];
    // Asked again per row: a switch or an adapter can change during the pass.
    if (
      !hooksFit(action.kind, hooks) ||
      !switchOn(channel) ||
      !(await adapterReady(db, tenantId, channel, d)).ok
    ) {
      summary.skipped += 1;
      continue;
    }
    summary.checked += 1;
    const ctx: SendContext = { requestId: action.requestId, timeoutMs: d.timeoutMs, tenantZone };
    const rb = await readBackOf(action, hooks, ctx, d);
    const s = "found" in rb ? settlementOf(action, rb, d) : rb;
    try {
      const state = await db.withTenant(tenantId, async (q) => {
        if (!("to" in s)) {
          return (await d.store.bumpCheck(q, action.id, s.category)) ? "unknown" : "moved";
        }
        if (!(await d.store.settle(q, action.id, s))) return "moved";
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
        await db.withTenant(tenantId, (q) => d.store.bumpCheck(q, action.id, "unknown"));
      } catch {
        // The next pass finds the row as it was.
      }
    }
  }
  return summary;
}
