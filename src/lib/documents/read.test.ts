import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { readDocument, type ReadComplete } from "./read";
import { CONFIDENCE_FIELDS } from "./types";

// One read through a fake model call: no network, no model. Every failure comes back as a
// category, and the raw error never leaves the module.

const SESSION: Session = { sub: "sub-ops", email: "ops@example.test", tenantId: "5b0a4d8e-2c1f-4e3a-9b7d-6f5e4d3c2b1a" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.7\n/Type /Page\n");
const INPUT = { documentId: "d1", bytes: PNG, mime: "image/png" as const, traceId: "trace-1" };

const READING = JSON.stringify({
  document_kind: "toll_receipt",
  sample_word: true,
  vendor: "Sample Turnpike Authority",
  date_mmddyyyy: "10/20/2026",
  total_cents: 1250,
  load_number: null,
  truck_unit: "T-12",
  gallons_milli: null,
  price_cents: null,
  loaded_miles: null,
  rate_per_mile_cents: null,
  linehaul_cents: null,
  fuel_surcharge_cents: null,
  customer_name: null,
  stops: [],
  text_lines: ["SAMPLE TURNPIKE AUTHORITY", "TOTAL $12.50"],
  confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])),
});

function result(over: Partial<AiResult> = {}): AiResult {
  return {
    callId: "call-1",
    status: "ok",
    text: READING,
    toolCalls: [],
    usage: { input: 900, cached: 0, output: 300, reasoning: 0 },
    costNanocents: 1_500_000,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
    ...over,
  };
}

const saved = { enabled: flags.documentsEnabled, crop: flags.documentCrop };
beforeEach(() => {
  flags.documentsEnabled = true;
  flags.documentCrop = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  flags.documentsEnabled = saved.enabled;
  flags.documentCrop = saved.crop;
  vi.restoreAllMocks();
});

describe("readDocument", () => {
  it("makes no call when the switch is off", async () => {
    flags.documentsEnabled = false;
    const complete = vi.fn<ReadComplete>();
    const out = await readDocument(INPUT, SESSION, { complete });
    expect(out).toEqual({ ok: false, status: "unreadable", category: "disabled", callId: null });
    expect(complete).not.toHaveBeenCalled();
  });

  it("sends one capped Muse Spark call with the strict schema and the image attached", async () => {
    let seen: AiRequest | null = null;
    const complete: ReadComplete = async (target, request) => {
      expect(target).toBe("spark");
      seen = request;
      return result();
    };
    const out = await readDocument(INPUT, SESSION, { complete });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.read.kind).toBe("toll_receipt");
    expect(out.read.fields.totalCents).toBe(1250);
    expect(out.callId).toBe("call-1");
    expect(out.costNanocents).toBe(1_500_000);
    const req = seen as unknown as AiRequest;
    expect(req.format?.strict).toBe(true);
    expect(req.maxCostCents).toBe(flags.documentLimits.readMaxCostCents);
    expect(req.traceId).toBe("trace-1");
    expect(req.purpose).toBe("document_read");
    const user = req.messages.find((m) => m.role === "user");
    expect(user?.attachments).toEqual([{ kind: "image", mime: "image/png", bytes: PNG }]);
  });

  it("attaches a PDF as a PDF", async () => {
    let seen: AiRequest | null = null;
    await readDocument({ ...INPUT, bytes: PDF, mime: "application/pdf" }, SESSION, {
      complete: async (_t, request) => {
        seen = request;
        return result();
      },
    });
    const user = (seen as unknown as AiRequest).messages.find((m) => m.role === "user");
    expect(user?.attachments?.[0]).toMatchObject({ kind: "pdf", filename: "document.pdf" });
  });

  it.each(["cap", "too_expensive", "billing"] as const)("calls %s a budget stop", async (category) => {
    const out = await readDocument(INPUT, SESSION, {
      complete: async () => {
        throw new AiError(category);
      },
    });
    expect(out).toEqual({ ok: false, status: "budget", category, callId: null });
  });

  it.each(["timeout", "unavailable", "network", "unknown", "rate_limited"] as const)(
    "leaves a %s outcome to a later try, never final",
    async (category) => {
      const out = await readDocument(INPUT, SESSION, {
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
      const out = await readDocument(INPUT, SESSION, {
        complete: async () => {
          throw new AiError(category);
        },
      });
      expect(out).toEqual({ ok: false, status: "unreadable", category: "model_error", callId: null });
    },
  );

  it("leaves a thrown non-model error to a later try and logs only its name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await readDocument(INPUT, SESSION, {
      complete: async () => {
        throw new TypeError("secret upstream text");
      },
    });
    expect(out).toEqual({ ok: false, status: "retry", category: "error", callId: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret upstream text");
  });

  it("calls a cut-short answer unreadable and keeps the call id", async () => {
    const out = await readDocument(INPUT, SESSION, { complete: async () => result({ status: "incomplete" }) });
    expect(out).toEqual({ ok: false, status: "unreadable", category: "incomplete", callId: "call-1" });
  });

  it("calls an answer off the schema unreadable", async () => {
    const out = await readDocument(INPUT, SESSION, {
      complete: async () => result({ text: READING.replace('"total_cents":1250', '"total_cents":"1250"') }),
    });
    expect(out).toEqual({ ok: false, status: "unreadable", category: "schema", callId: "call-1" });
  });
});
