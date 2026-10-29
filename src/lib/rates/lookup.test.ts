import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiRequest, type AiResult, type AiWebAnswer } from "../ai";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { lookupRate, type LookupComplete } from "./lookup";

const SESSION: Session = { sub: "sub-staff", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const MEMBER = "33333333-3333-4333-8333-333333333333";
const CALL = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-27T15:00:00Z");
const DIESEL = "https://rates.example/diesel/weekly";

// A carrier's database as the lookup sees it: the member row, the lock, the day's count and the
// one insert, each step recorded in order.
function fakeDb(opts: { member?: boolean; used?: number; insertThrows?: boolean } = {}) {
  const steps: string[] = [];
  const inserted: Param[][] = [];
  const q: Queryable = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM memberships")) {
        steps.push("member");
        return (opts.member === false ? [] : [{ id: MEMBER, role: "staff" }]) as T[];
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        steps.push("lock");
        return [{ n: 1 }] as T[];
      }
      if (sql.includes("FROM model_calls")) {
        steps.push("count");
        return [{ n: String(opts.used ?? 0) }] as T[];
      }
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      if (!sql.includes("INSERT INTO pinned_rates")) throw new Error("unexpected statement");
      steps.push("insert");
      if (opts.insertThrows) throw new Error("connection reset with secret detail");
      inserted.push(params);
      return 1;
    },
  };
  const db: TenantDb = {
    async withTenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
      steps.push(`tenant ${tenantId === SESSION.tenantId ? "ok" : "wrong"}`);
      return fn(q);
    },
  };
  return { db, steps, inserted };
}

function answer(web: AiWebAnswer | undefined, status: AiResult["status"] = "ok"): AiResult {
  return {
    callId: CALL,
    status,
    text: web?.answerText ?? "",
    toolCalls: [],
    usage: { input: 2000, cached: 0, output: 300, reasoning: 200 },
    costNanocents: 700_000_000,
    upstreamId: "resp_1",
    replay: [],
    toolSearches: 0,
    ...(web ? { web } : {}),
  };
}

const FOUND: AiWebAnswer = {
  answerText: `3.712 dollars a gallon for the week of October 26, 2026, from ${DIESEL}`,
  citations: [],
  searchResults: [{ url: DIESEL, title: "Diesel averaged $3.712 for the week of Oct. 26, 2026", snippet: "" }],
  searchCalls: 1,
};

function fakeComplete(result: AiResult | Error) {
  const seen: AiRequest[] = [];
  const fn = vi.fn<LookupComplete>(async (_target, request) => {
    seen.push(request);
    if (result instanceof Error) throw result;
    return result;
  });
  return { fn, seen };
}

beforeEach(() => {
  flags.groundedRatesEnabled = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  flags.groundedRatesEnabled = false;
  vi.restoreAllMocks();
});

describe("lookupRate", () => {
  it("does nothing at all while the switch is off", async () => {
    flags.groundedRatesEnabled = false;
    const { db, steps } = fakeDb();
    const call = fakeComplete(answer(FOUND));
    expect(await lookupRate(SESSION, { kind: "diesel_index" }, { db, complete: call.fn, clock: () => NOW })).toEqual({
      ok: false,
      refused: "off",
    });
    expect(steps).toEqual([]);
    expect(call.fn).not.toHaveBeenCalled();
  });

  it("refuses a kind or state it does not know before reading anything", async () => {
    for (const input of [
      { kind: "gasoline" },
      { kind: "diesel_index", state: "IL" },
      { kind: "ifta_rate" },
      { kind: "ifta_rate", state: "ZZ" },
      { kind: "ifta_rate", state: "il" },
      { kind: 7 },
    ]) {
      const { db, steps } = fakeDb();
      expect(await lookupRate(SESSION, input, { db, complete: fakeComplete(answer(FOUND)).fn })).toEqual({
        ok: false,
        refused: "bad_request",
      });
      expect(steps).toEqual([]);
    }
  });

  it("refuses someone who is not staff of this carrier, and a carrier past its day's lookups", async () => {
    const stranger = fakeDb({ member: false });
    const call = fakeComplete(answer(FOUND));
    expect(await lookupRate(SESSION, { kind: "diesel_index" }, { db: stranger.db, complete: call.fn })).toEqual({
      ok: false,
      refused: "forbidden",
    });
    const full = fakeDb({ used: 20 });
    expect(
      await lookupRate(SESSION, { kind: "diesel_index" }, { db: full.db, complete: call.fn, clock: () => NOW }),
    ).toEqual({ ok: false, refused: "limit" });
    expect(full.steps).toEqual(["tenant ok", "member", "lock", "count"]);
    expect(call.fn).not.toHaveBeenCalled();
  });

  it("asks for one capped Muse Spark answer with web search, then keeps a suggestion with its page", async () => {
    const { db, steps, inserted } = fakeDb({ used: 19 });
    const call = fakeComplete(answer(FOUND));
    const out = await lookupRate(SESSION, { kind: "diesel_index", state: null }, { db, complete: call.fn, clock: () => NOW });
    expect(out).toMatchObject({ ok: true, status: "suggested" });
    expect(steps).toEqual(["tenant ok", "member", "lock", "count", "tenant ok", "insert"]);
    const [request] = call.seen;
    expect(call.fn.mock.calls[0][0]).toBe("spark");
    expect(request).toMatchObject({
      purpose: "rate_lookup",
      maxCostCents: 5,
      webSearch: { maxCalls: 2, contextSize: "low" },
      reasoningEffort: "low",
      maxOutputTokens: 1500,
    });
    expect(request).not.toHaveProperty("tools");
    const [row] = inserted;
    expect(row.slice(1, 10)).toEqual([
      "diesel_index",
      null,
      "suggested",
      371_200,
      DIESEL,
      "Diesel averaged $3.712 for the week of Oct. 26, 2026",
      "Diesel averaged $3.712 for the week of Oct. 26, 2026",
      "2026-10-26",
      CALL,
    ]);
    expect(row[11]).toBe(MEMBER);
    expect(out.ok && row[0]).toBe(out.ok ? out.id : null);
  });

  it("keeps an unconfirmed lookup with its page and no number", async () => {
    const { db, inserted } = fakeDb();
    const call = fakeComplete(answer({ ...FOUND, answerText: `3.719 a gallon, from ${DIESEL}` }));
    const out = await lookupRate(SESSION, { kind: "diesel_index" }, { db, complete: call.fn, clock: () => NOW });
    expect(out).toMatchObject({ ok: true, status: "unconfirmed" });
    expect(inserted[0].slice(3, 9)).toEqual(["unconfirmed", null, DIESEL, FOUND.searchResults[0].title, null, null]);
  });

  it("never keeps a figure from a page the answer did not cite", async () => {
    const { db, steps } = fakeDb();
    const call = fakeComplete(answer({ ...FOUND, answerText: "3.712 dollars a gallon for the week of October 26, 2026." }));
    const out = await lookupRate(SESSION, { kind: "diesel_index" }, { db, complete: call.fn, clock: () => NOW });
    expect(out).toEqual({ ok: false, failed: "no_source" });
    expect(steps).not.toContain("insert");
  });

  it("asks for a state's fuel tax rate by the state's name", async () => {
    const { db } = fakeDb();
    const call = fakeComplete(answer(undefined));
    await lookupRate(SESSION, { kind: "ifta_rate", state: "IN" }, { db, complete: call.fn, clock: () => NOW });
    expect(call.seen[0].messages[0].content).toContain("Indiana");
  });

  it("reads a page with no usable figure as no source, and keeps nothing", async () => {
    for (const web of [
      { ...FOUND, searchResults: [] },
      { ...FOUND, answerText: "I could not find it." },
      { ...FOUND, answerText: "3.719 a gallon, from https://rates.example/made-up" },
    ]) {
      const { db, steps } = fakeDb();
      const out = await lookupRate(SESSION, { kind: "diesel_index" }, { db, complete: fakeComplete(answer(web)).fn });
      expect(out).toEqual({ ok: false, failed: "no_source" });
      expect(steps).not.toContain("insert");
    }
  });

  it("never reads an answer cut short, or one without its web part, as a rate", async () => {
    for (const result of [answer(FOUND, "incomplete"), answer(undefined)]) {
      const { db, steps } = fakeDb();
      const out = await lookupRate(SESSION, { kind: "diesel_index" }, { db, complete: fakeComplete(result).fn });
      expect(out).toEqual({ ok: false, failed: "failed" });
      expect(steps).not.toContain("insert");
    }
  });

  it("maps a refused or failed model call to a category, never its text", async () => {
    const cases: [Error, string][] = [
      [new AiError("cap"), "budget"],
      [new AiError("too_expensive"), "budget"],
      [new AiError("disabled"), "budget"],
      [new AiError("timeout"), "failed"],
      [new AiError("unknown", 502), "failed"],
      [new Error("socket hang up with secret detail"), "failed"],
    ];
    for (const [err, category] of cases) {
      const { db, steps } = fakeDb();
      const out = await lookupRate(SESSION, { kind: "diesel_index" }, { db, complete: fakeComplete(err).fn });
      expect(out).toEqual({ ok: false, failed: category });
      expect(steps).not.toContain("insert");
    }
    const logged = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logged).not.toContain("secret detail");
  });

  it("fails closed when the suggestion cannot be kept, and logs no error text", async () => {
    const { db } = fakeDb({ insertThrows: true });
    const out = await lookupRate(SESSION, { kind: "diesel_index" }, { db, complete: fakeComplete(answer(FOUND)).fn });
    expect(out).toEqual({ ok: false, failed: "failed" });
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain("secret detail");
  });

  it("checks the switch again right before the outside call", async () => {
    const { db } = fakeDb();
    const call = fakeComplete(answer(FOUND));
    const wrapped: TenantDb = {
      async withTenant(tenantId, fn) {
        const out = await db.withTenant(tenantId, fn);
        flags.groundedRatesEnabled = false;
        return out;
      },
    };
    expect(await lookupRate(SESSION, { kind: "diesel_index" }, { db: wrapped, complete: call.fn })).toEqual({
      ok: false,
      refused: "off",
    });
    expect(call.fn).not.toHaveBeenCalled();
  });
});
