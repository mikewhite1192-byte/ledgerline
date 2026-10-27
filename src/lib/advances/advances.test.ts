import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Param, Queryable, TenantDb } from "../db";
import { SUBJECT_STATUSES } from "../money/types";
import { ADVANCE_REFUSALS } from "../rules-engine/types";
import { legTwoTimeoutMs } from "./approve";
import { requestFromDesk, type DeskDeps } from "./desk";
import {
  actionsFor,
  cardLineFor,
  listCardLineFor,
  outsideTail,
  recordCardFor,
  takeBackOffered,
  type CardSummary,
  type LedgerEntry,
  type RecordCard,
} from "./read";
import {
  ADVANCE_APPROVE_NOTICE,
  FLOW_OUTCOMES,
  decisionNoteSentence,
  outcomeSentence,
  panelSentence,
  refusalSentence,
  takeBackSentence,
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
// accounting amount, every sentence a person can see, the payout switches in order, the
// QuickBooks leg's time limit, the record page's buttons and card line, and the desk with its
// database and agent turn faked. No database, no network.

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
    expect(sourceWords("seed")).toBe("The office");
    expect(sourceWords("ui")).toBe("This app");
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
        "card_not_drivers",
        "disabled",
        "driver_not_armed",
        "eligibility_unavailable",
        "load_not_drivers",
        "no_card",
        "not_armed",
        "over_cap",
        "payout_failed",
        "payout_pending",
        "payouts_off",
        "ref_collision",
        "stale_eligibility",
      ].sort(),
    );
    expect(ADVANCE_APPROVE_NOTICE.over_cap).toBe(outcomeSentence("over_cap"));
  });

  it("says plainly when the driver has no fuel card on file", () => {
    expect(outcomeSentence("no_card")).toBe("This driver has no fuel card on file, so nothing was paid.");
    expect(ADVANCE_APPROVE_NOTICE.no_card).toBe(outcomeSentence("no_card"));
  });

  it("names the load, its cap and what is left when a load's cap refuses", () => {
    expect(
      refusalSentence("over_load_cap", {
        ...numbers,
        load: { number: "L-1042", capCents: 60_000, openCents: 45_000, mostCents: 14_500 },
      }),
    ).toBe("Advances on load L-1042 are capped at $600.00; $450.00 is still open, so $145.00 is the most for this load.");
    expect(refusalSentence("over_load_cap", numbers)).toBe("This would take advances on this load past the load's cap.");
    expect(refusalSentence("driver_not_armed", numbers)).toContain("An admin can arm them");
  });

  it("has its own sentences for Take back and the driver's money panel, from a closed list", () => {
    expect(takeBackSentence("role")).toBe("Taking back an advance this large needs an admin.");
    expect(takeBackSentence("over_bound")).toBe(outcomeSentence("over_bound"));
    expect(takeBackSentence("not_takeable")).toBe(outcomeSentence("not_takeable"));
    expect(takeBackSentence("Error: socket hang up")).toBe(outcomeSentence("unavailable"));
    expect(panelSentence("role")).toBe("Only an admin can arm a driver or change their cards.");
    expect(panelSentence("identity_taken")).toBe("That id already belongs to another driver.");
    expect(panelSentence("card_not_drivers")).toContain("not one of this driver's active cards");
    expect(panelSentence("constructor")).toBe(panelSentence("unavailable"));
    expect(panelSentence("Error: socket hang up at 10.0.0.1")).toBe(panelSentence("unavailable"));
  });

  it("reads a decision note from its codes only", () => {
    expect(decisionNoteSentence(null)).toBeNull();
    expect(decisionNoteSentence("")).toBeNull();
    expect(decisionNoteSentence("stale_eligibility: exceeds_earned_share,amount_changed")).toBe(
      "The numbers changed before approval (exceeds earned share, the amount allowed changed), so nothing was paid.",
    );
    expect(decisionNoteSentence("expired")).toBe("No one decided in time, so it expired.");
    expect(decisionNoteSentence("advance_cancelled")).toBe(
      "The advance was taken back before any money moved, so nothing was paid.",
    );
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
    // The right shape but not a real calendar date: closed too, whatever today is.
    for (const startDate of ["2026-00-01", "2026-13-01", "2026-02-30", "2026-10-00"]) {
      flags.advancePayouts = { armed: true, capCents: 50_000, startDate };
      expect(payoutGate(1, "2026-11-02"), startDate).toBe("before_start");
    }
    flags.advancePayouts = { armed: true, capCents: 50_000, startDate: "2026-10-27" };
    expect(payoutGate(1.5, "2026-11-02")).toBe("over_cap");
  });
});

describe("the QuickBooks leg's time limit", () => {
  it("is the request's time left less a second, in whole milliseconds, never over the money executor's limit", () => {
    expect(legTwoTimeoutMs(15_499.5, undefined)).toBe(14_499);
    expect(legTwoTimeoutMs(25_000, undefined)).toBe(20_000);
    expect(legTwoTimeoutMs(21_000, undefined)).toBe(20_000);
    expect(legTwoTimeoutMs(25_000, 2_000)).toBe(2_000);
    expect(legTwoTimeoutMs(2_500, 2_000)).toBe(1_500);
    // Too little left: the caller skips the post rather than send with no time.
    expect(legTwoTimeoutMs(1_000, undefined)).toBe(0);
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
    loadId: null,
    takenBackCents: 0,
    takenBackAt: null,
    takenBackByMembershipId: null,
    takebackReason: null,
    ...over,
  });
  const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: "l",
    kind: "advance_payout",
    state: "failed",
    attempt: 1,
    amountCents: 25_000,
    failureCategory: "declined",
    outsideSystem: null,
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
    expect(actionsFor(advance({ proposalId: null }), [entry()])).toEqual({ retry: false, check: false, post: false, takeBack: false });
    flags.advancesEnabled = false;
    expect(actionsFor(advance(), [entry()])).toEqual({ retry: false, check: false, post: false, takeBack: false });
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

  it("offers Take back only with its switch on, once, and never while a payout is in flight", () => {
    const paid = advance({ status: "paid", paidAt: "2026-11-02T16:01:00.000Z" });
    const confirmed = entry({ state: "confirmed", failureCategory: null });
    expect(takeBackOffered(paid, [confirmed])).toBe(false);
    flags.advanceTakeback = { ...flags.advanceTakeback, enabled: true };
    expect(takeBackOffered(paid, [confirmed])).toBe(true);
    expect(actionsFor(paid, [confirmed]).takeBack).toBe(true);
    expect(takeBackOffered({ ...paid, takenBackAt: "2026-11-03T10:00:00.000Z", takebackReason: "duplicate" }, [confirmed])).toBe(
      false,
    );
    // Unpaid: cancelled only when nothing could still be paid.
    expect(takeBackOffered(advance(), [])).toBe(true);
    expect(takeBackOffered(advance(), [entry()])).toBe(true);
    expect(takeBackOffered(advance(), [entry({ state: "unknown", failureCategory: null })])).toBe(false);
    expect(takeBackOffered(advance(), [entry({ state: "sent", failureCategory: null })])).toBe(false);
    expect(takeBackOffered(advance(), [entry(), entry({ id: "l2", attempt: 2, state: "reserved", failureCategory: null })])).toBe(
      false,
    );
    expect(takeBackOffered(advance({ status: "rejected" }), [])).toBe(false);
    expect(takeBackOffered(advance({ status: "cancelled" }), [])).toBe(false);
    flags.advancesEnabled = false;
    expect(takeBackOffered(paid, [confirmed])).toBe(false);
  });

  it("shows an outside id by its last four characters only", () => {
    expect(outsideTail("po_1234567890abcd")).toBe("abcd");
    expect(outsideTail("")).toBeNull();
    expect(outsideTail(null)).toBeNull();
  });
});

describe("the record page's card line", () => {
  const card = (over: Partial<RecordCard> = {}): RecordCard => ({
    last4: "4417",
    status: "active",
    recorded: true,
    ...over,
  });

  it("says Paid to for the card a paid advance recorded, and Pays to before it is paid", () => {
    expect(cardLineFor("paid", card())).toEqual({ label: "Paid to", card: { last4: "4417", status: "active" } });
    expect(cardLineFor("paid", card({ status: "closed" }))).toEqual({
      label: "Paid to",
      card: { last4: "4417", status: "closed" },
    });
    expect(cardLineFor("approved", card())).toEqual({ label: "Pays to", card: { last4: "4417", status: "active" } });
  });

  it("calls the driver's active card the card on file when a paid advance recorded none", () => {
    expect(cardLineFor("paid", card({ recorded: false }))).toEqual({
      label: "Card on file",
      card: { last4: "4417", status: "active" },
    });
  });

  it("calls the driver's active card the card on file when a pending advance recorded none", () => {
    expect(cardLineFor("requested", card({ recorded: false }))).toEqual({
      label: "Card on file",
      card: { last4: "4417", status: "active" },
    });
    expect(cardLineFor("approved", card({ recorded: false }))).toEqual({
      label: "Card on file",
      card: { last4: "4417", status: "active" },
    });
  });

  it("shows no card line for a paid advance with no card, and no card on file before it is paid", () => {
    expect(cardLineFor("paid", null)).toBeNull();
    expect(cardLineFor("requested", null)).toEqual({ label: "Pays to", card: null });
  });

  describe("when the recorded card has since closed", () => {
    const closed: CardSummary = { last4: "4417", status: "closed" };
    const active: CardSummary = { last4: "9020", status: "active" };
    const line = (status: string, recorded: CardSummary | null, now: CardSummary | null) =>
      cardLineFor(status, recordCardFor(status, recorded, now));

    it("shows an unpaid advance the driver's active card as the card on file, since a retry pays it", () => {
      expect(line("approved", closed, active)).toEqual({ label: "Card on file", card: active });
    });

    it("says an unpaid advance has no fuel card on file when no card is active", () => {
      expect(line("approved", closed, null)).toEqual({ label: "Pays to", card: null });
    });

    it("keeps Paid to the recorded card on a paid advance, closed or not", () => {
      expect(line("paid", closed, active)).toEqual({ label: "Paid to", card: closed });
      expect(line("paid", closed, null)).toEqual({ label: "Paid to", card: closed });
    });

    it("keeps Pays to the recorded card on an unpaid advance while it is still active", () => {
      expect(line("approved", active, active)).toEqual({ label: "Pays to", card: active });
    });
  });
});

describe("the advance list's card line", () => {
  const closed = { last4: "4417", status: "closed" };
  const active = { last4: "9020", status: "active" };

  it("names the card a paid advance was paid to, even after that card closed", () => {
    expect(listCardLineFor("paid", closed, active)).toEqual({ label: "Paid to", card: closed });
    expect(listCardLineFor("paid", closed, null)).toEqual({ label: "Paid to", card: closed });
    expect(listCardLineFor("paid", active, active)).toEqual({ label: "Paid to", card: active });
  });

  it("names no card for a paid advance that recorded none, never the driver's card now", () => {
    expect(listCardLineFor("paid", null, active)).toBeNull();
    expect(listCardLineFor("paid", null, null)).toBeNull();
  });

  it("names the driver's active card as the card on file for an unpaid advance that recorded none", () => {
    expect(listCardLineFor("requested", null, active)).toEqual({ label: "Card on file", card: active });
    expect(listCardLineFor("approved", null, active)).toEqual({ label: "Card on file", card: active });
  });

  it("names an unpaid advance's recorded card while it is active, else the card on file", () => {
    expect(listCardLineFor("approved", active, active)).toEqual({ label: "Pays to", card: active });
    expect(listCardLineFor("approved", closed, active)).toEqual({ label: "Card on file", card: active });
  });

  it("shows no line when no card would be named", () => {
    expect(listCardLineFor("requested", null, null)).toBeNull();
    expect(listCardLineFor("approved", closed, null)).toBeNull();
  });

  it("names nothing when the recorded card has any other shape, and never puts the active card in its place", () => {
    expect(listCardLineFor("paid", { last4: "12a4", status: "closed" }, active)).toBeNull();
    expect(listCardLineFor("approved", { last4: "4417", status: "lost" }, active)).toBeNull();
    expect(listCardLineFor("requested", null, { last4: "", status: "active" })).toBeNull();
  });
});

describe("a card line for an advance that is never paid", () => {
  const closed: CardSummary = { last4: "4417", status: "closed" };
  const active: CardSummary = { last4: "9020", status: "active" };

  for (const status of ["rejected", "cancelled"]) {
    it(`names no card for a ${status} advance, recorded or on file`, () => {
      expect(recordCardFor(status, active, active)).toBeNull();
      expect(recordCardFor(status, closed, active)).toBeNull();
      expect(recordCardFor(status, null, active)).toBeNull();
      expect(cardLineFor(status, { ...active, recorded: true })).toBeNull();
      expect(cardLineFor(status, { ...active, recorded: false })).toBeNull();
      expect(cardLineFor(status, null)).toBeNull();
      expect(listCardLineFor(status, active, active)).toBeNull();
      expect(listCardLineFor(status, closed, active)).toBeNull();
      expect(listCardLineFor(status, null, active)).toBeNull();
    });
  }

  it("names no card for a status it does not know", () => {
    expect(recordCardFor("refunded", active, active)).toBeNull();
    expect(cardLineFor("refunded", { ...active, recorded: true })).toBeNull();
    expect(cardLineFor("refunded", null)).toBeNull();
    expect(listCardLineFor("refunded", null, active)).toBeNull();
  });

  it("names a card only for an advance that can still be paid or was paid, across every advance status", () => {
    const naming = SUBJECT_STATUSES.advances.filter((status) => listCardLineFor(status, active, active) !== null);
    expect(naming).toEqual(["requested", "approved", "paid"]);
    const recordNaming = SUBJECT_STATUSES.advances.filter(
      (status) => cardLineFor(status, recordCardFor(status, active, active)) !== null,
    );
    expect(recordNaming).toEqual(["requested", "approved", "paid"]);
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
    expect(calls.open[0]).toMatchObject({ conversationId: null, turnId, text: calls.run[0], readNotes: true });
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
