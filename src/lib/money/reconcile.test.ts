import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter } from "../adapters/payment/mock";
import type { PaymentAdapter, ReadBack } from "../adapters/types";
import { executeMoneyAction, type MoneyDeps, type MoneyHooks } from "./execute";
import { reconcileMoneyActions, type ReconcileHooks } from "./reconcile";
import {
  FakeDb,
  FakeLedger,
  nextId,
  payoutDraft,
  recordingPayment,
  SESSION,
} from "./test-fakes";
import { MoneyError } from "./types";

const saved = { ...flags };

beforeEach(() => {
  flags.payoutsEnabled = true;
  flags.paymentProvider = "mock";
});

afterEach(() => {
  Object.assign(flags, saved);
});

// A ledger holding one payout left unknown by a send that hung.
async function unknownPayout(readBack?: PaymentAdapter["readBack"]) {
  const ledger = new FakeLedger();
  const db = new FakeDb(ledger);
  const mock = createMockPaymentAdapter({ log: () => {} });
  const inner: PaymentAdapter = readBack
    ? { system: "mock", ready: () => mock.ready(), sendPayout: mock.sendPayout, readBack }
    : mock;
  const payment = recordingPayment(inner, ledger.events);
  const deps: Partial<MoneyDeps> = {
    store: ledger.store,
    payment,
    timeoutMs: 5,
    waitMs: 0,
    pollMs: 1,
    sleep: async () => {},
    log: () => {},
    newActionId: nextId,
  };
  const execHooks: MoneyHooks = { onReserved: async () => {} };
  mock.hangNext();
  const r = await executeMoneyAction(db, SESSION, payoutDraft(), execHooks, deps);
  expect(r.action.state).toBe("unknown");
  const onConfirmed = vi.fn(async () => {});
  const onFailed = vi.fn(async () => {});
  const hooks: Record<string, ReconcileHooks> = { advance_payout: { onConfirmed, onFailed } };
  return { ledger, db, mock, payment, deps, hooks, onConfirmed, onFailed, id: r.action.id };
}

describe("reconcileMoneyActions", () => {
  it("confirms by read-back when the whole amount is found, and runs onConfirmed once", async () => {
    const t = await unknownPayout();
    const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
    expect(s).toEqual({ checked: 1, confirmed: 1, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 });
    const row = t.ledger.row(t.id);
    expect(row.state).toBe("confirmed");
    expect(row.settledVia).toBe("read_back");
    expect(row.checkCount).toBe(1);
    expect(row.failureCategory).toBeNull();
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);
    // The read-back replayed the one payout; nothing was sent again.
    expect(t.payment.sends).toBe(1);
    expect(t.mock.createdCount).toBe(1);
    const again = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
    expect(again.checked).toBe(0);
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("fails as amount_mismatch when another amount is found", async () => {
    const t = await unknownPayout(
      async (): Promise<ReadBack> => ({
        found: true,
        system: "mock",
        type: "payout",
        id: "mock_x",
        amountCents: 2_500,
        status: "paid",
      }),
    );
    const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
    expect(s.failed).toBe(1);
    const row = t.ledger.row(t.id);
    expect(row.state).toBe("failed");
    expect(row.failureCategory).toBe("amount_mismatch");
    expect(row.settledVia).toBe("read_back");
    expect(row.outsideAmountCents).toBe(2_500);
    expect(t.onConfirmed).not.toHaveBeenCalled();
    expect(t.onFailed).toHaveBeenCalledTimes(1);
  });

  it("keeps the row unknown and counts a check when the read-back throws, finds nothing or hangs", async () => {
    const answers: (() => Promise<ReadBack>)[] = [
      async () => {
        throw new MoneyError("unavailable");
      },
      async () => ({ found: false }),
      () => new Promise<ReadBack>(() => {}),
    ];
    let i = 0;
    const t = await unknownPayout(() => answers[i++]());
    for (const expected of ["unavailable", "unknown", "timeout"]) {
      const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
      expect(s.stillUnknown).toBe(1);
      expect(t.ledger.row(t.id).failureCategory).toBe(expected);
    }
    expect(t.ledger.row(t.id).state).toBe("unknown");
    expect(t.ledger.row(t.id).checkCount).toBe(3);
  });

  it("stops at 50 checks: the row needs a person and the pass skips it", async () => {
    const t = await unknownPayout(async () => {
      throw new MoneyError("network");
    });
    t.ledger.rows.set(t.id, { ...t.ledger.row(t.id), checkCount: 49 });
    const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
    expect(s.stillUnknown).toBe(1);
    expect(t.ledger.row(t.id).checkCount).toBe(50);
    const after = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
    expect(after).toEqual({ checked: 0, confirmed: 0, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 });
    expect(t.payment.readBacks).toBe(1);
  });

  it("picks up a sent row only after the window", async () => {
    const t = await unknownPayout();
    t.ledger.rows.set(t.id, { ...t.ledger.row(t.id), state: "sent", failureCategory: null });
    t.ledger.sentAgeSeconds = 60;
    expect((await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps)).checked).toBe(0);
    t.ledger.sentAgeSeconds = 121;
    const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
    expect(s.confirmed).toBe(1);
  });

  it("skips a row whose switch is off or whose kind has no hooks, and counts nothing", async () => {
    const t = await unknownPayout();
    expect((await reconcileMoneyActions(t.db, SESSION, { hooks: {} }, t.deps)).skipped).toBe(1);
    flags.payoutsEnabled = false;
    expect((await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps)).skipped).toBe(1);
    expect(t.ledger.row(t.id).checkCount).toBe(0);
    expect(t.payment.readBacks).toBe(0);
  });

  it("rolls back a confirm whose onConfirmed throws, and counts a check so it cannot loop forever", async () => {
    const t = await unknownPayout();
    t.onConfirmed.mockRejectedValueOnce(new Error("follow-up failed"));
    const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
    expect(s.errors).toBe(1);
    expect(t.ledger.row(t.id).state).toBe("unknown");
    expect(t.ledger.row(t.id).checkCount).toBe(1);
    const next = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
    expect(next.confirmed).toBe(1);
    expect(t.ledger.row(t.id).checkCount).toBe(2);
  });

  it("refuses a session without a membership before reading anything", async () => {
    const t = await unknownPayout();
    await expect(
      reconcileMoneyActions(t.db, { ...SESSION, sub: "someone-else" }, { hooks: t.hooks }, t.deps),
    ).rejects.toThrow("no membership");
    expect(t.payment.readBacks).toBe(0);
  });
});
