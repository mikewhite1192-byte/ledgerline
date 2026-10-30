import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { complete } from "../ai";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { FetchFn } from "../ai/providers/http";
import { QUIET_JOB } from "../ai/test-fixtures";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { RULE_KEYS } from "../pay-rules/rules";
import {
  NOTED_KEYS,
  PROPOSE_MAX_OUTPUT_TOKENS,
  PROPOSE_PURPOSE,
  proposeRequest,
  READ_MAX_OUTPUT_TOKENS,
  READ_PURPOSE,
  readRequest,
  RULES_FORMAT,
  SECTIONS_FORMAT,
} from "./format";
import { TRANSCRIPT_MAX } from "./sections";
import { readAnswerFor, rulesAnswerFor, type SampleName } from "./test-fixtures";

// The two calls of a policy run, each built the way run.ts builds it and sent through the real
// wrapper with a fake fetch and a fake spend ledger: no network, no model. Each worst case must
// reserve under its own cost cap, or every run would be refused too_expensive.

const SESSION: Session = { sub: "sub-ops", email: "ops@example.test", tenantId: "5b0a4d8e-2c1f-4e3a-9b7d-6f5e4d3c2b1a" };
const TRACE = "9d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a";
const SAMPLES: SampleName[] = ["harrow-flats-pay-policy", "cedar-bend-pay-policy"];

// The model-call ledger, answered just well enough for one call to reserve and settle. seen gets
// the reservation.
function ledger(seen: { reserved: number }): TenantDb {
  let reserved = 0;
  const q: Queryable = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("FROM ops.ai_spend")) {
        return [
          { spent_nanocents: 0, reserved_nanocents: 0, calls: 0, wonder_spent_nanocents: 0, wonder_reserved_nanocents: 0 },
        ] as T[];
      }
      // The spend watch reads model_calls too, so it is answered first.
      if (sql.includes("FROM spend_alerts")) return [QUIET_JOB] as T[];
      if (sql.includes("FROM model_calls")) return [{ reserved_nanocents: reserved, target: "spark" }] as T[];
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      if (sql.startsWith("INSERT INTO model_calls")) {
        reserved = Number(params[8]);
        seen.reserved = reserved;
      }
      return 1;
    },
  };
  return { withTenant: async (_tenantId, fn) => fn(q) };
}

function answering(text: string) {
  return vi.fn<FetchFn>(async () =>
    Response.json({
      id: "resp_policy1",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 9_000, output_tokens: 2_000 },
    }),
  );
}

describe("the policy formats", () => {
  it("are strict and name every rule and noted figure", () => {
    expect(SECTIONS_FORMAT.name).toBe("policy_sections");
    expect(SECTIONS_FORMAT.strict).toBe(true);
    expect(RULES_FORMAT.name).toBe("policy_rules");
    expect(RULES_FORMAT.strict).toBe(true);
    const schema = RULES_FORMAT.schema as {
      properties: { rules: { required: string[] }; noted: { items: { properties: { key: { enum: string[] } } } } };
    };
    expect(schema.properties.rules.required).toEqual([...RULE_KEYS]);
    expect(schema.properties.noted.items.properties.key.enum).toEqual([...NOTED_KEYS]);
  });

  it("build each request under its own caps and purpose", () => {
    const read = readRequest(new TextEncoder().encode("%PDF-1.7\n"), TRACE);
    expect(read.format).toBe(SECTIONS_FORMAT);
    expect(read.maxOutputTokens).toBe(READ_MAX_OUTPUT_TOKENS);
    expect(read.purpose).toBe(READ_PURPOSE);
    expect(read.maxCostCents).toBe(flags.policyLimits.readMaxCostCents);
    expect(read.timeoutMs).toBe(flags.policyLimits.readTimeoutMs);
    expect(read.traceId).toBe(TRACE);
    const propose = proposeRequest("1.1 text", TRACE);
    expect(propose.format).toBe(RULES_FORMAT);
    expect(propose.maxOutputTokens).toBe(PROPOSE_MAX_OUTPUT_TOKENS);
    expect(propose.purpose).toBe(PROPOSE_PURPOSE);
    expect(propose.maxCostCents).toBe(flags.policyLimits.proposeMaxCostCents);
    expect(propose.timeoutMs).toBe(flags.policyLimits.proposeTimeoutMs);
    // The propose call carries the transcript only, never the file.
    expect(propose.messages.some((m) => m.role === "user" && (m.attachments?.length ?? 0) > 0)).toBe(false);
  });

  it("hold each sample's answers, even at two characters a token", () => {
    for (const name of SAMPLES) {
      expect(Math.ceil(readAnswerFor(name).length / 2)).toBeLessThanOrEqual(READ_MAX_OUTPUT_TOKENS);
      expect(Math.ceil(JSON.stringify(rulesAnswerFor(name)).length / 2)).toBeLessThanOrEqual(PROPOSE_MAX_OUTPUT_TOKENS);
    }
  });
});

describe("the policy calls' cost reserves", () => {
  const ENV: Record<string, string> = {
    NODE_ENV: "test",
    DB_CLUSTER_ARN: "",
    META_MODEL_SPARK: "muse-spark-1.3",
    AI_SPEND_CAP_CENTS: "12000",
    META_API_KEY: "test-key-abcdefghijklmnop",
  };
  const savedAi = flags.aiEnabled;
  beforeEach(() => {
    flags.aiEnabled = true;
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    flags.aiEnabled = savedAi;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reserve the read's worst case, the largest PDF allowed and every output token, under its cap", async () => {
    const pages = "%PDF-1.7\n" + "1 0 obj << /Type /Page >> endobj\n".repeat(flags.policyLimits.maxPdfPages);
    const fetchFn = answering(readAnswerFor("harrow-flats-pay-policy"));
    const seen = { reserved: 0 };
    const out = await complete("spark", readRequest(new TextEncoder().encode(pages), TRACE), SESSION, {
      fetch: fetchFn,
      db: ledger(seen),
    });
    // Not refused as too expensive: the call went out.
    expect(out.status).toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(body.max_output_tokens).toBe(READ_MAX_OUTPUT_TOKENS);
    expect(seen.reserved).toBeGreaterThan(READ_MAX_OUTPUT_TOKENS * 425_000);
    expect(seen.reserved).toBeLessThanOrEqual(flags.policyLimits.readMaxCostCents * NANOCENTS_PER_CENT);
  });

  it("reserve the propose call's worst case, the longest transcript and every output token, under its cap", async () => {
    const line = "9.9 " + "x".repeat(96);
    const transcript = Array.from({ length: Math.ceil(TRANSCRIPT_MAX / (line.length + 1)) }, () => line)
      .join("\n")
      .slice(0, TRANSCRIPT_MAX);
    expect(transcript.length).toBe(TRANSCRIPT_MAX);
    const fetchFn = answering(JSON.stringify(rulesAnswerFor("harrow-flats-pay-policy")));
    const seen = { reserved: 0 };
    const out = await complete("spark", proposeRequest(transcript, TRACE), SESSION, { fetch: fetchFn, db: ledger(seen) });
    expect(out.status).toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(body.max_output_tokens).toBe(PROPOSE_MAX_OUTPUT_TOKENS);
    expect(seen.reserved).toBeGreaterThan(PROPOSE_MAX_OUTPUT_TOKENS * 425_000);
    expect(seen.reserved).toBeLessThanOrEqual(flags.policyLimits.proposeMaxCostCents * NANOCENTS_PER_CENT);
  });
});
