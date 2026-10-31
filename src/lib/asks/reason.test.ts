import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { checkReason, fillReasons, writeReason, type ReasonCompleteFn } from "./reason";
import type { ReasonCandidate } from "./store";

// The reason line beside a question: a sentence naming any number but the engine's amount and a
// percent is dropped (digits or words, with or without a dollar sign) and the engine's own is
// kept; the one call goes through the wrapper with the ask reason caller's own caps; a failed
// call, a cut answer or a bad answer gives a category only; a cached reason is reused only when it
// passes this ask's check.

const SESSION: Session = { sub: "service:sweep:t", email: "", tenantId: "33333333-3333-4333-8333-333333333333" };
const CANDIDATE: ReasonCandidate & { traceId: string } = {
  id: "44444444-4444-4444-8444-444444444444",
  proposalKind: "advance_payout",
  amountCents: 140_000,
  text: "Should I send Dana Reyes an advance of $1,400.00?",
  reasons: ["paperwork_complete"],
  sources: ["loads"],
  dedupeKey: "advance_payout:x",
  traceId: "55555555-5555-4555-8555-555555555555",
};

const result = (text: string, status: AiResult["status"] = "ok"): AiResult => ({
  callId: "66666666-6666-4666-8666-666666666666",
  status,
  text,
  toolCalls: [],
  usage: { input: 10, cached: 0, output: 10, reasoning: 0 },
  costNanocents: 1,
  upstreamId: null,
  replay: [],
  toolSearches: 0,
});

const saved = structuredClone(flags.agentAsks);
beforeEach(() => {
  // The reason pass runs only with the questions on; each test starts with them on.
  flags.agentAsks.enabled = true;
});
afterEach(() => {
  Object.assign(flags.agentAsks, structuredClone(saved));
});

describe("checkReason", () => {
  it("keeps a sentence with the engine's figure or none", () => {
    expect(checkReason("The rate confirmation and the bill of lading are both in.", 140_000)).toEqual({
      ok: true,
      text: "The rate confirmation and the bill of lading are both in.",
    });
    expect(checkReason("  Paperwork is in, so the $1,400.00   advance is due. ", 140_000)).toEqual({
      ok: true,
      text: "Paperwork is in, so the $1,400.00 advance is due.",
    });
  });

  it("drops a sentence with any other figure", () => {
    expect(checkReason("The advance is $1,500.00 under the rule.", 140_000)).toEqual({ ok: false, category: "figures" });
    expect(checkReason("That is $1,400.00 plus a $35.00 fee.", 140_000)).toEqual({ ok: false, category: "figures" });
    expect(checkReason("That leaves 1,250.00 owed.", 140_000)).toEqual({ ok: false, category: "figures" });
    expect(checkReason("That leaves 54.20 owed.", 140_000)).toEqual({ ok: false, category: "figures" });
  });

  it("drops an amount with no dollar sign, in digits or in words", () => {
    for (const line of [
      "The advance is 1,400 dollars.",
      "That comes to about 1500 for the load.",
      "The advance is USD 1400.",
      "The advance is fifteen hundred dollars.",
      "That leaves 1,250 of trip pay.",
      "The rule allows two grand here.",
      "That leaves a twenty dollar fee.",
      "The advance is fifteen dollars more.",
      "The rule allows one dollar more.",
      "That is a thousand under the cap.",
    ]) {
      expect(checkReason(line, 140_000), line).toEqual({ ok: false, category: "figures" });
    }
  });

  it("keeps a word that only holds a number word inside it", () => {
    expect(checkReason("Someone sent the paperwork, so anyone can see the $1,400.00 advance is due.", 140_000)).toMatchObject({ ok: true });
  });

  it("keeps the engine's exact amount beside a percent", () => {
    expect(checkReason("The paperwork is in, so the $1,400.00 advance at 70% is due.", 140_000)).toEqual({
      ok: true,
      text: "The paperwork is in, so the $1,400.00 advance at 70% is due.",
    });
  });

  it("drops an empty or long sentence", () => {
    expect(checkReason("   ", 140_000)).toEqual({ ok: false, category: "empty" });
    expect(checkReason("a".repeat(201), 140_000)).toEqual({ ok: false, category: "too_long" });
  });
});

describe("writeReason", () => {
  it("makes one capped ask_reason call and keeps a right answer", async () => {
    const complete = vi.fn<ReasonCompleteFn>(async () => result('{"reason":"All paperwork for the load is in."}'));
    const r = await writeReason(SESSION, CANDIDATE, { complete });
    expect(r).toEqual({ ok: true, text: "All paperwork for the load is in.", callId: "66666666-6666-4666-8666-666666666666" });
    expect(complete).toHaveBeenCalledTimes(1);
    const [target, request, session] = complete.mock.calls[0] as [string, AiRequest, Session];
    expect(target).toBe("spark");
    expect(session).toBe(SESSION);
    expect(request).toMatchObject({
      purpose: "ask_reason",
      maxCostCents: 2,
      maxOutputTokens: 80,
      traceId: CANDIDATE.traceId,
    });
    const facts = JSON.parse(String(request.messages?.at(-1)?.content));
    expect(facts).toMatchObject({ question: CANDIDATE.text, action: "an advance", amount: "$1,400.00", records: ["loads"] });
  });

  it("drops an answer with a wrong figure", async () => {
    const complete: ReasonCompleteFn = async () => result('{"reason":"The rule allows $1,500.00 for this load."}');
    expect(await writeReason(SESSION, CANDIDATE, { complete })).toEqual({ ok: false, category: "figures" });
  });

  it("gives a category for a cut answer, a bad answer and a failed call", async () => {
    expect(await writeReason(SESSION, CANDIDATE, { complete: async () => result("", "incomplete") })).toEqual({
      ok: false,
      category: "incomplete",
    });
    expect(await writeReason(SESSION, CANDIDATE, { complete: async () => result("not json") })).toEqual({
      ok: false,
      category: "bad_answer",
    });
    expect(await writeReason(SESSION, CANDIDATE, { complete: async () => result('{"reason":7}') })).toEqual({
      ok: false,
      category: "bad_answer",
    });
    const timeout: ReasonCompleteFn = async () => {
      throw new AiError("timeout");
    };
    expect(await writeReason(SESSION, CANDIDATE, { complete: timeout })).toEqual({ ok: false, category: "timeout" });
    const raw: ReasonCompleteFn = async () => {
      throw new Error("socket to model-host.example closed");
    };
    expect(await writeReason(SESSION, CANDIDATE, { complete: raw })).toEqual({ ok: false, category: "unknown" });
  });
});

// The desk's reason pass over a fake database: the store's own SQL is answered by text, and the
// membership read passes.
function passDb(cached: string | null) {
  const writes: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("a.reason_call_id IS NULL")) {
        return [
          {
            id: CANDIDATE.id,
            proposal_kind: CANDIDATE.proposalKind,
            amount_cents: String(CANDIDATE.amountCents),
            text: CANDIDATE.text,
            reasons: JSON.stringify([{ category: "paperwork_complete" }]),
            sources: JSON.stringify([{ table: "loads" }]),
            dedupe_key: CANDIDATE.dedupeKey,
          },
        ] as T[];
      }
      if (sql.includes("SELECT a.reason FROM agent_asks")) return (cached === null ? [] : [{ reason: cached }]) as T[];
      throw new Error("unexpected read");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      writes.push({ sql, params });
      return 1;
    },
  };
  const db: TenantDb = { withTenant: async (_t, fn) => fn(q) };
  return { db, writes };
}

describe("fillReasons", () => {
  const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
  const deps = (db: TenantDb, complete: ReasonCompleteFn) => ({
    db,
    complete,
    clock: () => new Date(NOW),
    newId: () => CANDIDATE.traceId,
    log: () => {},
  });

  it("reuses a cached reason that passes this ask's check, with no call", async () => {
    const { db, writes } = passDb("The paperwork is in, so the $1,400.00 advance is due.");
    const complete = vi.fn<ReasonCompleteFn>(async () => result('{"reason":"unused"}'));
    expect(await fillReasons(SESSION, NOW + 60_000, deps(db, complete))).toEqual({ tried: 0, kept: 0 });
    expect(complete).not.toHaveBeenCalled();
    expect(writes.map((w) => w.params.at(-1))).toEqual([CANDIDATE.traceId, "The paperwork is in, so the $1,400.00 advance is due."]);
  });

  it("treats a cached reason with another amount as none and makes the one call", async () => {
    const { db, writes } = passDb("The paperwork is in, so the $950.00 advance is due.");
    const complete = vi.fn<ReasonCompleteFn>(async () => result('{"reason":"All paperwork for the load is in."}'));
    expect(await fillReasons(SESSION, NOW + 60_000, deps(db, complete))).toEqual({ tried: 1, kept: 1 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(writes.map((w) => w.params.at(-1))).toEqual([CANDIDATE.traceId, "All paperwork for the load is in."]);
  });
});
