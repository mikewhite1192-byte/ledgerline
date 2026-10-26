import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter } from "../adapters/payment/mock";
import type { PaymentAdapter, SendOutcome } from "../adapters/types";
import { executeMoneyAction, settlementFor, type MoneyDeps, type MoneyHooks } from "./execute";
import {
  FakeDb,
  FakeLedger,
  nextId,
  payoutDraft,
  recordingPayment,
  SESSION,
  steps,
} from "./test-fakes";
import { MoneyError, type MoneyAction } from "./types";

const saved = { ...flags };

function setup(inner?: PaymentAdapter) {
  const ledger = new FakeLedger();
  const db = new FakeDb(ledger);
  const lines: string[] = [];
  const mock = createMockPaymentAdapter({ log: (l) => lines.push(l) });
  const payment = recordingPayment(inner ?? mock, ledger.events);
  const deps: Partial<MoneyDeps> = {
    store: ledger.store,
    payment,
    timeoutMs: 1_000,
    waitMs: 0,
    pollMs: 1,
    sleep: async () => {},
    log: (l) => lines.push(l),
    newActionId: nextId,
  };
  const onConfirmed = vi.fn(async (q, a: MoneyAction) => {
    await q.execute("UPDATE advances SET status = 'paid'", []);
    void a;
  });
  const onFailed = vi.fn(async () => {});
  const hooks: MoneyHooks = {
    onReserved: async (q) => {
      // The caller's own write in the approval transaction.
      ledger.subjects.set(payoutDraft().subjectId, "approved");
      await q.execute("UPDATE advances SET status = 'approved'", []);
    },
    onConfirmed,
    onFailed,
  };
  return { ledger, db, mock, payment, deps, hooks, onConfirmed, onFailed, lines };
}

beforeEach(() => {
  flags.payoutsEnabled = true;
  flags.paymentProvider = "mock";
});

afterEach(() => {
  Object.assign(flags, saved);
});

describe("executeMoneyAction", () => {
  it("reserves, commits, claims, then sends once and settles (order asserted)", async () => {
    const t = setup();
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps);
    expect(steps(t.ledger.events)).toEqual([
      "begin",
      "approval",
      "reserve",
      "commit",
      "begin",
      "markSent",
      "commit",
      "send",
      "begin",
      "settle:confirmed:response",
      "commit",
    ]);
    expect(r.created).toBe(true);
    expect(r.sent).toBe(true);
    expect(r.action.state).toBe("confirmed");
    expect(r.action.settledVia).toBe("response");
    expect(r.action.outsideSystem).toBe("mock");
    expect(r.action.outsideId).toMatch(/^mock_[0-9a-f]{16}$/);
    expect(r.action.outsideAmountCents).toBe(25_000);
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);
    expect(t.payment.sends).toBe(1);
    // The caller's write ran inside the reserve transaction, before its commit.
    const firstCommit = t.ledger.events.indexOf("commit");
    expect(t.ledger.events.indexOf("sql:UPDATE advances SET status = 'approved'")).toBeLessThan(
      firstCommit,
    );
  });

  it("sends with the row's request id and the tenant's zone", async () => {
    const seen: unknown[] = [];
    const inner: PaymentAdapter = {
      system: "mock",
      ready: async () => ({ ok: true }),
      sendPayout: async (p, ctx) => {
        seen.push({ p, ctx });
        return { kind: "confirmed", system: "mock", type: "payout", id: "mock_1", amountCents: 25_000 };
      },
      readBack: async () => ({ found: false }),
    };
    const t = setup(inner);
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps);
    expect(seen).toEqual([
      {
        p: {
          actionId: r.action.id,
          driverId: r.action.counterpartyId,
          amountCents: 25_000,
          memoCode: `advances:${r.action.subjectId}`,
        },
        ctx: { requestId: r.action.requestId, timeoutMs: 1_000, tenantZone: "America/Chicago" },
      },
    ]);
  });

  it("leaves a hanging send unknown after the timeout, with no second call", async () => {
    const t = setup();
    t.mock.hangNext();
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, {
      ...t.deps,
      timeoutMs: 5,
    });
    expect(r.action.state).toBe("unknown");
    expect(r.action.failureCategory).toBe("timeout");
    expect(r.sent).toBe(true);
    const again = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps);
    expect(again.created).toBe(false);
    expect(again.sent).toBe(false);
    expect(again.action.id).toBe(r.action.id);
    expect(again.action.state).toBe("unknown");
    expect(t.payment.sends).toBe(1);
    expect(t.onConfirmed).not.toHaveBeenCalled();
  });

  it("replays a settled row with no call, and runs onConfirmed once (dedupe key kind:subject:attempt)", async () => {
    const t = setup();
    const first = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps);
    const second = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps);
    expect(second).toEqual({ action: first.action, created: false, sent: false });
    expect(first.action.idempotencyKey).toBe(`advance_payout:${first.action.subjectId}:1`);
    expect(t.payment.sends).toBe(1);
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);
    expect(t.ledger.rows.size).toBe(1);
  });

  it("refuses before any transaction when the switch is off, with one would-send line", async () => {
    const t = setup();
    flags.payoutsEnabled = false;
    await expect(
      executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps),
    ).rejects.toMatchObject({ category: "disabled" });
    expect(t.db.transactions).toBe(0);
    expect(t.ledger.rows.size).toBe(0);
    expect(t.payment.sends).toBe(0);
    expect(t.lines).toEqual([
      expect.stringMatching(
        /^money: would send advance_payout 25000c for advances [0-9a-f-]{36} via mock \(payoutsEnabled off\)$/,
      ),
    ]);
  });

  it("refuses before any transaction when the adapter is not ready", async () => {
    const inner: PaymentAdapter = {
      system: "stripe_test",
      ready: async () => ({ ok: false, category: "not_configured" }),
      sendPayout: async () => ({ kind: "failed", category: "not_configured" }),
      readBack: async () => ({ found: false }),
    };
    const t = setup(inner);
    await expect(
      executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps),
    ).rejects.toMatchObject({ category: "not_configured" });
    expect(t.db.transactions).toBe(0);
  });

  it("settles failed/disabled, with no call, when the switch flips after the reserve", async () => {
    const t = setup();
    const hooks: MoneyHooks = {
      ...t.hooks,
      onReserved: async () => {
        flags.payoutsEnabled = false;
      },
    };
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), hooks, t.deps);
    expect(r.action.state).toBe("failed");
    expect(r.action.settledVia).toBe("refused");
    expect(r.action.failureCategory).toBe("disabled");
    expect(r.sent).toBe(false);
    expect(t.payment.sends).toBe(0);
    expect(t.onFailed).toHaveBeenCalledTimes(1);
    expect(steps(t.ledger.events)).not.toContain("markSent");
  });

  it("settles failed/disabled when the switch flips after the claim (the adapter re-checks)", async () => {
    const t = setup();
    const inner = t.mock;
    const flipping: PaymentAdapter = {
      system: "mock",
      ready: () => inner.ready(),
      sendPayout: async (p, ctx) => {
        flags.payoutsEnabled = false;
        return inner.sendPayout(p, ctx);
      },
      readBack: (ref, ctx) => inner.readBack(ref, ctx),
    };
    const t2 = setup(flipping);
    const r = await executeMoneyAction(t2.db, SESSION, payoutDraft(), t2.hooks, t2.deps);
    expect(r.action.state).toBe("failed");
    expect(r.action.settledVia).toBe("response");
    expect(r.action.failureCategory).toBe("disabled");
    expect(inner.createdCount).toBe(0);
  });

  it("rolls the reservation back with the caller's write when that write throws", async () => {
    const t = setup();
    const hooks: MoneyHooks = {
      ...t.hooks,
      onReserved: async () => {
        throw new Error("advance was not requested");
      },
    };
    await expect(executeMoneyAction(t.db, SESSION, payoutDraft(), hooks, t.deps)).rejects.toThrow(
      "advance was not requested",
    );
    expect(t.ledger.rows.size).toBe(0);
    expect(t.payment.sends).toBe(0);
  });

  it("leaves the row sent when onConfirmed throws", async () => {
    const t = setup();
    t.onConfirmed.mockRejectedValueOnce(new Error("follow-up failed"));
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps);
    expect(r.sent).toBe(true);
    expect(r.action.state).toBe("sent");
    expect(t.ledger.only().state).toBe("sent");
    // The settle rolled back, then the row was read as stored.
    expect(steps(t.ledger.events).slice(-4)).toEqual([
      "settle:confirmed:response",
      "rollback",
      "begin",
      "commit",
    ]);
    expect(t.lines.some((l) => l.includes("did not commit"))).toBe(true);
  });

  it("records a payout that went through but threw as unknown/network", async () => {
    const t = setup();
    t.mock.confirmSilently();
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps);
    expect(r.action.state).toBe("unknown");
    expect(r.action.failureCategory).toBe("network");
    expect(t.mock.createdCount).toBe(1);
  });

  it("fails a confirmation for another amount as amount_mismatch, for a person", async () => {
    const inner: PaymentAdapter = {
      system: "mock",
      ready: async () => ({ ok: true }),
      sendPayout: async () => ({
        kind: "confirmed",
        system: "mock",
        type: "payout",
        id: "mock_2",
        amountCents: 24_999,
      }),
      readBack: async () => ({ found: false }),
    };
    const t = setup(inner);
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps);
    expect(r.action.state).toBe("failed");
    expect(r.action.failureCategory).toBe("amount_mismatch");
    expect(r.action.outsideAmountCents).toBe(24_999);
    expect(t.onConfirmed).not.toHaveBeenCalled();
    expect(t.onFailed).toHaveBeenCalledTimes(1);
  });

  it("waits for the caller that won the claim instead of sending again", async () => {
    const t = setup();
    let polls = 0;
    const hooks: MoneyHooks = {
      ...t.hooks,
      // Another caller claims the row right after this one reserves it.
      onReserved: async (q, a) => {
        await t.ledger.store.markSent(q, a.id);
      },
    };
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), hooks, {
      ...t.deps,
      waitMs: 10,
      sleep: async () => {
        polls += 1;
        const id = t.ledger.only().id;
        await t.ledger.store.settle(null as never, id, {
          to: "confirmed",
          via: "response",
          outside: { system: "mock", type: "payout", id: "mock_other", amountCents: 25_000 },
        });
      },
    });
    expect(t.payment.sends).toBe(0);
    expect(r.sent).toBe(false);
    expect(r.action.state).toBe("confirmed");
    expect(r.action.outsideId).toBe("mock_other");
    expect(polls).toBe(1);
  });

  it("refuses hooks that do not match the channel, and a bad draft, before any transaction", async () => {
    const t = setup();
    const send = async (): Promise<SendOutcome> => ({ kind: "failed", category: "validation" });
    await expect(
      executeMoneyAction(t.db, SESSION, payoutDraft(), { ...t.hooks, send }, t.deps),
    ).rejects.toMatchObject({ category: "validation" });
    await expect(
      executeMoneyAction(
        t.db,
        SESSION,
        payoutDraft({ kind: "advance_expense" }),
        t.hooks,
        t.deps,
      ),
    ).rejects.toMatchObject({ category: "validation" });
    await expect(
      executeMoneyAction(t.db, SESSION, payoutDraft({ amountCents: 12.5 }), t.hooks, t.deps),
    ).rejects.toBeInstanceOf(MoneyError);
    await expect(
      executeMoneyAction(t.db, SESSION, payoutDraft({ subjectStatuses: undefined }), t.hooks, t.deps),
    ).rejects.toMatchObject({ category: "validation" });
    expect(t.db.transactions).toBe(0);
  });
});

describe("settlementFor", () => {
  const action = { amountCents: 25_000 } as MoneyAction;
  const ok = { kind: "confirmed", system: "mock", type: "payout", id: "mock_1", amountCents: 25_000 };

  it("confirms only a whole, usable answer from the expected system", () => {
    expect(settlementFor(ok, action, "mock")).toMatchObject({ to: "confirmed", via: "response" });
    for (const bad of [
      { ...ok, id: "" },
      { ...ok, id: undefined },
      { ...ok, system: "stripe_test" },
      { ...ok, amountCents: 25_000.5 },
      { ...ok, type: "x" },
      null,
      "confirmed",
    ]) {
      expect(settlementFor(bad, action, "mock")).toEqual({ to: "unknown", category: "unknown" });
    }
  });

  it("fails only on a definite no; anything ambiguous stays unknown", () => {
    for (const c of ["disabled", "not_connected", "not_configured", "validation", "auth", "rate_limited"]) {
      expect(settlementFor({ kind: "failed", category: c }, action, "mock")).toEqual({
        to: "failed",
        via: "response",
        category: c,
      });
    }
    for (const c of ["unavailable", "timeout", "network", "duplicate", "amount_mismatch", "unknown", "raw text"]) {
      expect(settlementFor({ kind: "failed", category: c }, action, "mock").to).toBe("unknown");
    }
    expect(settlementFor({ kind: "unknown", category: "timeout" }, action, "mock")).toEqual({
      to: "unknown",
      category: "timeout",
    });
    expect(settlementFor({ kind: "unknown", category: "auth" }, action, "mock")).toEqual({
      to: "unknown",
      category: "unknown",
    });
  });
});
