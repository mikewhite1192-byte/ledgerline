import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter } from "../adapters/payment/mock";
import type { PaymentAdapter, ReadBack, ReadBackStatus } from "../adapters/types";
import { executeMoneyAction, type MoneyDeps, type MoneyHooks } from "./execute";
import { requestIdOf } from "./keys";
import { reconcileMoneyActions, type ReconcileHooks } from "./reconcile";
import {
  DRIVER,
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

// A read-back that finds the payout with these fields (by default: succeeded, the whole amount).
function found(over: Partial<Extract<ReadBack, { found: true }>> = {}) {
  return async (): Promise<ReadBack> => ({
    found: true,
    system: "mock",
    type: "payout",
    id: "mock_x",
    amountCents: 25_000,
    status: "succeeded",
    ...over,
  });
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

  it("confirms a read-back that succeeded for the whole amount", async () => {
    const t = await unknownPayout(found());
    const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
    expect(s).toEqual({ checked: 1, confirmed: 1, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 });
    expect(t.ledger.row(t.id)).toMatchObject({ state: "confirmed", outsideId: "mock_x" });
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("fails as amount_mismatch when a read-back succeeded for another amount", async () => {
    const t = await unknownPayout(found({ amountCents: 2_500 }));
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

  it("fails a read-back that failed or was canceled as outside_failed, and never confirms it", async () => {
    for (const status of ["failed", "canceled"] as const) {
      const t = await unknownPayout(found({ status }));
      const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
      expect(s, status).toEqual({
        checked: 1,
        confirmed: 0,
        failed: 1,
        stillUnknown: 0,
        skipped: 0,
        errors: 0,
      });
      expect(t.ledger.row(t.id), status).toMatchObject({
        state: "failed",
        failureCategory: "outside_failed",
        settledVia: "read_back",
        outsideId: "mock_x",
        checkCount: 1,
      });
      expect(t.onConfirmed).not.toHaveBeenCalled();
      expect(t.onFailed).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps a pending or unrecognized read-back status unknown and counts a check", async () => {
    // "paid" was never in the contract; an adapter passing its processor's word through is unknown.
    for (const status of ["pending", "paid", "SUCCEEDED", "", undefined]) {
      const t = await unknownPayout(found({ status: status as ReadBackStatus }));
      const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps);
      expect(s.stillUnknown, String(status)).toBe(1);
      expect(t.ledger.row(t.id), String(status)).toMatchObject({
        state: "unknown",
        failureCategory: "unknown",
        settledVia: null,
        checkCount: 1,
      });
      expect(t.onConfirmed).not.toHaveBeenCalled();
      expect(t.onFailed).not.toHaveBeenCalled();
    }
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

  it("does not read a row whose kind has no hooks, whose adapter is not ready or whose switch is off", async () => {
    const t = await unknownPayout();
    const none = { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 };
    expect(await reconcileMoneyActions(t.db, SESSION, { hooks: {} }, t.deps)).toEqual(none);
    const notReady: Partial<MoneyDeps> = {
      ...t.deps,
      payment: { ...t.payment, ready: async () => ({ ok: false, category: "not_configured" }) },
    };
    expect(await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, notReady)).toEqual(none);
    flags.payoutsEnabled = false;
    expect(await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps)).toEqual(none);
    expect(t.ledger.pendingKinds).toEqual([]);
    expect(t.ledger.row(t.id).checkCount).toBe(0);
    expect(t.payment.readBacks).toBe(0);
  });

  it("reads only kinds it can serve, never-checked rows first, so older rows cannot block a newer one", async () => {
    const seen: string[] = [];
    const t = await unknownPayout(async (ref) => {
      seen.push(ref.requestId);
      return { found: false };
    });
    const newer = t.ledger.row(t.id);
    t.ledger.rows.delete(t.id);
    const older = "2026-11-02T14:00:00.000Z";
    const checked: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      // A row of a kind this pass has no hooks for (and whose switch is off): never read.
      const a = nextId();
      t.ledger.rows.set(a, {
        ...newer,
        id: a,
        requestId: requestIdOf(a),
        kind: "advance_expense",
        channel: "accounting",
        sentAt: older,
      });
      // An older payout already checked once that read back nothing.
      const p = nextId();
      checked.push(requestIdOf(p));
      t.ledger.rows.set(p, {
        ...newer,
        id: p,
        requestId: requestIdOf(p),
        sentAt: older,
        checkCount: 1,
        lastCheckedAt: "2026-11-02T15:00:00.000Z",
      });
    }
    // Sent last and stored last: only the order of the read can put it first.
    t.ledger.rows.set(t.id, newer);

    const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks, limit: 5 }, t.deps);
    expect(t.ledger.pendingKinds).toEqual([["advance_payout"]]);
    expect(s).toEqual({ checked: 5, confirmed: 0, failed: 0, stillUnknown: 5, skipped: 0, errors: 0 });
    expect(seen).toEqual([newer.requestId, ...checked.slice(0, 4)]);
    expect(t.ledger.row(t.id).checkCount).toBe(1);
    for (const r of t.ledger.rows.values()) {
      if (r.kind === "advance_expense") expect(r.checkCount).toBe(0);
    }
    // The next pass starts with the row the first one left out: checked rows rotate.
    await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks, limit: 5 }, t.deps);
    expect(seen[5]).toBe(checked[4]);
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

  it("checks only the named subject's rows when a subject is given", async () => {
    const t = await unknownPayout();
    const mine = t.ledger.row(t.id).subjectId;
    // Another advance's payout, left unknown the same way.
    const other = "33333333-3333-4333-8333-333333333333";
    const p = nextId();
    t.ledger.rows.set(p, { ...t.ledger.row(t.id), id: p, requestId: requestIdOf(p), subjectId: other });

    const s = await reconcileMoneyActions(
      t.db,
      SESSION,
      { hooks: t.hooks, subject: { table: "advances", id: other } },
      t.deps,
    );
    expect(s).toEqual({ checked: 1, confirmed: 1, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 });
    expect(t.ledger.row(p).state).toBe("confirmed");
    expect(t.ledger.row(t.id)).toMatchObject({ state: "unknown", checkCount: 0 });
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);

    const next = await reconcileMoneyActions(
      t.db,
      SESSION,
      { hooks: t.hooks, subject: { table: "advances", id: mine } },
      t.deps,
    );
    expect(next).toMatchObject({ checked: 1, confirmed: 1 });
    expect(t.ledger.row(t.id).state).toBe("confirmed");
  });

  it("lets a person's check of one subject read back a row at the limit, and only a definite answer moves it", async () => {
    const answers = [
      ["confirmed", found(), { confirmed: 1 }],
      ["failed", found({ status: "failed" }), { failed: 1 }],
      ["unknown", found({ status: "pending" }), { stillUnknown: 1 }],
    ] as const;
    for (const [state, readBack, counted] of answers) {
      const t = await unknownPayout(readBack);
      t.ledger.rows.set(t.id, { ...t.ledger.row(t.id), checkCount: 50 });
      const subject = { table: "advances" as const, id: t.ledger.row(t.id).subjectId };
      // Another advance's payout at the limit too, which this check must leave alone.
      const other = nextId();
      t.ledger.rows.set(other, {
        ...t.ledger.row(t.id),
        id: other,
        requestId: requestIdOf(other),
        subjectId: "55555555-5555-4555-8555-555555555555",
      });
      const sendsBefore = t.payment.sends;

      // The automatic pass keeps the limit, scoped or not.
      expect((await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks }, t.deps)).checked, state).toBe(0);
      expect((await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks, subject }, t.deps)).checked, state).toBe(0);
      expect(t.payment.readBacks, state).toBe(0);

      const s = await reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks, subject, ignoreCheckLimit: true }, t.deps);
      expect(s, state).toEqual({
        checked: 1,
        confirmed: 0,
        failed: 0,
        stillUnknown: 0,
        skipped: 0,
        errors: 0,
        ...counted,
      });
      expect(t.ledger.row(t.id), state).toMatchObject({ state, checkCount: 50 });
      expect(t.ledger.row(other), state).toMatchObject({ state: "unknown", checkCount: 50 });
      expect(t.payment.readBacks, state).toBe(1);
      // A read-back only: nothing is sent again.
      expect(t.payment.sends, state).toBe(sendsBefore);
    }
  });

  it("refuses to lift the check limit without one named subject, before reading anything", async () => {
    const t = await unknownPayout();
    t.ledger.rows.set(t.id, { ...t.ledger.row(t.id), checkCount: 50 });
    const subject = { table: "advances" as const, id: t.ledger.row(t.id).subjectId };
    await expect(
      reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks, ignoreCheckLimit: true }, t.deps),
    ).rejects.toThrow(RangeError);
    // A value from outside the type is refused too, never read as true.
    const notBoolean = "yes" as unknown as boolean;
    await expect(
      reconcileMoneyActions(t.db, SESSION, { hooks: t.hooks, subject, ignoreCheckLimit: notBoolean }, t.deps),
    ).rejects.toThrow(RangeError);
    expect(t.payment.readBacks).toBe(0);
    expect(t.ledger.row(t.id)).toMatchObject({ state: "unknown", checkCount: 50 });
  });

  it("refuses a session without a membership before reading anything", async () => {
    const t = await unknownPayout();
    await expect(
      reconcileMoneyActions(t.db, { ...SESSION, sub: "someone-else" }, { hooks: t.hooks }, t.deps),
    ).rejects.toThrow("no membership");
    expect(t.payment.readBacks).toBe(0);
  });
});

describe("reconciling a payment kind with no rail (a money code)", () => {
  const CODE = "55555555-5555-4555-8555-555555555555";

  async function unknownCode() {
    const ledger = new FakeLedger();
    ledger.subjects.set(CODE, "issuing");
    ledger.counterparties.set(CODE, DRIVER);
    const db = new FakeDb(ledger);
    const payment = recordingPayment(createMockPaymentAdapter({ log: () => {} }), ledger.events);
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
    const draft = payoutDraft({
      kind: "money_code_issue",
      subjectId: CODE,
      amountCents: 15_000,
      subjectStatuses: ["issuing", "unknown"],
    });
    const r = await executeMoneyAction(
      db,
      SESSION,
      draft,
      {
        onReserved: async () => {},
        send: async () => ({ kind: "unknown", category: "timeout" }),
        ready: async () => ({ ok: true }),
      },
      deps,
    );
    expect(r.action.state).toBe("unknown");
    const onConfirmed = vi.fn(async () => {});
    const readBack = vi.fn(
      async (): Promise<ReadBack> => ({
        found: true,
        system: "fuel_card_sim",
        type: "money_code",
        id: "fcs_code_0123456789abcdef01234567",
        amountCents: 15_000,
        status: "succeeded",
      }),
    );
    const ready = vi.fn(async () => ({ ok: true as const }));
    return { ledger, db, payment, deps, onConfirmed, readBack, ready, id: r.action.id };
  }

  it("needs its own read-back and ready hooks, never a destination, and never reads through the payment adapter", async () => {
    const t = await unknownCode();
    const none = { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 };
    const bad: ReconcileHooks[] = [
      { onConfirmed: t.onConfirmed },
      { onConfirmed: t.onConfirmed, readBack: t.readBack },
      { onConfirmed: t.onConfirmed, ready: t.ready },
      { onConfirmed: t.onConfirmed, readBack: t.readBack, ready: t.ready, destination: async () => null },
    ];
    for (const h of bad) {
      expect(await reconcileMoneyActions(t.db, SESSION, { hooks: { money_code_issue: h } }, t.deps)).toEqual(none);
    }
    expect(t.readBack).not.toHaveBeenCalled();
    const s = await reconcileMoneyActions(
      t.db,
      SESSION,
      { hooks: { money_code_issue: { onConfirmed: t.onConfirmed, readBack: t.readBack, ready: t.ready } } },
      t.deps,
    );
    expect(s).toMatchObject({ checked: 1, confirmed: 1 });
    expect(t.readBack).toHaveBeenCalledTimes(1);
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);
    expect(t.payment.readBacks).toBe(0);
    expect(t.ledger.row(t.id)).toMatchObject({ state: "confirmed", settledVia: "read_back" });
  });

  it("skips the kind when its own ready hook says not ready", async () => {
    const t = await unknownCode();
    t.ready.mockResolvedValue({ ok: false, category: "disabled" } as never);
    const s = await reconcileMoneyActions(
      t.db,
      SESSION,
      { hooks: { money_code_issue: { onConfirmed: t.onConfirmed, readBack: t.readBack, ready: t.ready } } },
      t.deps,
    );
    expect(s).toMatchObject({ checked: 0, confirmed: 0 });
    expect(t.readBack).not.toHaveBeenCalled();
  });
});
