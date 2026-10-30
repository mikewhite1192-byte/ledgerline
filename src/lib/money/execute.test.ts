import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { createFuelCardSimAdapter, loadId } from "../adapters/payment/fuel-card-sim";
import { createMockPaymentAdapter } from "../adapters/payment/mock";
import type { AccountingAdapter, FuelCardDestination, PaymentAdapter, SendOutcome } from "../adapters/types";
import {
  executeMoneyAction,
  isHooked,
  payoutOf,
  settlementFor,
  type LedgerStore,
  type MoneyDeps,
  type MoneyHooks,
} from "./execute";
import {
  FakeDb,
  DRIVER,
  FakeLedger,
  nextId,
  payoutDraft,
  recordingPayment,
  SESSION,
  steps,
} from "./test-fakes";
import { DEMO_CARRIERS } from "../seed/carriers";
import { KIND_SHAPES, MONEY_ACTION_KINDS, MoneyError, RAIL_OF_KIND, railOf, type MoneyAction } from "./types";

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
          rail: "fuel_card",
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
        /^money: would send advance_payout 25000c for advances [0-9a-f-]{36} via fuel_card mock \(payoutsEnabled off\)$/,
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

  it("re-checks the accounting switch at the write: flipped off after the claim, no call and failed/disabled", async () => {
    flags.accountingEnabled = true;
    const accounting = {
      system: "qbo_sandbox",
      ready: async () => ({ ok: true }),
    } as unknown as AccountingAdapter;
    const answer: SendOutcome = {
      kind: "confirmed",
      system: "qbo_sandbox",
      type: "Purchase",
      id: "qbo_1",
      amountCents: 25_000,
    };
    const expense = payoutDraft({ kind: "advance_expense" });

    // Control: with the switch on, the caller's hook makes the one call.
    const on = setup();
    const sendOn = vi.fn(async (): Promise<SendOutcome> => answer);
    const ok = await executeMoneyAction(on.db, SESSION, expense, { ...on.hooks, send: sendOn }, {
      ...on.deps,
      accounting,
    });
    expect(sendOn).toHaveBeenCalledTimes(1);
    expect(ok.action.state).toBe("confirmed");

    const t = setup();
    const send = vi.fn(async (): Promise<SendOutcome> => answer);
    const store: LedgerStore = {
      ...t.ledger.store,
      markSent: async (q, id) => {
        const claimed = await t.ledger.store.markSent(q, id);
        flags.accountingEnabled = false;
        return claimed;
      },
    };
    const r = await executeMoneyAction(t.db, SESSION, expense, { ...t.hooks, send }, {
      ...t.deps,
      store,
      accounting,
    });
    expect(send).not.toHaveBeenCalled();
    expect(r.action).toMatchObject({
      state: "failed",
      settledVia: "response",
      failureCategory: "disabled",
    });
    expect(t.ledger.only().state).toBe("failed");
    expect(t.onFailed).toHaveBeenCalledTimes(1);
    expect(steps(t.ledger.events)).toContain("markSent");
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

  it("stops waiting after the default 8 s and reports the row still sent, with no send", async () => {
    const t = setup();
    const slept: number[] = [];
    const hooks: MoneyHooks = {
      ...t.hooks,
      // Another caller claims the row right after this one reserves it, and never settles it.
      onReserved: async (q, a) => {
        await t.ledger.store.markSent(q, a.id);
      },
    };
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), hooks, {
      ...t.deps,
      waitMs: undefined,
      pollMs: undefined,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(r).toMatchObject({ created: true, sent: false });
    expect(r.action.state).toBe("sent");
    expect(t.ledger.only().state).toBe("sent");
    expect(t.payment.sends).toBe(0);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(8_000);
    expect(t.onConfirmed).not.toHaveBeenCalled();
    expect(t.onFailed).not.toHaveBeenCalled();
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

describe("the fuel-card rail", () => {
  const DEST: FuelCardDestination = {
    rail: "fuel_card",
    provider: "fuel_card_sim",
    token: "fcs_card_0123456789abcdef01234567",
    last4: "4417",
    simBehavior: "ok",
  };
  const sim = () => createFuelCardSimAdapter({ log: () => {} });
  const withCard = (hooks: MoneyHooks, dest: FuelCardDestination | null = DEST): MoneyHooks => ({
    ...hooks,
    destination: async () => dest,
  });

  it("maps the payment kinds on a rail: advances to the card, settlements and escrow releases to the bank; the rest are hooked", () => {
    const paymentKinds = MONEY_ACTION_KINDS.filter((k) => KIND_SHAPES[k].channel === "payment");
    const onRail = paymentKinds.filter((k) => !isHooked(k));
    expect(Object.keys(RAIL_OF_KIND).sort()).toEqual([...onRail].sort());
    expect(RAIL_OF_KIND).toEqual({ advance_payout: "fuel_card", settlement_payout: "bank", escrow_release: "bank" });
    expect(paymentKinds.filter((k) => isHooked(k)).sort()).toEqual(["factoring_advance", "money_code_issue"]);
    expect(railOf("factoring_advance")).toBeNull();
    expect(railOf("money_code_issue")).toBeNull();
  });

  it("builds the payout with its rail and the card, and refuses a kind with no rail", () => {
    const action = {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      kind: "advance_payout",
      subjectTable: "advances",
      subjectId: "bbbbbbbb-0000-4000-8000-000000000001",
      counterpartyId: "cccccccc-0000-4000-8000-000000000001",
      amountCents: 25_000,
    } as MoneyAction;
    expect(payoutOf(action, DEST)).toEqual({
      actionId: action.id,
      driverId: action.counterpartyId,
      amountCents: 25_000,
      memoCode: `advances:${action.subjectId}`,
      rail: "fuel_card",
      destination: DEST,
    });
    expect(payoutOf(action)).not.toHaveProperty("destination");
    expect(() => payoutOf({ ...action, kind: "advance_expense" })).toThrow(MoneyError);
  });

  it("loads the card the hook names, confirmed by the simulated provider", async () => {
    const t = setup(sim());
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), withCard(t.hooks), t.deps);
    expect(r.action).toMatchObject({
      state: "confirmed",
      settledVia: "response",
      outsideSystem: "fuel_card_sim",
      outsideId: loadId(r.action.requestId),
      outsideAmountCents: 25_000,
    });
    expect(t.payment.sends).toBe(1);
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);
    expect(t.lines).toContainEqual(expect.stringMatching(/ via fuel_card fuel_card_sim$/));
    expect(t.lines.join(" ")).not.toContain(DEST.token);
  });

  it("refuses before any send when the hook finds no card", async () => {
    const t = setup(sim());
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), withCard(t.hooks, null), t.deps);
    expect(r.action).toMatchObject({ state: "failed", settledVia: "refused", failureCategory: "validation" });
    expect(t.payment.sends).toBe(0);
    expect(t.onFailed).toHaveBeenCalledTimes(1);
    expect(steps(t.ledger.events)).not.toContain("markSent");
  });

  it("refuses before any send when the provider needs a card and no hook gives one", async () => {
    const t = setup(sim());
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft(), t.hooks, t.deps);
    expect(r.action).toMatchObject({ state: "failed", settledVia: "refused", failureCategory: "validation" });
    expect(t.payment.sends).toBe(0);
  });

  it("settles a declined card failed by response: definite, nothing moved", async () => {
    const t = setup(sim());
    const r = await executeMoneyAction(
      t.db,
      SESSION,
      payoutDraft(),
      withCard(t.hooks, { ...DEST, simBehavior: "declined" }),
      t.deps,
    );
    expect(r.action).toMatchObject({ state: "failed", settledVia: "response", failureCategory: "declined" });
    expect(t.payment.sends).toBe(1);
    expect(t.onFailed).toHaveBeenCalledTimes(1);
    expect(t.onConfirmed).not.toHaveBeenCalled();
    expect(settlementFor({ kind: "failed", category: "declined" }, r.action, "fuel_card_sim")).toEqual({
      to: "failed",
      via: "response",
      category: "declined",
    });
  });

  it("leaves a slow card unknown for the read-back, and treats a confirmation from another system as unknown", async () => {
    const t = setup(sim());
    const r = await executeMoneyAction(
      t.db,
      SESSION,
      payoutDraft(),
      withCard(t.hooks, { ...DEST, simBehavior: "slow" }),
      t.deps,
    );
    expect(r.action).toMatchObject({ state: "unknown", failureCategory: "timeout" });
    const fromMock = { kind: "confirmed", system: "mock", type: "card_load", id: "fcs_load_1", amountCents: 25_000 };
    expect(settlementFor(fromMock, r.action, "fuel_card_sim")).toEqual({ to: "unknown", category: "unknown" });
  });

  it("sends an accounting post through its own hook even with the card provider injected", async () => {
    flags.accountingEnabled = true;
    const t = setup(sim());
    const accounting = { system: "qbo_sandbox", ready: async () => ({ ok: true }) } as unknown as AccountingAdapter;
    const send = vi.fn(
      async (): Promise<SendOutcome> => ({
        kind: "confirmed",
        system: "qbo_sandbox",
        type: "Purchase",
        id: "qbo_1",
        amountCents: 25_000,
      }),
    );
    const r = await executeMoneyAction(t.db, SESSION, payoutDraft({ kind: "advance_expense" }), { ...t.hooks, send }, {
      ...t.deps,
      accounting,
    });
    expect(r.action).toMatchObject({ state: "confirmed", outsideSystem: "qbo_sandbox", outsideId: "qbo_1" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(t.payment.sends).toBe(0);
  });

  it("refuses a destination hook on an accounting kind before any transaction", async () => {
    flags.accountingEnabled = true;
    const t = setup();
    const accounting = { system: "qbo_sandbox", ready: async () => ({ ok: true }) } as unknown as AccountingAdapter;
    const send = vi.fn(async (): Promise<SendOutcome> => ({ kind: "unknown", category: "timeout" }));
    await expect(
      executeMoneyAction(t.db, SESSION, payoutDraft({ kind: "advance_expense" }), withCard({ ...t.hooks, send }), {
        ...t.deps,
        accounting,
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(t.db.transactions).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a payment kind with no rail (a money code)", () => {
  const CODE = "55555555-5555-4555-8555-555555555555";
  const codeDraft = () =>
    payoutDraft({ kind: "money_code_issue", subjectId: CODE, amountCents: 15_000, subjectStatuses: ["issuing", "unknown"] });
  function codeSetup(answer: SendOutcome = {
    kind: "confirmed",
    system: "fuel_card_sim",
    type: "money_code",
    id: "fcs_code_0123456789abcdef01234567",
    amountCents: 15_000,
  }) {
    const t = setup();
    t.ledger.subjects.set(CODE, "issuing");
    t.ledger.counterparties.set(CODE, DRIVER);
    const send = vi.fn(async (): Promise<SendOutcome> => answer);
    const ready = vi.fn(async () => ({ ok: true as const }));
    const hooks: MoneyHooks = { ...t.hooks, onReserved: async () => {}, send, ready };
    return { ...t, send, ready, hooks };
  }

  it("refuses a rail-less kind without its own send and ready hooks, or with a destination, before any transaction", async () => {
    const t = codeSetup();
    const { send, ready, ...bare } = t.hooks;
    await expect(executeMoneyAction(t.db, SESSION, codeDraft(), bare, t.deps)).rejects.toMatchObject({
      category: "validation",
    });
    await expect(executeMoneyAction(t.db, SESSION, codeDraft(), { ...bare, send }, t.deps)).rejects.toMatchObject({
      category: "validation",
    });
    await expect(executeMoneyAction(t.db, SESSION, codeDraft(), { ...bare, ready }, t.deps)).rejects.toMatchObject({
      category: "validation",
    });
    await expect(
      executeMoneyAction(t.db, SESSION, codeDraft(), { ...t.hooks, destination: async () => null }, t.deps),
    ).rejects.toMatchObject({ category: "validation" });
    // A ready hook on a kind with a rail is refused too.
    await expect(executeMoneyAction(t.db, SESSION, payoutDraft(), { ...t.hooks, send: undefined }, t.deps)).rejects.toMatchObject({
      category: "validation",
    });
    expect(t.db.transactions).toBe(0);
    expect(t.payment.sends).toBe(0);
  });

  it("reserves, sends through its own hook once (never the payment adapter) and settles", async () => {
    const t = codeSetup();
    const r = await executeMoneyAction(t.db, SESSION, codeDraft(), t.hooks, t.deps);
    expect(steps(t.ledger.events)).toEqual([
      "begin",
      "approval",
      "reserve",
      "commit",
      "begin",
      "markSent",
      "commit",
      "begin",
      "settle:confirmed:response",
      "commit",
    ]);
    expect(r.action).toMatchObject({ state: "confirmed", outsideSystem: "fuel_card_sim", subjectTable: "money_codes" });
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.ready).toHaveBeenCalledTimes(2);
    expect(t.payment.sends).toBe(0);
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("asks only its own ready hook: not ready means no transaction and no send", async () => {
    const t = codeSetup();
    t.ready.mockResolvedValueOnce({ ok: false, category: "not_configured" } as never);
    await expect(executeMoneyAction(t.db, SESSION, codeDraft(), t.hooks, t.deps)).rejects.toMatchObject({
      category: "not_configured",
    });
    expect(t.db.transactions).toBe(0);
    expect(t.send).not.toHaveBeenCalled();
  });

  it("re-checks the payment switch at the write: off after the claim means no call and failed/disabled", async () => {
    const t = codeSetup();
    t.ready.mockImplementationOnce(async () => ({ ok: true as const }));
    t.ready.mockImplementationOnce(async () => {
      flags.payoutsEnabled = false;
      return { ok: true as const };
    });
    const r = await executeMoneyAction(t.db, SESSION, codeDraft(), t.hooks, t.deps);
    expect(t.send).not.toHaveBeenCalled();
    expect(r.action).toMatchObject({ state: "failed", failureCategory: "disabled" });
  });

  it("leaves an ambiguous answer unknown for the read-back", async () => {
    const t = codeSetup({ kind: "unknown", category: "timeout" });
    const r = await executeMoneyAction(t.db, SESSION, codeDraft(), t.hooks, t.deps);
    expect(r.action.state).toBe("unknown");
    expect(t.onConfirmed).not.toHaveBeenCalled();
    expect(t.onFailed).not.toHaveBeenCalled();
  });
});

describe("the bank rail in Stripe test mode", () => {
  const SETTLEMENT = "66666666-6666-4666-8666-666666666666";
  const [demo] = DEMO_CARRIERS;
  const demoRow = {
    id: "77777777-7777-4777-8777-777777777777",
    slug: demo.slug,
    name: demo.name,
    timezone: demo.timezone,
  };
  const settlementDraft = () =>
    payoutDraft({ kind: "settlement_payout", subjectId: SETTLEMENT, subjectStatuses: ["approved"] });

  // A Stripe test double: every transfer would go to the one test account, whoever it is for.
  function stripeSetup(system: "stripe_test" | "mock" = "stripe_test") {
    const ready = vi.fn(async () => ({ ok: true as const }));
    const inner: PaymentAdapter = {
      system,
      ready,
      sendPayout: async (p) => ({
        kind: "confirmed",
        system,
        type: "payout",
        id: system === "stripe_test" ? "tr_test000001" : "mock_1",
        amountCents: p.amountCents,
      }),
      readBack: async () => ({ found: false }),
    };
    const t = setup(inner);
    t.ledger.subjects.set(SETTLEMENT, "approved");
    t.ledger.counterparties.set(SETTLEMENT, DRIVER);
    const hooks: MoneyHooks = { onReserved: async () => {}, onConfirmed: t.onConfirmed, onFailed: t.onFailed };
    return { ...t, ready, hooks };
  }

  it("refuses any carrier but the demo carriers before the adapter or a ledger row, as if payouts were off", async () => {
    for (const row of [
      undefined,
      { ...demoRow, name: "Another Carrier" },
      { ...demoRow, timezone: "UTC" },
      null,
    ]) {
      const t = stripeSetup();
      if (row !== undefined) t.ledger.tenantRow = row;
      await expect(
        executeMoneyAction(t.db, SESSION, settlementDraft(), t.hooks, t.deps),
      ).rejects.toMatchObject({ category: "disabled" });
      expect(t.ledger.rows.size).toBe(0);
      expect(t.ready).not.toHaveBeenCalled();
      expect(t.payment.sends).toBe(0);
      // Only the read of the tenant's own row ran: no approval, no reserve.
      expect(steps(t.ledger.events)).toEqual(["begin", "commit"]);
      expect(t.lines).toEqual([
        expect.stringMatching(
          /^money: would send settlement_payout 25000c for settlements [0-9a-f-]{36} via bank stripe_test \(demo carriers only\)$/,
        ),
      ]);
    }
  });

  it("pays a demo carrier through Stripe test mode", async () => {
    const t = stripeSetup();
    t.ledger.tenantRow = demoRow;
    const r = await executeMoneyAction(t.db, SESSION, settlementDraft(), t.hooks, t.deps);
    expect(r.action).toMatchObject({ state: "confirmed", outsideSystem: "stripe_test", outsideId: "tr_test000001" });
    expect(t.payment.sends).toBe(1);
    expect(t.onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("settles failed/refused/disabled, with no call, when the carrier is no longer a demo carrier after the reserve", async () => {
    const t = stripeSetup();
    t.ledger.tenantRow = demoRow;
    const hooks: MoneyHooks = {
      ...t.hooks,
      onReserved: async () => {
        t.ledger.tenantRow = { ...demoRow, name: "Renamed Carrier" };
      },
    };
    const r = await executeMoneyAction(t.db, SESSION, settlementDraft(), hooks, t.deps);
    expect(r.action).toMatchObject({ state: "failed", settledVia: "refused", failureCategory: "disabled" });
    expect(r.sent).toBe(false);
    expect(t.payment.sends).toBe(0);
    expect(t.onFailed).toHaveBeenCalledTimes(1);
    expect(t.onConfirmed).not.toHaveBeenCalled();
    expect(steps(t.ledger.events)).not.toContain("markSent");
  });

  it("re-checks at the write: the switch off after the claim means no call and failed/disabled", async () => {
    const t = stripeSetup();
    t.ledger.tenantRow = demoRow;
    t.ready.mockImplementationOnce(async () => ({ ok: true as const }));
    t.ready.mockImplementationOnce(async () => {
      flags.payoutsEnabled = false;
      return { ok: true as const };
    });
    const r = await executeMoneyAction(t.db, SESSION, settlementDraft(), t.hooks, t.deps);
    expect(t.payment.sends).toBe(0);
    expect(r.action).toMatchObject({ state: "failed", settledVia: "response", failureCategory: "disabled" });
    expect(t.onConfirmed).not.toHaveBeenCalled();
  });

  it("leaves the mock provider as it was: any carrier pays", async () => {
    const t = stripeSetup("mock");
    const r = await executeMoneyAction(t.db, SESSION, settlementDraft(), t.hooks, t.deps);
    expect(r.action).toMatchObject({ state: "confirmed", outsideSystem: "mock" });
    expect(t.payment.sends).toBe(1);
  });
});
