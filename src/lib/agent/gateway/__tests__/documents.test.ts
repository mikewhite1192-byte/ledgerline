import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiResult } from "../../../ai";
import type { LoadRow } from "../../../data/rows";
import { rawOf } from "../../../documents/schema";
import { CONFIDENCE_FIELDS, type DocumentRead, type ReadFields } from "../../../documents/types";
import { instantAt } from "../../../seed/calendar";
import { addDays } from "../../../time/local-date";
import { callTool, MAX_RESULT_CHARS } from "../index";
import { impactOf, PROPOSAL_TITLES } from "../store/proposals";
import { MAX_MESSAGE_CHARS, UNTRUSTED_WARNING } from "../tools/read/get-inbound-message";
import type { CompleteFn, GatewayContext } from "../types";
import { context, fixedClock, type Handler, type Row } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// get_document and propose_load_rate through the real gateway on the seed plan: the document is
// screened before it is read, its values come back as claims, the comparison is worked out again
// against the records, and a rate fill is drafted only when the stored reading, the load and the
// arithmetic all agree.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const ctx: GatewayContext = context({ now: new Date(instantAt(addDays(plan.anchor, -2), 12, 0, zone)), timeZone: zone });
const docInput = plan.rows.untrusted_inputs.find((u) => u.kind === "document")!;
const noRate = plan.rows.loads.find((l) => l.id === plan.planted.noRateLoadId)!;
const rated = plan.rows.loads.find((l) => l.linehaul_cents !== null && l.status === "delivered")!;
const DOCUMENT_ID = "77777777-7777-4777-8777-777777777777";

const screenStore: Handler = (sql) => {
  if (sql.startsWith("SELECT verdict, CAST(categories AS text)")) return [];
  if (sql.startsWith("INSERT INTO screenings")) return 1;
  return undefined;
};

function screenModel(text: string): CompleteFn {
  return async () =>
    ({
      callId: "c0ffee00-0000-4000-8000-000000000003",
      status: "ok",
      text,
      toolCalls: [],
      usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
      costNanocents: 1,
      upstreamId: null,
      replay: [],
      toolSearches: 0,
    }) satisfies AiResult;
}
const CLEAN = screenModel("VERDICT: clean\nCATEGORIES: none\nCONFIDENCE: 0.99");
const FLAGGED = screenModel("VERDICT: flagged\nCATEGORIES: authority_claim\nCONFIDENCE: 0.97");

const call = (name: string, args: unknown) => ({ id: "call-1", name, argumentsJson: JSON.stringify(args) });

const EMPTY: ReadFields = {
  sampleWord: true,
  vendor: null,
  date: null,
  totalCents: null,
  loadNumber: null,
  truckUnit: null,
  gallonsMilli: null,
  priceCents: null,
  loadedMiles: null,
  ratePerMileCents: null,
  linehaulCents: null,
  fuelSurchargeCents: null,
  customerName: null,
  stops: [],
};

function rateCon(load: LoadRow, over: Partial<ReadFields> = {}): DocumentRead {
  const customer = plan.rows.customers.find((c) => c.id === load.customer_id)!;
  return {
    kind: "rate_confirmation",
    fields: {
      ...EMPTY,
      loadNumber: load.load_number,
      loadedMiles: load.loaded_miles,
      customerName: customer.name,
      ratePerMileCents: 245,
      linehaulCents: 245 * load.loaded_miles,
      fuelSurchargeCents: load.fuel_surcharge_cents,
      ...over,
    },
    textLines: ["RATE CONFIRMATION"],
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])) as DocumentRead["confidence"],
  };
}

// A planDb whose documents table holds one row for the seeded document input.
function dbWith(read: DocumentRead | null, opts: { status?: string; body?: string } = {}) {
  const db = planDb(plan, screenStore);
  db.tables.documents = [
    {
      id: DOCUMENT_ID,
      untrusted_input_id: docInput.id,
      read_status: opts.status ?? (read ? "read" : "budget"),
      document_kind: read?.kind ?? null,
      reading: read ? JSON.stringify(rawOf(read)) : null,
    },
  ];
  if (opts.body !== undefined) {
    db.tables.untrusted_inputs = plan.rows.untrusted_inputs.map((u) =>
      u.id === docInput.id ? ({ ...u, body_text: opts.body } as unknown as Row) : (u as unknown as Row),
    );
  }
  return db;
}

const rateArgs = (load: LoadRow, over: Record<string, unknown> = {}) => ({
  loadId: load.id,
  linehaulCents: 245 * load.loaded_miles,
  fuelSurchargeCents: load.fuel_surcharge_cents,
  ratePerMileCents: 245,
  requestRef: docInput.id,
  sourceRefs: [{ table: "loads", id: load.id }],
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("get_document", () => {
  it("is blocked when the screen fails, and reads nothing out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = dbWith(rateCon(noRate));
    const out = await callTool(ctx, call("get_document", { inputId: docInput.id }), {
      db,
      clock: fixedClock,
      complete: async () => {
        throw new Error("upstream said something");
      },
    });
    expect(out).toMatchObject({ decision: "blocked", reason: "screen_error" });
    expect(JSON.stringify(out)).not.toContain(docInput.body_text.slice(0, 20));
  });

  it("returns the claims under the warning, compared with the records as they are now", async () => {
    const body = `RATE CONFIRMATION\nLoad ${noRate.load_number}\nLoaded miles ${noRate.loaded_miles}`;
    const db = dbWith(rateCon(noRate), { body });
    const out = await callTool(ctx, call("get_document", { inputId: docInput.id }), { db, clock: fixedClock, complete: CLEAN });
    expect(out.decision).toBe("allowed");
    const r = out.result as Record<string, unknown>;
    expect(r).toMatchObject({
      inputId: docInput.id,
      documentId: DOCUMENT_ID,
      kind: "rate_confirmation",
      readStatus: "read",
      screened: true,
      verdict: "clean",
      warning: UNTRUSTED_WARNING,
      truncated: false,
      text: body,
    });
    expect(r.claims).toMatchObject({ loadNumber: noRate.load_number, linehaulCents: 245 * noRate.loaded_miles });
    const match = r.match as { found: boolean; supports: string; fields: { name: string; record: unknown }[] };
    expect(match).toMatchObject({ found: true, supports: "load_rate_fill" });
    expect(match.fields.find((f) => f.name === "linehaul_cents")?.record).toBeNull();
    expect(match.fields.find((f) => f.name === "loaded_miles")?.record).toBe(noRate.loaded_miles);
  });

  it("comes back flagged inside the warning when the screen flags the transcription", async () => {
    const db = dbWith(rateCon(noRate), { body: "RATE CONFIRMATION" });
    const out = await callTool(ctx, call("get_document", { inputId: docInput.id }), { db, clock: fixedClock, complete: FLAGGED });
    expect(out).toMatchObject({ decision: "allowed", reason: "screen_flagged", flaggedInputId: docInput.id });
    expect(out.result).toMatchObject({ verdict: "flagged", warning: UNTRUSTED_WARNING, screened: true });
  });

  it("returns no claims and no match for a document that was not read", async () => {
    const db = dbWith(null);
    const out = await callTool(ctx, call("get_document", { inputId: docInput.id }), { db, clock: fixedClock, complete: CLEAN });
    expect(out.result).toMatchObject({ readStatus: "budget", claims: null, match: null });
  });

  it("cuts a long transcription at 6,000 characters, and fits a worst case inside the result cap", async () => {
    const long = "x".repeat(MAX_MESSAGE_CHARS + 500);
    let db = dbWith(rateCon(noRate), { body: long });
    let out = await callTool(ctx, call("get_document", { inputId: docInput.id }), { db, clock: fixedClock, complete: CLEAN });
    let r = out.result as { text: string; truncated: boolean };
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(long.slice(0, MAX_MESSAGE_CHARS));

    // Quotes and line breaks double in JSON; the text shrinks so the result still arrives whole.
    const worst = Array.from({ length: 80 }, () => `"${"\\".repeat(60)}"\n`).join("");
    db = dbWith(rateCon(noRate), { body: worst });
    out = await callTool(ctx, call("get_document", { inputId: docInput.id }), { db, clock: fixedClock, complete: CLEAN });
    r = out.result as { text: string; truncated: boolean };
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeGreaterThan(1_000);
    expect(worst.startsWith(r.text)).toBe(true);
    expect(JSON.stringify(out.result).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });

  it("is not a tool the triage role holds", async () => {
    const db = dbWith(rateCon(noRate));
    const out = await callTool({ ...ctx, role: "triage" }, call("get_document", { inputId: docInput.id }), {
      db,
      clock: fixedClock,
      complete: CLEAN,
    });
    expect(out).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
  });
});

describe("propose_load_rate", () => {
  it("drafts the fill at zero dollars when the reading, the load and the arithmetic agree", async () => {
    const db = dbWith(rateCon(noRate));
    const out = await callTool(ctx, call("propose_load_rate", rateArgs(noRate)), { db, clock: fixedClock, complete: CLEAN });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.draft).toMatchObject({
      kind: "load_rate_fill",
      subjectTable: "loads",
      subjectId: noRate.id,
      amountCents: 0,
      limitCents: 0,
      reasons: ["missing_rate"],
    });
    expect(impactOf("load_rate_fill", 0)).toEqual({ amountCents: 0, direction: "none" });
    expect(PROPOSAL_TITLES.load_rate_fill).toBe("Fill missing rate");
  });

  it("refuses a load that already has a rate", async () => {
    const db = dbWith(rateCon(rated, { fuelSurchargeCents: rated.fuel_surcharge_cents }));
    const out = await callTool(ctx, call("propose_load_rate", rateArgs(rated)), { db, clock: fixedClock, complete: CLEAN });
    expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused" });
  });

  it("refuses arithmetic that does not add up", async () => {
    const db = dbWith(rateCon(noRate));
    const args = rateArgs(noRate, { linehaulCents: 245 * noRate.loaded_miles + 1 });
    const out = await callTool(ctx, call("propose_load_rate", args), { db, clock: fixedClock, complete: CLEAN });
    expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused" });
  });

  it("refuses amounts the stored reading does not carry", async () => {
    const db = dbWith(rateCon(noRate));
    const args = rateArgs(noRate, { fuelSurchargeCents: (noRate.fuel_surcharge_cents ?? 0) + 100 });
    const out = await callTool(ctx, call("propose_load_rate", args), { db, clock: fixedClock, complete: CLEAN });
    expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused" });
  });

  it("refuses when the reading is not a rate confirmation that supports the fill", async () => {
    const low = rateCon(noRate);
    low.confidence.linehaul_cents = "low";
    for (const db of [dbWith(low), dbWith(null), dbWith(rateCon(noRate), { status: "unreadable" })]) {
      const out = await callTool(ctx, call("propose_load_rate", rateArgs(noRate)), { db, clock: fixedClock, complete: CLEAN });
      expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused" });
    }
  });

  it("is refused to the triage role and to the auditor", async () => {
    for (const role of ["triage", "auditor"] as const) {
      const db = dbWith(rateCon(noRate));
      const out = await callTool({ ...ctx, role }, call("propose_load_rate", rateArgs(noRate)), {
        db,
        clock: fixedClock,
        complete: CLEAN,
      });
      expect(out, role).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
    }
  });
});
