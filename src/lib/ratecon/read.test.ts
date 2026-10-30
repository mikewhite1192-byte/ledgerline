import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiRequest } from "../ai";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { FetchFn } from "../ai/providers/http";
import { QUIET_JOB } from "../ai/test-fixtures";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { RATECON_MAX_OUTPUT_TOKENS, RATECON_TIMEOUT_MS, readRateCon, type RateConComplete } from "./read";
import {
  MAX_ACCESSORIALS,
  MAX_CITY_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_LINE_CHARS,
  MAX_NAME_CHARS,
  MAX_TEXT_LINES,
  RATECON_CONFIDENCE_FIELDS,
} from "./schema";
import { rateConPdf, rateConReading, rateConResult, rateConText } from "./test-fixtures";

// The rate confirmation read through a fake model call: no network, no model. Every failure comes
// back as a category, and the raw error never leaves the module.

const SESSION: Session = { sub: "sub-ops", email: "ops@example.test", tenantId: "5b0a4d8e-2c1f-4e3a-9b7d-6f5e4d3c2b1a" };
const PDF = rateConPdf(1);
const INPUT = { documentId: "d1", bytes: PDF, traceId: "trace-1" };

const saved = { documents: flags.documentsEnabled, ratecon: { ...flags.ratecon } };
beforeEach(() => {
  flags.documentsEnabled = true;
  flags.ratecon = { ...flags.ratecon, enabled: true };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  flags.documentsEnabled = saved.documents;
  flags.ratecon = { ...saved.ratecon };
  vi.restoreAllMocks();
});

describe("readRateCon", () => {
  it("makes no call while either switch is off, and leaves the reading to a later try", async () => {
    const complete = vi.fn<RateConComplete>();
    const off = { ok: false, status: "retry", category: "disabled", callId: null };
    flags.ratecon = { ...flags.ratecon, enabled: false };
    expect(await readRateCon(INPUT, SESSION, { complete })).toEqual(off);
    flags.ratecon = { ...flags.ratecon, enabled: true };
    flags.documentsEnabled = false;
    expect(await readRateCon(INPUT, SESSION, { complete })).toEqual(off);
    expect(complete).not.toHaveBeenCalled();
  });

  it("sends one capped Muse Spark call with the strict schema and the PDF attached", async () => {
    let seen: AiRequest | null = null;
    const complete: RateConComplete = async (target, request) => {
      expect(target).toBe("spark");
      seen = request;
      return rateConResult(rateConText());
    };
    const out = await readRateCon(INPUT, SESSION, { complete });
    expect(out).toEqual({ ok: true, reading: rateConReading(), callId: "call-ratecon-1", costNanocents: 2_000_000 });
    const req = seen as unknown as AiRequest;
    expect(req.format?.name).toBe("ratecon_read");
    expect(req.format?.strict).toBe(true);
    expect(req.maxOutputTokens).toBe(RATECON_MAX_OUTPUT_TOKENS);
    expect(req.maxCostCents).toBe(flags.ratecon.readMaxCostCents);
    expect(req.timeoutMs).toBe(RATECON_TIMEOUT_MS);
    expect(req.reasoningEffort).toBe("low");
    expect(req.purpose).toBe("ratecon_read");
    expect(req.traceId).toBe("trace-1");
    const user = req.messages.find((m) => m.role === "user");
    expect(user?.attachments).toEqual([{ kind: "pdf", bytes: PDF, filename: "rate-confirmation.pdf" }]);
  });

  it("pins the cap and the timeout", () => {
    expect(RATECON_MAX_OUTPUT_TOKENS).toBe(8_192);
    expect(RATECON_TIMEOUT_MS).toBe(25_000);
    expect(flags.ratecon.readMaxCostCents).toBe(8);
  });

  it.each(["cap", "too_expensive", "billing"] as const)("calls %s a budget stop", async (category) => {
    const out = await readRateCon(INPUT, SESSION, {
      complete: async () => {
        throw new AiError(category);
      },
    });
    expect(out).toEqual({ ok: false, status: "budget", category, callId: null });
  });

  it.each(["timeout", "unavailable", "network", "unknown", "rate_limited"] as const)(
    "leaves a %s outcome to a later try, never final",
    async (category) => {
      const out = await readRateCon(INPUT, SESSION, {
        complete: async () => {
          throw new AiError(category, category === "unavailable" ? 503 : undefined);
        },
      });
      expect(out).toEqual({ ok: false, status: "retry", category: "model_error", callId: null });
    },
  );

  it.each(["bad_request", "auth", "too_long", "not_configured", "disabled"] as const)(
    "calls a definite %s failure unreadable, by category only",
    async (category) => {
      const out = await readRateCon(INPUT, SESSION, {
        complete: async () => {
          throw new AiError(category);
        },
      });
      expect(out).toEqual({ ok: false, status: "unreadable", category: "model_error", callId: null });
    },
  );

  it("leaves a thrown non-model error to a later try and logs only its name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await readRateCon(INPUT, SESSION, {
      complete: async () => {
        throw new TypeError("secret upstream text");
      },
    });
    expect(out).toEqual({ ok: false, status: "retry", category: "error", callId: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret upstream text");
  });

  it("calls a cut-short answer unreadable and keeps the call id", async () => {
    const out = await readRateCon(INPUT, SESSION, {
      complete: async () => rateConResult(rateConText(), { status: "incomplete" }),
    });
    expect(out).toEqual({ ok: false, status: "unreadable", category: "incomplete", callId: "call-ratecon-1" });
  });

  it("calls an answer off the schema unreadable", async () => {
    const off = rateConText().replace('"total_cents":159500', '"total_cents":"159500"');
    expect(off).not.toBe(rateConText());
    const out = await readRateCon(INPUT, SESSION, { complete: async () => rateConResult(off) });
    expect(out).toEqual({ ok: false, status: "unreadable", category: "schema", callId: "call-ratecon-1" });
  });
});

// The schema's largest answer: every line and field at its longest, integers at their widest.
function largestReading(): string {
  return JSON.stringify({
    load_number: "L".repeat(40),
    customer_name: "c".repeat(MAX_NAME_CHARS),
    customer_code: "C".repeat(40),
    origin_city: "o".repeat(MAX_CITY_CHARS),
    origin_state: "s".repeat(20),
    dest_city: "d".repeat(MAX_CITY_CHARS),
    dest_state: "s".repeat(20),
    pickup_mmddyyyy: "p".repeat(20),
    delivery_mmddyyyy: "q".repeat(20),
    loaded_miles: 999_999,
    rate_per_mile_cents: 999_999_999,
    linehaul_cents: 999_999_999,
    fuel_surcharge_cents: 999_999_999,
    accessorials: Array.from({ length: MAX_ACCESSORIALS }, () => ({
      kind: "detention",
      description: "a".repeat(MAX_DESCRIPTION_CHARS),
      amount_cents: 999_999_999,
    })),
    total_cents: 999_999_999,
    driver_code: "D".repeat(20),
    sample_word: true,
    text_lines: Array.from({ length: MAX_TEXT_LINES }, () => "x".repeat(MAX_LINE_CHARS)),
    confidence: Object.fromEntries(RATECON_CONFIDENCE_FIELDS.map((f) => [f, "medium"])),
  });
}

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

describe("the rate confirmation read's output budget", () => {
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
  });

  it("holds the schema's largest answer, even at two characters a token", () => {
    expect(Math.ceil(largestReading().length / 2)).toBeLessThanOrEqual(RATECON_MAX_OUTPUT_TOKENS);
  });

  it("reserves its worst case, a 3 page PDF and every output token, under the read's cost cap", async () => {
    const pages = "%PDF-1.7\n" + "1 0 obj << /Type /Page >> endobj\n".repeat(flags.documentLimits.maxPdfPages);
    const pdf = new TextEncoder().encode(pages);
    const largest = largestReading();
    const fetchFn = vi.fn<FetchFn>(async () =>
      Response.json({
        id: "resp_ratecon1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: largest }] }],
        usage: { input_tokens: 13_000, output_tokens: 7_800 },
      }),
    );
    const seen = { reserved: 0 };
    const traceId = "9d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1b";
    const out = await readRateCon({ ...INPUT, bytes: pdf, traceId }, SESSION, {
      ai: { fetch: fetchFn, db: ledger(seen) },
    });
    // Not refused as too expensive: the call went out, and the largest answer parses.
    expect(out.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(body.max_output_tokens).toBe(RATECON_MAX_OUTPUT_TOKENS);
    expect(seen.reserved).toBeGreaterThan(RATECON_MAX_OUTPUT_TOKENS * 425_000);
    expect(seen.reserved).toBeLessThanOrEqual(flags.ratecon.readMaxCostCents * NANOCENTS_PER_CENT);
  });
});
