import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompleteFn } from "../agent/gateway/types";
import { AiError, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import type { BreakView, RunView } from "../data/card-recon";
import type { Candidate, MatchTxn } from "../rules-engine/card-recon";
import { allowedCents, checkSentence, explainBreak } from "./explain";
import { pickDriver } from "./match";
import { breakSentence, fixOf, gallons, resultLine, severityOf, statusOf, uncheckedLines, whatLine } from "./view";
import { fixedSentence, lineWords, money } from "./words";

// The card check's two model calls with the call itself a stand-in (no network, no spend), and
// the words its pages show. A sentence keeps only the difference's own figures; a pick is one of
// the drivers code ranked, or nothing.

const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };

function answer(text: string, over: Partial<AiResult> = {}): AiResult {
  return {
    callId: "call-1",
    status: "ok",
    text,
    toolCalls: [],
    usage: { input: 100, cached: 0, output: 20, reasoning: 0 },
    costNanocents: 1_000_000,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
    ...over,
  };
}

function stub(result: AiResult | Error) {
  const calls: AiRequest[] = [];
  const fn: CompleteFn = async (_t, request) => {
    calls.push(request);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fn, calls };
}

const EXPLAIN = {
  traceId: "run-1",
  category: "fuel_amount_differs",
  record: "card ending 4417",
  outsideSystem: "fuel_card_sim",
  ourCents: 41_250,
  outsideCents: 41_590,
  maxCostCents: 3,
};

afterEach(() => vi.restoreAllMocks());

describe("one sentence per difference", () => {
  it("keeps a sentence that names only the difference's own amounts and the gap", async () => {
    const s = stub(answer(JSON.stringify({ sentence: "The card provider shows $415.90 but we recorded $412.50, $3.40 apart." })));
    const out = await explainBreak(SESSION, EXPLAIN, { complete: s.fn });
    expect(out).toMatchObject({ ok: true, callId: "call-1", costNanocents: 1_000_000 });
    expect(s.calls[0]).toMatchObject({ purpose: "card_recon_explain", maxCostCents: 3, traceId: "run-1", maxOutputTokens: 120 });
  });

  it("drops a sentence with any other figure, written with or without a dollar sign", async () => {
    for (const sentence of ["We recorded $412.00 instead.", "The gap is 3.41 on this card.", "We recorded 1,250.00."]) {
      const out = await explainBreak(SESSION, EXPLAIN, { complete: stub(answer(JSON.stringify({ sentence }))).fn });
      expect(out, sentence).toMatchObject({ ok: false, category: "figures", callId: "call-1" });
    }
  });

  it("answers a category for a bad, cut-short or failed answer, never the error's text", async () => {
    expect(await explainBreak(SESSION, EXPLAIN, { complete: stub(answer("not json")).fn })).toMatchObject({
      ok: false,
      category: "bad_answer",
    });
    expect(await explainBreak(SESSION, EXPLAIN, { complete: stub(answer("", { status: "incomplete" })).fn })).toMatchObject({
      ok: false,
      category: "incomplete",
    });
    expect(await explainBreak(SESSION, EXPLAIN, { complete: stub(new AiError("timeout")).fn })).toEqual({
      ok: false,
      category: "timeout",
      callId: null,
      costNanocents: null,
    });
    const leaked = await explainBreak(SESSION, EXPLAIN, { complete: stub(new Error("card 4417 secret text")).fn });
    expect(leaked).toEqual({ ok: false, category: "unknown", callId: null, costNanocents: null });
  });

  it("allows ours, theirs and the gap only, and refuses an empty or too long sentence", () => {
    expect(allowedCents(41_250, 41_590).sort((a, b) => a - b)).toEqual([340, 41_250, 41_590]);
    expect(allowedCents(null, 15_000)).toEqual([15_000]);
    expect(checkSentence("   ", [1])).toEqual({ ok: false, category: "empty" });
    expect(checkSentence("x".repeat(301), [1])).toEqual({ ok: false, category: "too_long" });
    expect(checkSentence("  Ours   is $1.00. ", [100])).toEqual({ ok: true, text: "Ours is $1.00." });
  });
});

describe("a pick for a card on no one's file", () => {
  const TXN: MatchTxn = {
    id: "t-9",
    providerRef: "ref-9",
    last4: "7781",
    portalName: "POOL CARD 7",
    postedOn: "2026-10-20",
    state: "OK",
    amountCents: 21_240,
    gallonsMilli: 52_850,
  };
  const cand = (driverId: string, code: string, score: number): Candidate => ({
    driverId,
    code,
    score,
    reasons: ["worked_that_day"],
    evidence: [{ day: "2026-10-20", loadId: null }],
  });
  const CLEAR = [cand("d1", "BR-D07", 3), cand("d2", "BR-D12", 2)];
  const input = (candidates: Candidate[]) => ({ traceId: "run-1", txn: TXN, candidates, maxCostCents: 3 });

  it("takes a code that is exactly one ranked driver's, and offers only the ranked codes", async () => {
    const s = stub(answer(JSON.stringify({ driverCode: "BR-D07", reasons: ["worked_that_day"] })));
    expect(await pickDriver(SESSION, input(CLEAR), { complete: s.fn })).toMatchObject({ ok: true, driverId: "d1" });
    const req = s.calls[0];
    expect(req).toMatchObject({ purpose: "card_recon_match", maxCostCents: 3, traceId: "run-1" });
    const schema = (req.format as unknown as { schema: { properties: { driverCode: { enum: string[] } } } }).schema;
    expect(schema.properties.driverCode.enum).toEqual(["BR-D07", "BR-D12", "NONE"]);
  });

  it("makes no call with no candidate or a tie at the top", async () => {
    const s = stub(answer("{}"));
    expect(await pickDriver(SESSION, input([]), { complete: s.fn })).toMatchObject({ ok: false, category: "no_candidates" });
    const tied = [cand("d1", "BR-D07", 3), cand("d2", "BR-D12", 3)];
    expect(await pickDriver(SESSION, input(tied), { complete: s.fn })).toMatchObject({ ok: false, category: "tied" });
    expect(s.calls).toEqual([]);
  });

  it("refuses a code it did not rank, a part of one, NONE and a bad answer", async () => {
    const pick = async (text: string) => pickDriver(SESSION, input(CLEAR), { complete: stub(answer(text)).fn });
    expect(await pick(JSON.stringify({ driverCode: "BR-D99", reasons: [] }))).toMatchObject({ ok: false, category: "not_candidate" });
    expect(await pick(JSON.stringify({ driverCode: "BR-D0", reasons: [] }))).toMatchObject({ ok: false, category: "not_candidate" });
    expect(await pick(JSON.stringify({ driverCode: "NONE", reasons: [] }))).toMatchObject({ ok: false, category: "no_pick" });
    expect(await pick("nope")).toMatchObject({ ok: false, category: "bad_answer" });
  });
});

describe("the words a difference shows", () => {
  const brk = (over: Partial<BreakView> = {}): BreakView => ({
    id: "b-1",
    category: "fuel_amount_differs",
    severity: "medium",
    outsideSystem: "fuel_card_sim",
    fixKind: "by_hand",
    status: "open",
    dismissCategory: null,
    ourCents: 41_250,
    outsideCents: 41_590,
    explanation: null,
    proposalId: null,
    transaction: {
      id: "t-1",
      kind: "fuel",
      last4: "4417",
      portalName: "BR-D07",
      postedOn: "2026-10-30",
      state: "OK",
      gallonsMilli: 112_400,
      amountCents: 41_590,
    },
    record: null,
    purchaseId: "p-1",
    driver: null,
    firstSeenAt: "2026-10-30T15:00:00.000Z",
    updatedAt: "2026-10-30T15:00:00.000Z",
    ...over,
  });

  it("says what it is about and why, from code when there is no checked sentence", () => {
    expect(whatLine(brk())).toBe("Fuel $415.90 on card ending 4417, Oct 30, 2026, OK");
    expect(breakSentence(brk())).toBe("Fuel amount differs on card ending 4417: ours $412.50, theirs $415.90.");
    expect(breakSentence(brk({ explanation: "A checked sentence." }))).toBe("A checked sentence.");
    const record = { id: "m-1", kind: "advance_payout", subjectTable: "advances", subjectId: "a-1", state: "confirmed" };
    expect(whatLine(brk({ transaction: null, record }))).toBe("Advance payout");
    expect(whatLine(brk({ transaction: null, record: null }))).toBe("A payment record");
  });

  it("gives each state and severity one label and tone", () => {
    expect(statusOf(brk({ status: "resolved" }))).toEqual({ label: "Fixed", tone: "success" });
    expect(statusOf(brk({ status: "dismissed", dismissCategory: "duplicate" }))).toEqual({ label: "Dismissed: Duplicate", tone: "neutral" });
    expect(statusOf(brk({ fixKind: "check_pending" }))).toEqual({ label: "Not confirmed yet", tone: "info" });
    expect(statusOf(brk())).toEqual({ label: "Needs you", tone: "warning" });
    expect(severityOf({ severity: "high" }).tone).toBe("destructive");
    expect(severityOf({ severity: "unexpected" as never }).label).toBe("Low");
  });

  it("offers a match only when there is one to approve", () => {
    expect(fixOf({ fixKind: "card_match", proposalId: "p-1" })).toBe("Approve the match");
    expect(fixOf({ fixKind: "card_match", proposalId: null })).toBe("By hand");
    expect(fixOf({ fixKind: "made_up" as never, proposalId: null })).toBe("By hand");
  });

  it("writes gallons and money with whole-number math", () => {
    expect(gallons(112_400)).toBe("112.400");
    expect(gallons(5)).toBe("0.005");
    expect(gallons(null)).toBeNull();
    expect(gallons(1.5)).toBeNull();
    expect(money(123_456)).toBe("$1,234.56");
    expect(money(-5)).toBe("-$0.05");
    expect(money(null)).toBe("none");
    expect(fixedSentence({ category: "made_up", record: "a payment record", ourCents: null, outsideCents: 100 })).toBe(
      "Difference on a payment record: ours none, theirs $1.00.",
    );
  });

  it("sums a check up in one line and names each system it could not read once", () => {
    const run: RunView = {
      id: "r-1",
      status: "done",
      phase: "done",
      failCategory: null,
      windowFrom: "2026-10-16",
      windowTo: "2026-10-30",
      counts: { statement: 1, records: 2, needsYou: 1 },
      unchecked: [
        { system: "payment:bank", category: "not_connected" },
        { system: "payment:bank", category: "not_connected" },
        { system: "accounting", category: "made_up" },
        "junk",
      ],
      modelCents: 0,
      startedAt: "2026-10-30T15:00:00.000Z",
      finishedAt: "2026-10-30T15:01:00.000Z",
    };
    expect(resultLine(run)).toBe("Checked 1 card transaction and 2 payment records. 1 needs you.");
    expect(resultLine({ ...run, counts: { statement: 2, records: 1, needsYou: 0 } })).toBe(
      "Checked 2 card transactions and 1 payment record. Nothing needs you.",
    );
    expect(resultLine({ ...run, status: "running" })).toBe("A check is running now.");
    expect(uncheckedLines(run)).toEqual([
      "Bank: not connected in this demo.",
      "QuickBooks: could not be read this time; nothing it found before was closed.",
    ]);
    expect(lineWords({ system: "made_up", category: "timeout" })).toBe(
      "Another system: did not answer in time; nothing it found before was closed.",
    );
    // Past the per-system cap the same oldest records are read again next time: no promise of more.
    expect(lineWords({ system: "payment:bank", category: "over_limit" })).toBe(
      "Bank: more records than one check reads; the oldest were read and the rest were not checked.",
    );
  });
});
