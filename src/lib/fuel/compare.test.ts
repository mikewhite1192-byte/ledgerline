import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiResult } from "../ai";
import type { FetchFn } from "../ai/providers/http";
import { QUIET_JOB } from "../ai/test-fixtures";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { COMPARE_PURPOSE, compareReceipts, parseCompare, type CompareComplete, type ComparePhoto } from "./compare";

// The receipt compare with the model a stand-in: a clean strict answer is a verdict, anything else
// is unknown with a category, and the switch is read at the call itself. No network.

const SESSION: Session = { sub: "sub-test", email: "ops@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const PHOTOS: readonly [ComparePhoto, ComparePhoto] = [
  { id: "a", mime: "image/webp", bytes: new Uint8Array([1, 2, 3]) },
  { id: "b", mime: "image/jpeg", bytes: new Uint8Array([4, 5, 6]) },
];
const INPUT = { findingId: "finding-1", photos: PHOTOS, traceId: "2f7c4b1e-8a3d-4c5e-9f6a-1b2c3d4e5f60" };
const saved = { ...flags };

// A ledger stand-in for the real wrapper: membership, an empty spend total, a quiet spend watch
// (answered before model_calls, which it reads too), and the reserve it was asked for.
function ledger(seen: { reserved: number; purpose: unknown; trace: unknown }): TenantDb {
  let reserved = 0;
  const q: Queryable = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("FROM ops.ai_spend")) {
        return [
          { spent_nanocents: 0, reserved_nanocents: 0, calls: 0, wonder_spent_nanocents: 0, wonder_reserved_nanocents: 0 },
        ] as T[];
      }
      if (sql.includes("FROM spend_alerts")) return [QUIET_JOB] as T[];
      if (sql.includes("FROM model_calls")) return [{ reserved_nanocents: reserved, target: "spark" }] as T[];
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      if (sql.startsWith("INSERT INTO model_calls")) {
        reserved = Number(params[8]);
        seen.reserved = reserved;
        seen.purpose = params[5];
        seen.trace = params[7];
      }
      return 1;
    },
  };
  return { withTenant: async (_tenantId, fn) => fn(q) };
}

function answer(text: string, extra: Partial<AiResult> = {}): AiResult {
  return {
    callId: "call-1",
    status: "ok",
    text,
    toolCalls: [],
    usage: { input: 900, cached: 0, output: 20, reasoning: 0 },
    costNanocents: 41_000_000,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
    ...extra,
  };
}

beforeEach(() => {
  flags.fuelAnomalyEnabled = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  Object.assign(flags, saved);
  vi.restoreAllMocks();
});

describe("parseCompare", () => {
  it("takes a whole strict answer", () => {
    expect(parseCompare('{"same_receipt":true,"confidence":"high","differs_in":[]}')).toEqual({ same: true, confidence: "high" });
    expect(parseCompare('{"same_receipt":false,"confidence":"medium","differs_in":["time","pump"]}')).toEqual({
      same: false,
      confidence: "medium",
    });
  });

  it.each([
    ["not json", "same"],
    ["an array", "[]"],
    ["a missing key", '{"same_receipt":true,"confidence":"high"}'],
    ["an extra key", '{"same_receipt":true,"confidence":"high","differs_in":[],"note":"x"}'],
    ["a string verdict", '{"same_receipt":"yes","confidence":"high","differs_in":[]}'],
    ["a confidence outside the list", '{"same_receipt":true,"confidence":"certain","differs_in":[]}'],
    ["a difference outside the list", '{"same_receipt":false,"confidence":"low","differs_in":["color"]}'],
    ["a repeated difference", '{"same_receipt":false,"confidence":"low","differs_in":["time","time"]}'],
  ])("refuses %s", (_name, text) => {
    expect(parseCompare(text)).toBeNull();
  });
});

describe("compareReceipts", () => {
  it("asks once with both photos under the call's caps and answers the verdict", async () => {
    const complete = vi.fn<CompareComplete>(async () =>
      answer('{"same_receipt":true,"confidence":"high","differs_in":[]}'),
    );
    const out = await compareReceipts(INPUT, SESSION, { complete });
    expect(out).toEqual({ verdict: "same", confidence: "high", callId: "call-1", costNanocents: 41_000_000 });
    expect(complete).toHaveBeenCalledTimes(1);
    const [target, request, session] = complete.mock.calls[0];
    expect(target).toBe("spark");
    expect(session).toBe(SESSION);
    expect(request.purpose).toBe(COMPARE_PURPOSE);
    expect(request.maxCostCents).toBe(flags.fuelAnomalyLimits.compareMaxCostCents);
    expect(request.maxOutputTokens).toBe(flags.fuelAnomalyLimits.compareMaxOutputTokens);
    expect(request.traceId).toBe(INPUT.traceId);
    expect(request.format?.strict).toBe(true);
    const user = request.messages[1];
    if (user.role !== "user") throw new Error("the second message is not the user's");
    expect(user.attachments).toEqual([
      { kind: "image", mime: "image/webp", bytes: PHOTOS[0].bytes },
      { kind: "image", mime: "image/jpeg", bytes: PHOTOS[1].bytes },
    ]);
  });

  it("answers different receipts", async () => {
    const complete = vi.fn(async () => answer('{"same_receipt":false,"confidence":"medium","differs_in":["time"]}'));
    expect(await compareReceipts(INPUT, SESSION, { complete })).toMatchObject({ verdict: "different", confidence: "medium" });
  });

  it("calls a malformed or cut-short answer unreadable, keeping its call and cost", async () => {
    const bad = vi.fn(async () => answer("They look alike."));
    expect(await compareReceipts(INPUT, SESSION, { complete: bad })).toEqual({
      verdict: "unknown",
      category: "unreadable",
      callId: "call-1",
      costNanocents: 41_000_000,
    });
    const cut = vi.fn(async () => answer('{"same_receipt":true,"confidence":"high","differs_in":[]}', { status: "incomplete" }));
    expect(await compareReceipts(INPUT, SESSION, { complete: cut })).toMatchObject({ verdict: "unknown", category: "unreadable" });
  });

  it("calls a cap refusal budget at no cost, and a timeout unknown at an unknown cost", async () => {
    const capped = vi.fn(async () => {
      throw new AiError("cap");
    });
    expect(await compareReceipts(INPUT, SESSION, { complete: capped })).toEqual({
      verdict: "unknown",
      category: "budget",
      callId: null,
      costNanocents: 0,
    });
    const slow = vi.fn(async () => {
      throw new AiError("timeout");
    });
    expect(await compareReceipts(INPUT, SESSION, { complete: slow })).toEqual({
      verdict: "unknown",
      category: "timeout",
      callId: null,
      costNanocents: null,
    });
    const thrown = vi.fn(async () => {
      throw new Error("socket closed");
    });
    expect(await compareReceipts(INPUT, SESSION, { complete: thrown })).toMatchObject({ category: "timeout", costNanocents: null });
  });

  it("logs the category only, never the error text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = vi.fn(async () => {
      throw new Error("secret upstream words");
    });
    await compareReceipts(INPUT, SESSION, { complete: thrown });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("passes the real wrapper's checks: one call under the cap, its trace the run, both photos sent", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DB_CLUSTER_ARN", "");
    vi.stubEnv("META_MODEL_SPARK", "muse-spark-1.3");
    vi.stubEnv("AI_SPEND_CAP_CENTS", "12000");
    vi.stubEnv("META_API_KEY", "test-key-abcdefghijklmnop");
    flags.aiEnabled = true;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchFn = vi.fn<FetchFn>(async () =>
      Response.json({
        id: "resp_compare1",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: '{"same_receipt":true,"confidence":"high","differs_in":[]}' }],
          },
        ],
        usage: { input_tokens: 1_800, output_tokens: 30 },
      }),
    );
    const seen = { reserved: 0, purpose: null as unknown, trace: null as unknown };
    try {
      // The repo's own synthetic sample photos: the wrapper checks that the bytes are the image.
      const sample = (name: string) => new Uint8Array(readFileSync(new URL(`../../../public/samples/docs/${name}`, import.meta.url)));
      const photos: readonly [ComparePhoto, ComparePhoto] = [
        { id: "a", mime: "image/webp", bytes: sample("br-fuel-465.webp") },
        { id: "b", mime: "image/webp", bytes: sample("br-fuel-465-again.webp") },
      ];
      const out = await compareReceipts({ ...INPUT, photos }, SESSION, { ai: { fetch: fetchFn, db: ledger(seen) } });
      expect(out).toMatchObject({ verdict: "same", confidence: "high" });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(seen.purpose).toBe(COMPARE_PURPOSE);
      expect(seen.trace).toBe(INPUT.traceId);
      expect(seen.reserved).toBeGreaterThan(0);
      expect(seen.reserved).toBeLessThanOrEqual(flags.fuelAnomalyLimits.compareMaxCostCents * 1_000_000_000);
      const body = String(fetchFn.mock.calls[0][1]?.body);
      expect(body.match(/data:image\/webp;base64,/g)).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("makes no call with the switch off", async () => {
    flags.fuelAnomalyEnabled = false;
    const complete = vi.fn(async () => answer("{}"));
    expect(await compareReceipts(INPUT, SESSION, { complete })).toEqual({ verdict: "off" });
    expect(complete).not.toHaveBeenCalled();
  });
});
