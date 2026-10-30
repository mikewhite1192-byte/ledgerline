import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter, type MockPaymentAdapter } from "../adapters/payment/mock";
import type { PaymentAdapter, PayoutRequest, SendContext } from "../adapters/types";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable } from "../db/types";
import { ForbiddenError } from "../tenant/context";
import { executeMoneyAction, type MoneyDeps, type MoneyHooks } from "./execute";
import { readBySubject } from "./read";
import { reconcileMoneyActions } from "./reconcile";
import { addAdvance, addJudge, clearLedger, dropTenant, makeTenant, type Fixture } from "./test-db";
import type { MoneyAction, MoneyDraft } from "./types";

// The executor against the real database and trigger: two approvals of one advance at the same
// moment, from two separate connection pools, send exactly once (probe P3, ten rounds), and a
// send that hangs is settled later by the reconcile pass without a second send.

const saved = { ...flags };
let admin: Db;
let first: Db;
let second: Db;
let A: Fixture;

// One write per hook, on this advance only; anything else throws and rolls the step back.
async function one(q: Queryable, sql: string, id: string): Promise<void> {
  const n = await q.execute(sql, [id]);
  if (n !== 1) throw new Error(`expected one advance row, changed ${n}`);
}

const hooks: MoneyHooks = {
  onReserved: (q, a) =>
    one(
      q,
      `UPDATE advances SET status = 'approved'
       WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'requested'`,
      a.subjectId,
    ),
  onConfirmed: (q, a) =>
    one(
      q,
      `UPDATE advances SET status = 'paid', paid_at = now()
       WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      a.subjectId,
    ),
};

function draft(advance: string): MoneyDraft {
  return {
    kind: "advance_payout",
    subjectId: advance,
    counterpartyId: A.driverId,
    amountCents: 25_000,
    proposedBy: "agent",
    subjectStatuses: ["requested"],
  };
}

// Counts sends across both callers; the send yields first so the other caller can race it.
function counting(mock: MockPaymentAdapter): PaymentAdapter & { sends: number; readBacks: number } {
  const out = {
    system: mock.system,
    sends: 0,
    readBacks: 0,
    ready: () => mock.ready(),
    async sendPayout(p: PayoutRequest, ctx: SendContext) {
      out.sends += 1;
      await new Promise((r) => setTimeout(r, 5));
      return mock.sendPayout(p, ctx);
    },
    async readBack(ref: Parameters<PaymentAdapter["readBack"]>[0], ctx: SendContext) {
      out.readBacks += 1;
      return mock.readBack(ref, ctx);
    },
  };
  return out;
}

function depsFor(payment: PaymentAdapter, over: Partial<MoneyDeps> = {}): Partial<MoneyDeps> {
  return { payment, waitMs: 5_000, pollMs: 10, log: () => {}, ...over };
}

async function advanceRow(id: string) {
  const rows = await admin.withTenant(A.tenantId, (q) =>
    q.query<{ status: string; paid: boolean }>(
      `SELECT status, paid_at IS NOT NULL AS paid FROM advances
       WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    ),
  );
  return rows[0];
}

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  first = createPgDb({ connectionString: appUrl(), max: 2 });
  second = createPgDb({ connectionString: appUrl(), max: 2 });
  A = await makeTenant(admin, `exec-${randomUUID().slice(0, 8)}`);
});

beforeEach(() => {
  flags.payoutsEnabled = true;
  flags.paymentProvider = "mock";
});

afterEach(async () => {
  Object.assign(flags, saved);
  await clearLedger(admin, A);
});

afterAll(async () => {
  Object.assign(flags, saved);
  await dropTenant(admin, A);
  await second?.close();
  await first?.close();
  await admin?.close();
});

describe("two approvals of one advance at the same moment", () => {
  it("reserve once, send once, and both callers get the same action and outcome (ten rounds)", async () => {
    for (let round = 1; round <= 10; round += 1) {
      const advance = await addAdvance(admin, A);
      const mock = createMockPaymentAdapter({ log: () => {} });
      const payment = counting(mock);
      const deps = depsFor(payment);
      const [x, y] = await Promise.all([
        executeMoneyAction(first, A.session, draft(advance), hooks, deps),
        executeMoneyAction(second, A.session, draft(advance), hooks, deps),
      ]);

      const rows: MoneyAction[] = await first.withTenant(A.tenantId, (q) =>
        readBySubject(q, "advances", advance),
      );
      expect(rows, `round ${round}`).toHaveLength(1);
      // The dedupe key both callers met: advance_payout:<advance id>:1.
      expect(rows[0].idempotencyKey).toBe(`advance_payout:${advance}:1`);
      expect(rows[0].state, `round ${round}`).toBe("confirmed");
      expect(payment.sends, `round ${round}`).toBe(1);
      expect(mock.createdCount, `round ${round}`).toBe(1);
      expect(x.action.id).toBe(rows[0].id);
      expect(y.action.id).toBe(rows[0].id);
      expect([x.action.state, y.action.state]).toEqual(["confirmed", "confirmed"]);
      expect(x.action.outsideId).toBe(y.action.outsideId);
      expect([x.created, y.created].filter(Boolean)).toHaveLength(1);
      expect([x.sent, y.sent].filter(Boolean)).toHaveLength(1);
      expect(await advanceRow(advance)).toEqual({ status: "paid", paid: true });
    }
  });
});

describe("a send that hangs", () => {
  it("leaves the row unknown, and the reconcile pass confirms it by read-back with no second send", async () => {
    const advance = await addAdvance(admin, A);
    const mock = createMockPaymentAdapter({ log: () => {} });
    const payment = counting(mock);
    mock.hangNext();
    const r = await executeMoneyAction(
      first,
      A.session,
      draft(advance),
      hooks,
      depsFor(payment, { timeoutMs: 50 }),
    );
    expect(r.action.state).toBe("unknown");
    expect(r.action.failureCategory).toBe("timeout");
    expect(r.sent).toBe(true);
    expect(await advanceRow(advance)).toEqual({ status: "approved", paid: false });

    // A second approval of the same advance replays the unknown row; it sends nothing.
    const again = await executeMoneyAction(second, A.session, draft(advance), hooks, depsFor(payment));
    expect(again).toMatchObject({ created: false, sent: false });
    expect(again.action.id).toBe(r.action.id);

    const summary = await reconcileMoneyActions(
      second,
      A.session,
      { hooks: { advance_payout: { onConfirmed: hooks.onConfirmed! } } },
      depsFor(payment),
    );
    expect(summary).toEqual({
      checked: 1,
      confirmed: 1,
      failed: 0,
      stillUnknown: 0,
      skipped: 0,
      errors: 0,
    });
    const rows = await first.withTenant(A.tenantId, (q) => readBySubject(q, "advances", advance));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "confirmed", settledVia: "read_back", checkCount: 1 });
    expect(payment.sends).toBe(1);
    expect(payment.readBacks).toBe(1);
    expect(mock.createdCount).toBe(1);
    expect(await advanceRow(advance)).toEqual({ status: "paid", paid: true });
  });

  it("writes nothing and sends nothing while the switch is off", async () => {
    const advance = await addAdvance(admin, A);
    const mock = createMockPaymentAdapter({ log: () => {} });
    const payment = counting(mock);
    const lines: string[] = [];
    flags.payoutsEnabled = false;
    await expect(
      executeMoneyAction(first, A.session, draft(advance), hooks, depsFor(payment, {
        log: (l) => lines.push(l),
      })),
    ).rejects.toMatchObject({ category: "disabled" });
    expect(lines).toEqual([
      `money: would send advance_payout 25000c for advances ${advance} via fuel_card mock (payoutsEnabled off)`,
    ]);
    const rows = await first.withTenant(A.tenantId, (q) => readBySubject(q, "advances", advance));
    expect(rows).toEqual([]);
    expect(payment.sends).toBe(0);
    expect(await advanceRow(advance)).toEqual({ status: "requested", paid: false });
  });
});

describe("a demo visitor's login (the judge role)", () => {
  it("is refused before the ledger row: no row, no send, the advance untouched", async () => {
    const judge = await addJudge(admin, A);
    const advance = await addAdvance(admin, A);
    const mock = createMockPaymentAdapter({ log: () => {} });
    const payment = counting(mock);
    const err = await executeMoneyAction(first, judge, draft(advance), hooks, depsFor(payment)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(await first.withTenant(A.tenantId, (q) => readBySubject(q, "advances", advance))).toEqual([]);
    expect(payment.sends).toBe(0);
    expect(await advanceRow(advance)).toEqual({ status: "requested", paid: false });

    // An unknown row a staff approval left: the visitor's reconcile pass is refused before any read-back.
    mock.hangNext();
    const staff = await executeMoneyAction(first, A.session, draft(advance), hooks, depsFor(payment, { timeoutMs: 50 }));
    expect(staff.action.state).toBe("unknown");
    const refused = await reconcileMoneyActions(
      second,
      judge,
      { hooks: { advance_payout: { onConfirmed: hooks.onConfirmed! } } },
      depsFor(payment),
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(payment.readBacks).toBe(0);
    const rows = await first.withTenant(A.tenantId, (q) => readBySubject(q, "advances", advance));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "unknown", checkCount: 0 });
    expect(payment.sends).toBe(1);
  });
});
