import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Param, Queryable, TenantDb } from "../db";
import { ADVANCE_REFUSALS } from "../rules-engine/types";
import { requestFromDesk, type DeskDeps } from "./desk";
import { actionsFor, outsideTail, type LedgerEntry } from "./read";
import {
  ADVANCE_APPROVE_NOTICE,
  FLOW_OUTCOMES,
  decisionNoteSentence,
  outcomeSentence,
  refusalSentence,
} from "./reasons";
import {
  DESK_MAX_CENTS,
  DESK_MIN_CENTS,
  REQUEST_REF,
  deskRequestText,
  expenseAmountCents,
  isDeskAmount,
  parseDollarsToCents,
  requestRefOf,
  sourceOfInput,
  sourceWords,
} from "./request";
import { advancesOn, payoutGate } from "./switches";
import type { AdvanceView } from "./rows";

// The advance flow's pure rules: typed dollars to cents, the desk's sentence, the reference, the
// accounting amount, every sentence a person can see, the payout switches in order, the record
// page's buttons, and the desk with its database and agent turn faked. No database, no network.

const saved = structuredClone(flags);

beforeEach(() => {
  Object.assign(flags, structuredClone(saved));
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
});

describe("typed dollars to cents", () => {
  it.each([
    ["300", 30_000],
    ["300.5", 30_050],
    ["300.50", 30_050],
    ["0.01", 1],
    ["$1,250.00", 125_000],
    [" 42 ", 4_200],
    ["1,000,000", 100_000_000],
  ])("reads %j as %i cents", (text, cents) => {
    expect(parseDollarsToCents(text)).toBe(cents);
  });

  it.each(["1e3", "-1", "1.234", "abc", "", "1,00", "12,3456", "$", ".5", "1.", "+5", "Infinity", "0x10"])(
    "refuses %j",
    (text) => {
      expect(parseDollarsToCents(text)).toBeNull();
    },
  );

  it("bounds the desk's amounts", () => {
    expect(isDeskAmount(DESK_MIN_CENTS)).toBe(true);
    expect(isDeskAmount(DESK_MAX_CENTS)).toBe(true);
    expect(isDeskAmount(DESK_MIN_CENTS - 1)).toBe(false);
    expect(isDeskAmount(DESK_MAX_CENTS + 1)).toBe(false);
    expect(isDeskAmount(150.5)).toBe(false);
    expect(isDeskAmount("30000")).toBe(false);
  });
});

describe("the desk's sentence, the reference and the accounting amount", () => {
  it("says the same words every time, naming the driver by code", () => {
    expect(deskRequestText(30_000, "BR-C01", "fuel")).toBe("Request an advance of $300.00 for driver BR-C01 (fuel)");
  });

  it("refuses an amount, code or reason outside the desk's lists", () => {
    expect(() => deskRequestText(50, "BR-C01", "fuel")).toThrow(RangeError);
    expect(() => deskRequestText(30_000, "Jane Smith", "fuel")).toThrow(RangeError);
    expect(() => deskRequestText(30_000, "BR-C01", "beer" as never)).toThrow(RangeError);
  });

  it("derives ADV- and twelve hex characters from the proposal id", () => {
    const ref = requestRefOf("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(ref).toBe("ADV-0A1B2C3D4E5F");
    expect(REQUEST_REF.test(ref)).toBe(true);
    expect(() => requestRefOf("0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D")).toThrow(RangeError);
    expect(() => requestRefOf("not-a-uuid")).toThrow(RangeError);
  });

  it("books the advance plus its fee, in whole cents", () => {
    expect(expenseAmountCents({ amountCents: 25_000, feeCents: 500 })).toBe(25_500);
    expect(expenseAmountCents({ amountCents: 25_000, feeCents: 0 })).toBe(25_000);
    expect(() => expenseAmountCents({ amountCents: 0, feeCents: 500 })).toThrow(RangeError);
    expect(() => expenseAmountCents({ amountCents: 100, feeCents: -1 })).toThrow(RangeError);
    expect(() => expenseAmountCents({ amountCents: 100.5, feeCents: 0 })).toThrow(RangeError);
  });

  it("names where an ask came from", () => {
    expect(sourceOfInput("transcript")).toBe("voice");
    expect(sourceOfInput("email")).toBe("email");
    expect(sourceOfInput(null)).toBe("ui");
    expect(sourceOfInput("upload")).toBe("ui");
    expect(sourceWords("voice")).toBe("Voice note");
    expect(sourceWords("seed")).toBe("On file");
    expect(sourceWords("toString")).toBe("Other");
  });
});

describe("the sentences a person sees", () => {
  const numbers = { minCents: 5_000, limitCents: 150_000, shareBps: 5_000, earnedUnpaidCents: 120_000 };

  it("has a sentence for every engine refusal, with the carrier's numbers", () => {
    for (const code of ADVANCE_REFUSALS) expect(refusalSentence(code, numbers)).toMatch(/\.$/);
    expect(refusalSentence("below_minimum", numbers)).toContain("$50.00");
    expect(refusalSentence("over_driver_limit", numbers)).toContain("$1,500.00");
    expect(refusalSentence("exceeds_earned_share", numbers)).toBe(
      "More than 50% of earned, unpaid pay ($1,200.00).",
    );
    expect(refusalSentence("exceeds_earned_share", { ...numbers, shareBps: 3_350 })).toContain("33.5%");
    expect(refusalSentence("exceeds_earned_share", { ...numbers, shareBps: 3_305 })).toContain("33.05%");
  });

  it("has a distinct sentence for every flow outcome and falls back for anything else", () => {
    const sentences = FLOW_OUTCOMES.map(outcomeSentence);
    expect(new Set(sentences).size).toBe(FLOW_OUTCOMES.length);
    expect(outcomeSentence("Error: socket hang up at 10.0.0.1")).toBe(outcomeSentence("unavailable"));
    expect(outcomeSentence("constructor")).toBe(outcomeSentence("unavailable"));
  });

  it("gives the approval card only the executor's own refusals", () => {
    expect(Object.keys(ADVANCE_APPROVE_NOTICE).sort()).toEqual(
      [
        "before_start",
        "disabled",
        "eligibility_unavailable",
        "not_armed",
        "over_cap",
        "payout_failed",
        "payouts_off",
        "ref_collision",
        "stale_eligibility",
      ].sort(),
    );
    expect(ADVANCE_APPROVE_NOTICE.over_cap).toBe(outcomeSentence("over_cap"));
  });

  it("reads a decision note from its codes only", () => {
    expect(decisionNoteSentence(null)).toBeNull();
    expect(decisionNoteSentence("")).toBeNull();
    expect(decisionNoteSentence("stale_eligibility: exceeds_earned_share,amount_changed")).toBe(
      "The numbers changed before approval (exceeds earned share, the amount allowed changed), so nothing was paid.",
    );
    expect(decisionNoteSentence("expired")).toBe("No one decided in time, so it expired.");
    expect(decisionNoteSentence("wrong_amount")).toBe("Decision: wrong amount.");
  });
});

describe("the payout switches", () => {
  const open = () => {
    flags.advancesEnabled = true;
    flags.payoutsEnabled = true;
    flags.advancePayouts = { armed: true, capCents: 50_000, startDate: "2026-10-27" };
  };

  it("ships closed", () => {
    expect(advancesOn()).toBe(false);
    expect(payoutGate(25_000, "2026-11-02")).toBe("disabled");
  });

  it("refuses in order: switch, payouts, armed, cap, start date", () => {
    open();
    expect(payoutGate(25_000, "2026-11-02")).toBeNull();
    expect(payoutGate(25_000, "2026-10-26")).toBe("before_start");
    expect(payoutGate(50_001, "2026-10-26")).toBe("over_cap");
    flags.advancePayouts = { ...flags.advancePayouts, armed: false };
    expect(payoutGate(50_001, "2026-10-26")).toBe("not_armed");
    flags.payoutsEnabled = false;
    expect(payoutGate(50_001, "2026-10-26")).toBe("payouts_off");
    flags.advancesEnabled = false;
    expect(payoutGate(50_001, "2026-10-26")).toBe("disabled");
  });

  it("opens on the start date itself and at the cap exactly", () => {
    open();
    expect(payoutGate(50_000, "2026-10-27")).toBeNull();
  });

  it("treats a broken cap or start date as closed", () => {
    open();
    flags.advancePayouts = { armed: true, capCents: Number.NaN, startDate: "2026-10-27" };
    expect(payoutGate(1, "2026-11-02")).toBe("over_cap");
    flags.advancePayouts = { armed: true, capCents: 50_000, startDate: "soon" };
    expect(payoutGate(1, "2026-11-02")).toBe("before_start");
    flags.advancePayouts = { armed: true, capCents: 50_000, startDate: "2026-10-27" };
    expect(payoutGate(1.5, "2026-11-02")).toBe("over_cap");
  });
});

describe("the record page's buttons", () => {
  const advance = (over: Partial<AdvanceView> = {}): AdvanceView => ({
    id: "a",
    driverId: "d",
    proposalId: "p",
    requestRef: "ADV-000000000000",
    requestedAt: "2026-11-02T15:00:00.000Z",
    requestedOn: "2026-11-02",
    amountCents: 25_000,
    feeCents: 500,
    recoveredCents: 0,
    status: "approved",
    source: "ui",
    sourceInputId: null,
    decidedAt: "2026-11-02T16:00:00.000Z",
    decidedByMembershipId: "m",
    paidAt: null,
    ...over,
  });
  const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: "l",
    kind: "advance_payout",
    state: "failed",
    attempt: 1,
    amountCents: 25_000,
    failureCategory: "declined",
    outsideTail: null,
    createdAt: "2026-11-02T16:00:00.000Z",
    settledAt: null,
    ...over,
  });

  beforeEach(() => {
    flags.advancesEnabled = true;
    flags.accountingEnabled = true;
  });

  it("offers nothing for seeded history or while advances are off", () => {
    expect(actionsFor(advance({ proposalId: null }), [entry()])).toEqual({ retry: false, check: false, post: false });
    flags.advancesEnabled = false;
    expect(actionsFor(advance(), [entry()])).toEqual({ retry: false, check: false, post: false });
  });

  it("offers Retry only after a definite failure, under the attempt ceiling", () => {
    expect(actionsFor(advance(), [entry()]).retry).toBe(true);
    expect(actionsFor(advance(), [entry({ failureCategory: "amount_mismatch" })]).retry).toBe(false);
    expect(actionsFor(advance(), [entry({ attempt: flags.advancesLimits.maxPayoutAttempts })]).retry).toBe(false);
    expect(actionsFor(advance(), [entry({ state: "unknown", failureCategory: null })]).retry).toBe(false);
  });

  it("offers Retry for an approval that stopped before the ledger", () => {
    expect(actionsFor(advance({ status: "requested", decidedAt: null, decidedByMembershipId: null }), []).retry).toBe(
      true,
    );
  });

  it("offers Check pending for an unknown or sent row, and Post only for a paid advance", () => {
    expect(actionsFor(advance(), [entry({ state: "unknown", failureCategory: null })]).check).toBe(true);
    expect(actionsFor(advance(), [entry({ state: "sent", failureCategory: null })]).check).toBe(true);
    const paid = advance({ status: "paid", paidAt: "2026-11-02T16:01:00.000Z" });
    const confirmed = entry({ state: "confirmed", failureCategory: null });
    expect(actionsFor(paid, [confirmed]).post).toBe(true);
    expect(actionsFor(paid, [confirmed, entry({ kind: "advance_expense", state: "confirmed", failureCategory: null })]).post).toBe(
      false,
    );
    flags.accountingEnabled = false;
    expect(actionsFor(paid, [confirmed]).post).toBe(false);
  });

  it("shows an outside id by its last four characters only", () => {
    expect(outsideTail("po_1234567890abcd")).toBe("abcd");
    expect(outsideTail("")).toBeNull();
    expect(outsideTail(null)).toBeNull();
  });
});

describe("the request desk", () => {
  const session = { sub: "sub-1", email: "a@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
  const driverId = "22222222-2222-4222-8222-222222222222";
  const turnId = "33333333-3333-4333-8333-333333333333";

  // A tenant database that knows one member and one driver.
  function fakeDb(member = true, code: string | null = "BR-C01"): TenantDb & { sql: string[] } {
    const sql: string[] = [];
    const q: Queryable = {
      async query<T>(text: string, params?: Param[]): Promise<T[]> {
        sql.push(text);
        if (text.includes("FROM memberships")) return (member ? [{ ok: 1 }] : []) as T[];
        if (text.includes("FROM drivers")) return (code && params?.[0] === driverId ? [{ code }] : []) as T[];
        return [];
      },
      async execute() {
        return 0;
      },
    };
    return { sql, withTenant: async (_tenant, fn) => fn(q) } as TenantDb & { sql: string[] };
  }

  function deps(db = fakeDb(), opened: "ok" | "busy" | "not_found" = "ok") {
    const calls: { open: unknown[]; run: unknown[] } = { open: [], run: [] };
    const d: DeskDeps = {
      db,
      clock: () => Date.UTC(2026, 10, 2, 16),
      newId: () => turnId,
      open: async (_s, input) => {
        calls.open.push(input);
        if (opened !== "ok") return { refused: opened } as never;
        return { conversationId: "c-1", turnId: input.turnId } as never;
      },
      run: async (_s, _turn, text) => {
        calls.run.push(text);
        return "done";
      },
    };
    return { d, calls };
  }

  beforeEach(() => {
    flags.advancesEnabled = true;
    flags.agentEnabled = true;
    flags.aiEnabled = true;
  });

  it("hands the agent the fixed sentence and answers with the turn", async () => {
    const { d, calls } = deps();
    const result = await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel" }, d);
    expect(result).toEqual({ ok: true, conversationId: "c-1", turnId, status: "done" });
    expect(calls.run).toEqual(["Request an advance of $300.00 for driver BR-C01 (fuel)"]);
    expect(calls.open[0]).toMatchObject({ conversationId: null, turnId, text: calls.run[0] });
  });

  it("checks its switches in order before reading anything", async () => {
    const db = fakeDb();
    const { d } = deps(db);
    flags.aiEnabled = false;
    expect(await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel" }, d)).toEqual({
      ok: false,
      category: "ai_off",
    });
    flags.agentEnabled = false;
    expect(await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel" }, d)).toEqual({
      ok: false,
      category: "agent_off",
    });
    flags.advancesEnabled = false;
    expect(await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel" }, d)).toEqual({
      ok: false,
      category: "disabled",
    });
    expect(db.sql).toEqual([]);
  });

  it("refuses a bad amount or reason, and an unknown driver, without opening a turn", async () => {
    const { d, calls } = deps(fakeDb(true, null));
    expect(await requestFromDesk(session, { driverId, amountCents: 99, category: "fuel" }, d)).toEqual({
      ok: false,
      category: "bad_request",
    });
    expect(await requestFromDesk(session, { driverId, amountCents: 30_000, category: "beer" as never }, d)).toEqual({
      ok: false,
      category: "bad_request",
    });
    expect(await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel" }, d)).toEqual({
      ok: false,
      category: "not_found",
    });
    expect(calls.open).toEqual([]);
  });

  it("refuses a login with no membership", async () => {
    const { d } = deps(fakeDb(false));
    await expect(requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel" }, d)).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });

  it("says busy when a turn is already running", async () => {
    const { d, calls } = deps(fakeDb(), "busy");
    expect(await requestFromDesk(session, { driverId, amountCents: 30_000, category: "fuel" }, d)).toEqual({
      ok: false,
      category: "busy",
    });
    expect(calls.run).toEqual([]);
  });
});
