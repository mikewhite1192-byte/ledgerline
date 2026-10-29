import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiResult, type ImageEditRequest, type ImageResult } from "../ai";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { markDocument, readMarkupFile, type MarkupDeps } from "./markup";
import { uploadDocument, type UploadFile } from "./service";
import { finishMarkupFailed } from "./store";
import { CONFIDENCE_FIELDS, MARKUP_ATTEMPTS_MAX } from "./types";

// The marked copy against the real database, as the app's role, with fake edit and check calls
// (no network, no model). A copy is kept only when its read-back passes; a failed try keeps no
// file; a budget refusal before any paid call uses no try; a document gets three tries; the day
// count holds; two clicks start one try; the copy stays inside its carrier; and the columns'
// own checks refuse a file on a row that is not checked. Only this file's two tenants are made,
// and they are removed after, whichever way the tests end.

const room = vi.hoisted(() => ({ value: null as null | "room" | "cap" | "too_expensive" }));
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return {
    ...actual,
    spendRoom: vi.fn(async (...args: Parameters<typeof actual.spendRoom>) =>
      room.value === null ? actual.spendRoom(...args) : room.value,
    ),
  };
});

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const MINUTE = 60_000;
const clock = () => new Date(NOW);
const saved = {
  enabled: flags.documentsEnabled,
  markup: flags.documentMarkupEnabled,
  crop: flags.documentCrop,
  limits: { ...flags.markupLimits },
  uploads: { ...flags.documentLimits },
};

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
const LOAD_NUMBER = "MK-L1";
const MILES = 245;
const LINEHAUL = 245 * MILES; // $600.25
const FUEL = 13_000; // $130.00
const ANCHOR = "LINEHAUL $600.25";
const CALLOUT = "Load has no rate yet. This page sets $600.25 plus $130.00 fuel.";

let files = 0;
function png(name = "rate-con.png"): UploadFile {
  files += 1;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, files, files >> 8, 9, 9]);
  return { name, type: "image/png", bytes };
}

function reading(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_kind: "rate_confirmation",
    sample_word: true,
    vendor: null,
    date_mmddyyyy: null,
    total_cents: null,
    load_number: LOAD_NUMBER,
    truck_unit: null,
    gallons_milli: null,
    price_cents: null,
    loaded_miles: MILES,
    rate_per_mile_cents: 245,
    linehaul_cents: LINEHAUL,
    fuel_surcharge_cents: FUEL,
    customer_name: "Test Shipper",
    stops: [],
    text_lines: ["SAMPLE RATE CONFIRMATION", `LOAD ${LOAD_NUMBER}`, ANCHOR, "FUEL $130.00"],
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])),
    ...over,
  };
}

function checkAnswer(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...reading({ text_lines: ["SAMPLE RATE CONFIRMATION"] }),
    callout_text: CALLOUT,
    circled_line_text: ANCHOR,
    circle_count: 1,
    all_amounts_cents: [LINEHAUL, FUEL],
    ...over,
  });
}

function modelResult(text: string): AiResult {
  return {
    callId: randomUUID(),
    status: "ok",
    text,
    toolCalls: [],
    usage: { input: 900, cached: 0, output: 300, reasoning: 0 },
    costNanocents: 1_500_000,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  };
}

// A WebP the edit hands back, unique per call.
let copies = 0;
function webp(extra = 0): Uint8Array {
  copies += 1;
  return new Uint8Array([...Buffer.from("RIFF"), copies, 0, 0, 0, ...Buffer.from("WEBPVP8 "), ...new Array(extra).fill(7)]);
}

type Fakes = { edit: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn>; deps: MarkupDeps };

function fakes(opts: { images?: () => ImageResult["images"]; editError?: AiError; check?: string } = {}): Fakes {
  const edit = vi.fn(async (): Promise<ImageResult> => {
    if (opts.editError) throw opts.editError;
    return { callId: randomUUID(), images: opts.images ? opts.images() : [{ bytes: webp(), mime: "image/webp" }], costNanocents: 1 };
  });
  const complete = vi.fn(async () => modelResult(opts.check ?? checkAnswer()));
  return { edit, complete, deps: { db: app, now: clock, edit, complete } };
}

async function upload(over: Record<string, unknown> = {}, file = png()): Promise<string> {
  const text = JSON.stringify(reading(over));
  const out = await uploadDocument(A.session, file, { db: app, now: clock, read: { complete: async () => modelResult(text) } });
  if (!out.ok) throw new Error(`upload refused: ${out.error}`);
  return out.view.id;
}

type MarkupRow = {
  markup_status: string;
  markup_attempts: number;
  markup_category: string | null;
  markup_target: string | null;
  markup_callout: string | null;
  markup_mime: string | null;
  markup_length: number | null;
  markup_hash: string | null;
  has_bytes: boolean;
  has_check: boolean;
  markup_edit_call_id: string | null;
  markup_check_call_id: string | null;
  markup_at: Date | string | null;
};

const markupRow = async (id: string): Promise<MarkupRow> =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<MarkupRow>(
        `SELECT markup_status, markup_attempts, markup_category, markup_target, markup_callout, markup_mime,
           markup_length, markup_hash, markup_bytes IS NOT NULL AS has_bytes, markup_check IS NOT NULL AS has_check,
           markup_edit_call_id, markup_check_call_id, markup_at
         FROM documents WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0];

const adminSet = (id: string, set: string, params: Param[] = []) =>
  admin.withTenant(A.tenantId, (q) =>
    q.execute(`UPDATE documents SET ${set} WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`, [id, ...params]),
  );

describe("marked copies in the database", () => {
  let loadId: string;

  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `mark-a-${randomUUID().slice(0, 8)}`);
    B = await makeTenant(admin, `mark-b-${randomUUID().slice(0, 8)}`);
    loadId = randomUUID();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
           dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles, linehaul_cents,
           fuel_surcharge_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'delivered',
           'Springfield', 'IL', 'Fairview', 'OH', CAST('2026-10-28' AS date), CAST('2026-10-29' AS date),
           CAST('2026-10-29T18:00:00Z' AS timestamptz), $5, NULL, $6)`,
        [loadId, LOAD_NUMBER, A.customerId, A.driverId, MILES, FUEL],
      ),
    );
  });

  beforeEach(() => {
    flags.documentsEnabled = true;
    flags.documentMarkupEnabled = true;
    flags.documentCrop = false;
    // The day count is pinned in its own test; the others mark many documents at NOW.
    flags.markupLimits = { ...saved.limits, perTenantPerDay: 1_000 };
    // This file uploads more than a day's worth of documents for one carrier.
    flags.documentLimits = { ...saved.uploads, perTenantPerDay: 1_000 };
    room.value = null;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    flags.documentsEnabled = saved.enabled;
    flags.documentMarkupEnabled = saved.markup;
    flags.documentCrop = saved.crop;
    flags.markupLimits = { ...saved.limits };
    flags.documentLimits = { ...saved.uploads };
    vi.restoreAllMocks();
    if (admin) {
      await dropTenant(admin, A);
      await dropTenant(admin, B);
    }
    await app?.close();
    await admin?.close();
  });

  it("keeps a copy whose read-back passes, stores it once, and shows it only inside its carrier", async () => {
    const id = await upload();
    const f = fakes();
    const out = await markDocument(A.session, id, f.deps);
    if (!out.ok) throw new Error(`refused: ${out.error}`);
    expect(out.view.markup).toMatchObject({ status: "checked", attemptsLeft: MARKUP_ATTEMPTS_MAX - 1, category: null });

    const [editReq] = f.edit.mock.calls[0] as [ImageEditRequest];
    expect(editReq.purpose).toBe("document_markup");
    expect(editReq.maxCostCents).toBe(flags.markupLimits.editMaxCostCents);
    expect(editReq.prompt).toContain(`reads exactly: ${ANCHOR}.`);
    expect(editReq.prompt).toContain(`exactly this text: ${CALLOUT}.`);
    expect(editReq.image.mime).toBe("image/png");
    const [, checkReq] = f.complete.mock.calls[0] as [string, { purpose: string; maxCostCents: number }];
    expect(checkReq).toMatchObject({ purpose: "document_markup_check", maxCostCents: flags.markupLimits.checkMaxCostCents });

    const row = await markupRow(id);
    const copy = await readMarkupFile(A.session, id, { db: app });
    if (!copy) throw new Error("no copy");
    expect(copy.mime).toBe("image/webp");
    expect(row).toMatchObject({
      markup_status: "checked",
      markup_attempts: 1,
      markup_target: "linehaul_cents",
      markup_callout: CALLOUT,
      markup_mime: "image/webp",
      markup_length: copy.bytes.byteLength,
      markup_hash: createHash("sha256").update(copy.bytes).digest("hex"),
      has_bytes: true,
      has_check: true,
    });
    expect(row.markup_edit_call_id).not.toBeNull();
    expect(row.markup_check_call_id).not.toBeNull();

    // A second click on a kept copy starts nothing.
    expect(await markDocument(A.session, id, f.deps)).toEqual({ ok: false, error: "already_checked" });
    expect(f.edit).toHaveBeenCalledTimes(1);
    // The other carrier sees nothing.
    expect(await readMarkupFile(B.session, id, { db: app })).toBeNull();
    expect(await markDocument(B.session, id, f.deps)).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses a login that is not a member of the carrier, before reading anything", async () => {
    const id = await upload();
    const f = fakes();
    const stranger = { ...A.session, sub: `stranger-${randomUUID()}` };
    await expect(markDocument(stranger, id, f.deps)).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(readMarkupFile(stranger, id, { db: app })).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(f.edit).not.toHaveBeenCalled();
  });

  it("keeps no file for a copy that reads back wrong, uses the try, and stops after three", async () => {
    const id = await upload();
    const f = fakes({ check: checkAnswer({ callout_text: "Load has no rate yet. This page sets $600.25 plus $180.00 fuel." }) });
    for (let i = 1; i <= MARKUP_ATTEMPTS_MAX; i++) {
      const out = await markDocument(A.session, id, f.deps);
      if (!out.ok) throw new Error(`refused: ${out.error}`);
      expect(out.view.markup).toMatchObject({ status: "mismatch", category: "callout_wrong", attemptsLeft: MARKUP_ATTEMPTS_MAX - i });
    }
    const row = await markupRow(id);
    expect(row).toMatchObject({ markup_status: "mismatch", markup_attempts: 3, has_bytes: false, markup_mime: null, has_check: true });
    expect(await readMarkupFile(A.session, id, { db: app })).toBeNull();
    expect(await markDocument(A.session, id, f.deps)).toEqual({ ok: false, error: "attempt_limit" });
    expect(f.edit).toHaveBeenCalledTimes(3);
  });

  it("names each failed read-back and each bad picture, never keeping a file", async () => {
    const cases: [Fakes, string, string][] = [
      [fakes({ check: checkAnswer({ total_cents: 999 }) }), "mismatch", "field_changed"],
      [fakes({ check: checkAnswer({ circle_count: 2 }) }), "mismatch", "anchor_wrong"],
      [fakes({ check: checkAnswer({ all_amounts_cents: [LINEHAUL, FUEL, 4_200] }) }), "mismatch", "extra_amount"],
      [fakes({ check: "{not json" }), "mismatch", "off_schema"],
      [fakes({ images: () => [] }), "unavailable", "unknown"],
      [fakes({ images: () => [{ bytes: webp(), mime: "image/webp" }, { bytes: webp(), mime: "image/webp" }] }), "unavailable", "unknown"],
      [fakes({ images: () => [{ bytes: new Uint8Array([1, 2, 3, 4]), mime: "image/png" }] }), "unavailable", "unknown"],
      [fakes({ editError: new AiError("timeout") }), "unavailable", "timeout"],
      [fakes({ editError: new AiError("unavailable") }), "unavailable", "unknown"],
    ];
    for (const [f, status, category] of cases) {
      const id = await upload();
      const out = await markDocument(A.session, id, f.deps);
      if (!out.ok) throw new Error(`refused: ${out.error}`);
      expect(out.view.markup, category).toMatchObject({ status, category, attemptsLeft: MARKUP_ATTEMPTS_MAX - 1 });
      expect((await markupRow(id)).has_bytes).toBe(false);
    }
  });

  it("refuses a copy larger than the cap as too_large", async () => {
    flags.markupLimits = { ...flags.markupLimits, maxBytes: 20 };
    const id = await upload();
    const f = fakes({ images: () => [{ bytes: webp(10), mime: "image/webp" }] });
    const out = await markDocument(A.session, id, f.deps);
    expect(out.ok && out.view.markup).toMatchObject({ status: "unavailable", category: "too_large", attemptsLeft: 2 });
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("gives the try back when the edit is refused for budget, and keeps it when the check is", async () => {
    const id = await upload();
    const capped = fakes({ editError: new AiError("cap") });
    const out = await markDocument(A.session, id, capped.deps);
    expect(out.ok && out.view.markup).toMatchObject({ status: "unavailable", category: "budget", attemptsLeft: 3 });
    expect((await markupRow(id)).markup_attempts).toBe(0);

    const checkCapped = fakes();
    checkCapped.complete.mockRejectedValueOnce(new AiError("cap"));
    const again = await markDocument(A.session, id, checkCapped.deps);
    expect(again.ok && again.view.markup).toMatchObject({ status: "unavailable", category: "budget", attemptsLeft: 2 });
  });

  it("writes waiting for budget and uses no try when the cap has no room for the check", async () => {
    const id = await upload();
    const f = fakes();
    for (const value of ["cap", "too_expensive"] as const) {
      room.value = value;
      expect(await markDocument(A.session, id, f.deps)).toEqual({ ok: false, error: "budget" });
      expect(await markupRow(id)).toMatchObject({ markup_status: "unavailable", markup_category: "budget", markup_attempts: 0, markup_at: null });
    }
    expect(f.edit).not.toHaveBeenCalled();
    room.value = "room";
    const out = await markDocument(A.session, id, f.deps);
    expect(out.ok && out.view.markup.status).toBe("checked");
  });

  it("clears the last try's read-back when the budget refuses a copy that did not match", async () => {
    const id = await upload();
    await adminSet(
      id,
      "markup_status = 'mismatch', markup_category = 'callout_wrong', markup_attempts = 1, markup_check = CAST('{}' AS jsonb), markup_edit_call_id = CAST($2 AS uuid), markup_check_call_id = CAST($3 AS uuid)",
      [randomUUID(), randomUUID()],
    );
    room.value = "cap";
    expect(await markDocument(A.session, id, fakes().deps)).toEqual({ ok: false, error: "budget" });
    expect(await markupRow(id)).toMatchObject({
      markup_status: "unavailable",
      markup_category: "budget",
      markup_attempts: 1,
      has_check: false,
      markup_edit_call_id: null,
      markup_check_call_id: null,
    });
  });

  it("refuses a PDF, a switch that is off, and a document with nothing to mark", async () => {
    const pdf = await upload(
      {},
      { name: "rate-con.pdf", type: "application/pdf", bytes: new Uint8Array(Buffer.from(`%PDF-1.7\n3 0 obj << /Type /Page >> endobj\n% ${files++}\n%%EOF`)) },
    );
    const f = fakes();
    expect(await markDocument(A.session, pdf, f.deps)).toEqual({ ok: false, error: "not_image" });
    const id = await upload({ text_lines: ["SAMPLE RATE CONFIRMATION"] });
    expect(await markDocument(A.session, id, f.deps)).toEqual({ ok: false, error: "no_anchor_line" });
    flags.documentMarkupEnabled = false;
    expect(await markDocument(A.session, id, f.deps)).toEqual({ ok: false, error: "disabled" });
    expect(f.edit).not.toHaveBeenCalled();
    expect((await markupRow(id)).markup_status).toBe("none");
  });

  it("writes the callout in the driver's language", async () => {
    await admin.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE drivers SET preferred_language = 'es' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [A.driverId]),
    );
    try {
      const id = await upload();
      const spanish = "La carga aún no tiene tarifa. Esta hoja fija $600.25 más $130.00 de combustible.";
      const f = fakes({ check: checkAnswer({ callout_text: spanish }) });
      const out = await markDocument(A.session, id, f.deps);
      expect(out.ok && out.view.markup.status).toBe("checked");
      expect((await markupRow(id)).markup_callout).toBe(spanish);
      expect((f.edit.mock.calls[0] as [ImageEditRequest])[0].prompt).toContain(spanish);
    } finally {
      await admin.withTenant(A.tenantId, (q) =>
        q.execute("UPDATE drivers SET preferred_language = 'en' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [A.driverId]),
      );
    }
  });

  it("starts one try for two clicks, and another only once the first has stalled", async () => {
    const id = await upload();
    const started = new Date(NOW - MINUTE).toISOString();
    await adminSet(id, "markup_status = 'marking', markup_attempts = 1, markup_at = CAST($2 AS timestamptz)", [started]);
    const f = fakes();
    expect(await markDocument(A.session, id, f.deps)).toEqual({ ok: false, error: "in_progress" });
    expect(f.edit).not.toHaveBeenCalled();

    // The stalled try's late ending no longer holds the claim once a new try took it.
    const stalled = new Date(NOW - 4 * MINUTE).toISOString();
    await adminSet(id, "markup_at = CAST($2 AS timestamptz)", [stalled]);
    const out = await markDocument(A.session, id, f.deps);
    expect(out.ok && out.view.markup).toMatchObject({ status: "checked", attemptsLeft: 1 });
    const late = await app.withTenant(A.tenantId, (q) =>
      finishMarkupFailed(q, id, { attempt: 1, atIso: stalled }, {
        status: "unavailable",
        category: "unknown",
        check: null,
        editCallId: null,
        checkCallId: null,
        refund: false,
      }),
    );
    expect(late).toBe(0);
    expect((await markupRow(id)).markup_status).toBe("checked");
  });

  it("holds the carrier's day count across documents", async () => {
    // Earlier tests' tries move to two days ago, so only this test's rows are in the window.
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE documents SET markup_at = CAST($1 AS timestamptz) WHERE tenant_id = current_tenant_id() AND markup_at IS NOT NULL",
        [new Date(NOW - 48 * 60 * MINUTE).toISOString()],
      ),
    );
    const first = await upload();
    const second = await upload();
    flags.markupLimits = { ...saved.limits, perTenantPerDay: 0 };
    const f = fakes();
    expect(await markDocument(A.session, first, f.deps)).toEqual({ ok: false, error: "limit" });
    // Today's tries elsewhere in the carrier count; the document's own row does not.
    flags.markupLimits = { ...saved.limits, perTenantPerDay: 1 };
    await adminSet(second, "markup_status = 'mismatch', markup_attempts = 1, markup_at = CAST($2 AS timestamptz)", [
      new Date(NOW - 60 * MINUTE).toISOString(),
    ]);
    expect(await markDocument(A.session, first, f.deps)).toEqual({ ok: false, error: "limit" });
    await adminSet(second, "markup_at = CAST($2 AS timestamptz)", [new Date(NOW - 25 * 60 * MINUTE).toISOString()]);
    const out = await markDocument(A.session, first, f.deps);
    expect(out.ok && out.view.markup.status).toBe("checked");
    expect(f.edit).toHaveBeenCalledTimes(1);
  });

  it("refuses a file on a row that is not checked, and a try count past three", async () => {
    const id = await upload();
    const bad: [string, Param[]][] = [
      [
        "markup_status = 'mismatch', markup_bytes = decode('00', 'hex'), markup_mime = 'image/webp', markup_length = 1, markup_hash = $2",
        ["a".repeat(64)],
      ],
      ["markup_status = 'checked'", []],
      [
        "markup_status = 'checked', markup_bytes = decode('00', 'hex'), markup_mime = 'image/webp', markup_length = 2, markup_hash = $2",
        ["a".repeat(64)],
      ],
      ["markup_attempts = 4", []],
      ["markup_status = 'done'", []],
      ["markup_category = 'upstream said no'", []],
      ["markup_callout = $2", ["x".repeat(121)]],
    ];
    for (const [set, params] of bad) {
      expect(await sqlStateOf(adminSet(id, set, params)), set).toBe("23514");
    }
    // The app login still cannot change the original file.
    const forged = app.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE documents SET bytes = decode('00', 'hex') WHERE id = CAST($1 AS uuid)", [id]),
    );
    expect(await sqlStateOf(forged)).toBe("42501");
  });
});
