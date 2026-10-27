import { randomUUID } from "node:crypto";
import { accountingAdapter, paymentAdapter } from "../adapters";
import {
  UNKNOWN_CATEGORIES,
  type AccountingAdapter,
  type PaymentAdapter,
  type Ready,
  type SendContext,
  type SendOutcome,
  type UnknownCategory,
} from "../adapters/types";
import type { Session } from "../auth/claims";
import type { Queryable, TenantDb } from "../db";
import { approvalFrom } from "./approval";
import { memoCodeOf } from "./keys";
import {
  bumpCheck,
  isOutsideRecord,
  markSent,
  mustReadAction,
  reserve,
  settle,
  switchOn,
  validateDraft,
  type OutsideRecord,
  type Settlement,
} from "./ledger";
import { readPending, readTenantZone } from "./read";
import {
  KIND_SHAPES,
  MoneyError,
  isMoneyFailure,
  type MoneyAction,
  type MoneyChannel,
  type MoneyDraft,
  type MoneyFailure,
  type OutsideSystem,
} from "./types";

// The only way money leaves the app. A person's approval reserves a ledger row in the same
// transaction as the caller's own write; the outside call happens after that commits, with the
// row's request id, once, with no retry; the outcome settles the row. Anything nobody confirmed
// (a timeout, a network error, a reply without an id, a commit that may not have landed) stays
// sent or unknown until a read-back settles it (reconcile.ts). Agent code cannot import this file
// (eslint.config.mjs): the agent proposes, a person approves, this executes.

export type MoneyHooks = {
  // The caller's domain write in the approval transaction (an advance to approved, say). It must
  // change its row or throw; a throw rolls the ledger row back with it. Runs for a new row only.
  onReserved(q: Queryable, action: MoneyAction): Promise<void>;
  // In the settle transaction. A throw rolls the settle back and the row stays sent for the
  // reconcile pass, which runs the same hook when it confirms.
  onConfirmed?(q: Queryable, action: MoneyAction): Promise<void>;
  onFailed?(q: Queryable, action: MoneyAction): Promise<void>;
  // Accounting kinds only: the one outside call for this action. Payouts go through the payment
  // adapter and must not pass this.
  send?(action: MoneyAction, ctx: SendContext): Promise<SendOutcome>;
};

// The ledger functions the executor and the reconcile pass use; tests swap in a fake.
export type LedgerStore = {
  approvalFrom: typeof approvalFrom;
  tenantZone: typeof readTenantZone;
  reserve: typeof reserve;
  markSent: typeof markSent;
  settle: typeof settle;
  bumpCheck: typeof bumpCheck;
  readAction: typeof mustReadAction;
  readPending: typeof readPending;
};

export const dbLedgerStore: LedgerStore = {
  approvalFrom,
  tenantZone: readTenantZone,
  reserve,
  markSent,
  settle,
  bumpCheck,
  readAction: mustReadAction,
  readPending,
};

export type MoneyDeps = {
  store: LedgerStore;
  payment: PaymentAdapter;
  accounting: AccountingAdapter;
  // The outside call's limit; past it the outcome is unknown.
  timeoutMs: number;
  // A caller that finds the row being sent by another waits this long for it, polling (sleep
  // time; each poll's read adds its own). Kept short so a waiting request stays inside the
  // server-render budget; a row still sent after it is returned as sent, and the reconcile pass
  // finishes it.
  waitMs: number;
  pollMs: number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  newActionId(): string;
};

export function resolveDeps(p: Partial<MoneyDeps> = {}): MoneyDeps {
  const d: MoneyDeps = {
    store: p.store ?? dbLedgerStore,
    payment: p.payment ?? paymentAdapter(),
    accounting: p.accounting ?? accountingAdapter(),
    timeoutMs: p.timeoutMs ?? 20_000,
    waitMs: p.waitMs ?? 8_000,
    pollMs: p.pollMs ?? 250,
    sleep: p.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    log: p.log ?? ((line) => console.info(line)),
    newActionId: p.newActionId ?? randomUUID,
  };
  const whole = (n: number, min: number) => Number.isSafeInteger(n) && n >= min;
  if (!whole(d.timeoutMs, 1) || !whole(d.waitMs, 0) || !whole(d.pollMs, 1)) {
    throw new RangeError("timeouts must be whole milliseconds");
  }
  return d;
}

export type ExecuteResult = {
  action: MoneyAction;
  // false: an earlier approval made this row and this call replayed it.
  created: boolean;
  // true only for the one call that made the outside request.
  sent: boolean;
};

// Resolves to onTimeout() if work has not settled within ms. A synchronous throw in work becomes
// a rejection. The timer is always cleared.
export async function withTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isUnknownCategory(c: unknown): c is UnknownCategory {
  return (UNKNOWN_CATEGORIES as readonly unknown[]).includes(c);
}

// A thrown error's category for a log line or a check bump; never its message.
export function categoryOf(err: unknown): MoneyFailure {
  return err instanceof MoneyError ? err.category : "unknown";
}

// The categories that mean the outside system definitely did nothing. Only these settle a sent
// row as failed (which frees the subject for a retry); anything else an adapter reports as a
// failure is recorded as unknown, because a wrong "failed" could pay twice.
const DEFINITE_FAILURES: readonly MoneyFailure[] = [
  "disabled",
  "not_connected",
  "not_configured",
  "validation",
  "auth",
  "rate_limited",
];

export function systemFor(channel: MoneyChannel, d: MoneyDeps): OutsideSystem {
  return channel === "payment" ? d.payment.system : d.accounting.system;
}

// What an adapter's answer means for the row, checked whole. A confirmation needs a usable id,
// the expected system and the approved amount; a different amount is a failure a person looks at.
export function settlementFor(
  outcome: unknown,
  action: MoneyAction,
  system: OutsideSystem,
): Settlement {
  if (typeof outcome !== "object" || outcome === null) return { to: "unknown", category: "unknown" };
  const o = outcome as Record<string, unknown>;
  if (o.kind === "confirmed") {
    const outside = {
      system: o.system,
      type: o.type,
      id: o.id,
      ref: o.ref ?? null,
      amountCents: o.amountCents,
    };
    if (!isOutsideRecord(outside) || outside.system !== system) {
      return { to: "unknown", category: "unknown" };
    }
    if (outside.amountCents !== action.amountCents) {
      return { to: "failed", via: "response", category: "amount_mismatch", outside };
    }
    return { to: "confirmed", via: "response", outside };
  }
  if (o.kind === "failed" && isMoneyFailure(o.category) && DEFINITE_FAILURES.includes(o.category)) {
    return { to: "failed", via: "response", category: o.category };
  }
  if (o.kind === "unknown" && isUnknownCategory(o.category)) {
    return { to: "unknown", category: o.category };
  }
  return { to: "unknown", category: "unknown" };
}

// The channel's adapter, asked again. A throw is "not ready", never "ready".
export async function adapterReady(
  db: TenantDb,
  tenantId: string,
  channel: MoneyChannel,
  d: MoneyDeps,
): Promise<Ready> {
  try {
    const r =
      channel === "payment"
        ? await d.payment.ready()
        : await db.withTenant(tenantId, (q) => d.accounting.ready(q));
    if (r?.ok === true) return { ok: true };
    return { ok: false, category: isMoneyFailure(r?.category) ? r.category : "unknown" };
  } catch (err) {
    return { ok: false, category: err instanceof MoneyError ? err.category : "unavailable" };
  }
}

export function payoutOf(action: MoneyAction) {
  return {
    actionId: action.id,
    driverId: action.counterpartyId,
    amountCents: action.amountCents,
    memoCode: memoCodeOf(action),
  };
}

async function readNow(db: TenantDb, tenantId: string, id: string, d: MoneyDeps) {
  return db.withTenant(tenantId, (q) => d.store.readAction(q, id));
}

// Another caller holds the send: wait for it to settle, bounded, then report the row as it
// stands (possibly still sent; the reconcile pass finishes it).
async function waitForSettle(
  db: TenantDb,
  tenantId: string,
  id: string,
  d: MoneyDeps,
): Promise<MoneyAction> {
  let waited = 0;
  for (;;) {
    const a = await readNow(db, tenantId, id, d);
    if ((a.state !== "sent" && a.state !== "reserved") || waited >= d.waitMs) return a;
    await d.sleep(d.pollMs);
    waited += d.pollMs;
  }
}

const stateLine = (a: MoneyAction) =>
  a.state === "failed" || a.state === "unknown"
    ? `${a.state} ${a.failureCategory ?? "unknown"}`
    : a.state;

export async function executeMoneyAction(
  db: TenantDb,
  session: Session,
  draft: MoneyDraft,
  hooks: MoneyHooks,
  deps: Partial<MoneyDeps> = {},
): Promise<ExecuteResult> {
  const d = resolveDeps(deps);
  const clean = validateDraft(draft);
  const { channel, subjectTable } = KIND_SHAPES[clean.kind];
  // The checked copy, so a caller's object changing later cannot change what is reserved.
  const asDraft: MoneyDraft = { ...clean, subjectStatuses: clean.subjectStatuses ?? undefined };
  if (typeof hooks?.onReserved !== "function") throw new MoneyError("validation");
  if ((channel === "accounting") !== (typeof hooks.send === "function")) {
    throw new MoneyError("validation");
  }
  const tenantId = session?.tenantId;
  if (typeof tenantId !== "string") throw new MoneyError("validation");

  // The switch and the adapter before anything is written.
  if (!switchOn(channel)) {
    const via = systemFor(channel, d);
    const flag = channel === "payment" ? "payoutsEnabled" : "accountingEnabled";
    d.log(
      `money: would send ${clean.kind} ${clean.amountCents}c for ${subjectTable} ` +
        `${clean.subjectId} via ${via} (${flag} off)`,
    );
    throw new MoneyError("disabled");
  }
  const before = await adapterReady(db, tenantId, channel, d);
  if (!before.ok) throw new MoneyError(before.category);

  // (1) Approve and reserve, with the caller's own write, in one transaction.
  const first = await db.withTenant(tenantId, async (q) => {
    const approval = await d.store.approvalFrom(q, session);
    const tenantZone = await d.store.tenantZone(q);
    const r = await d.store.reserve(q, approval, asDraft, d.newActionId());
    if (r.created) await hooks.onReserved(q, r.action);
    return { ...r, tenantZone };
  });
  const created = first.created;
  let action = first.action;
  d.log(`money: ${created ? "reserved" : "replayed"} ${action.id} ${action.kind} ${stateLine(action)}`);
  if (action.state === "sent") action = await waitForSettle(db, tenantId, action.id, d);
  if (action.state !== "reserved") return { action, created, sent: false };

  // (2) The switch and the adapter again, outside any transaction. A refusal settles the row.
  const now: Ready = switchOn(channel)
    ? await adapterReady(db, tenantId, channel, d)
    : { ok: false, category: "disabled" };
  if (!now.ok) {
    const refused = await db.withTenant(tenantId, async (q) => {
      const s: Settlement = { to: "failed", via: "refused", category: now.category };
      if (!(await d.store.settle(q, action.id, s))) return null;
      const after = await d.store.readAction(q, action.id);
      if (hooks.onFailed) await hooks.onFailed(q, after);
      return after;
    });
    if (!refused) {
      return { action: await waitForSettle(db, tenantId, action.id, d), created, sent: false };
    }
    d.log(`money: refused ${refused.id} ${stateLine(refused)}`);
    return { action: refused, created, sent: false };
  }

  // (3) Claim the send. Losing the claim means another caller is sending it.
  const claimed = await db.withTenant(tenantId, async (q) =>
    (await d.store.markSent(q, action.id)) ? d.store.readAction(q, action.id) : null,
  );
  if (!claimed) {
    return { action: await waitForSettle(db, tenantId, action.id, d), created, sent: false };
  }
  action = claimed;

  // (4) The one outside call, with the row's request id and a time limit. No retry.
  const ctx: SendContext = {
    requestId: action.requestId,
    timeoutMs: d.timeoutMs,
    tenantZone: first.tenantZone,
  };
  const sending = action;
  // The payment adapter checks its switch itself on every call. The accounting send is the
  // caller's hook, so its switch is checked here, at the write: off means a definite disabled
  // answer and no call.
  const work =
    channel === "payment"
      ? () => d.payment.sendPayout(payoutOf(sending), ctx)
      : async (): Promise<SendOutcome> => {
          if (!switchOn("accounting")) return { kind: "failed", category: "disabled" };
          return (hooks.send as NonNullable<MoneyHooks["send"]>)(sending, ctx);
        };
  d.log(`money: sending ${action.id} ${action.kind} ${action.amountCents}c`);
  let outcome: unknown;
  try {
    outcome = await withTimeout<unknown>(work, d.timeoutMs, () => ({
      kind: "unknown",
      category: "timeout",
    }));
  } catch (err) {
    const c = categoryOf(err);
    outcome = { kind: "unknown", category: isUnknownCategory(c) ? c : "unknown" };
  }
  const s = settlementFor(outcome, action, systemFor(channel, d));

  // (5) Settle, and the caller's follow-up write, in one transaction.
  try {
    const done = await db.withTenant(tenantId, async (q) => {
      if (!(await d.store.settle(q, sending.id, s))) return null;
      const after = await d.store.readAction(q, sending.id);
      if (after.state === "confirmed" && hooks.onConfirmed) await hooks.onConfirmed(q, after);
      if (after.state === "failed" && hooks.onFailed) await hooks.onFailed(q, after);
      return after;
    });
    if (done) {
      d.log(`money: settled ${done.id} ${stateLine(done)}`);
      return { action: done, created, sent: true };
    }
  } catch (err) {
    d.log(`money: settle of ${sending.id} did not commit (${categoryOf(err)}); left for a check`);
  }
  // The settle moved nothing or may not have landed: report the row as stored. If even that
  // read fails, the outcome is unknown, never assumed.
  try {
    return { action: await readNow(db, tenantId, sending.id, d), created, sent: true };
  } catch {
    throw new MoneyError("unknown");
  }
}

export type { OutsideRecord };
