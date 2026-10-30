import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { checkUpload, MARKUP_STALLED_MS, readAgain, safeFilename, STALLED_MS, uploadDocument, viewOf } from "./service";
import type { DocumentMetaRow } from "./store";
import { CONFIDENCE_FIELDS } from "./types";

// The upload's own checks and the view a page shows, with no database: a db that is touched
// fails the test, so every refusal here happens before anything is stored.

const SESSION: Session = { sub: "sub-ops", email: "ops@example.test", tenantId: "5b0a4d8e-2c1f-4e3a-9b7d-6f5e4d3c2b1a" };
const NOW = new Date(Date.UTC(2026, 9, 24, 15, 0, 0));
const UNTOUCHED: TenantDb = {
  withTenant: async () => {
    throw new Error("the database was touched");
  },
};

const sample = (file: string) => new Uint8Array(readFileSync(join(process.cwd(), "public/samples/docs", file)));
const ascii = (s: string) => new TextEncoder().encode(s);
const pdfWithPages = (n: number) =>
  ascii(`%PDF-1.7\n${Array.from({ length: n }, (_, i) => `${i + 3} 0 obj << /Type /Page >> endobj`).join("\n")}\n%%EOF`);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const saved = flags.documentsEnabled;
beforeEach(() => {
  flags.documentsEnabled = true;
});
afterEach(() => {
  flags.documentsEnabled = saved;
});

describe("checkUpload", () => {
  it("accepts every sample document the seed ships", () => {
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", bytes: sample("br-l10259-ratecon.pdf") })).toEqual({
      ok: true,
      mime: "application/pdf",
      pageCount: 1,
    });
    expect(checkUpload({ name: "a.webp", type: "image/webp", bytes: sample("br-l10262-lumper.webp") })).toEqual({
      ok: true,
      mime: "image/webp",
      pageCount: 1,
    });
  });

  it("refuses a file over the size limit before looking at it", () => {
    const big = new Uint8Array(flags.documentLimits.maxBytes + 1);
    big.set(PNG);
    expect(checkUpload({ name: "a.png", type: "image/png", bytes: big })).toEqual({ ok: false, error: "too_large" });
    const exact = new Uint8Array(flags.documentLimits.maxBytes);
    exact.set(PNG);
    expect(checkUpload({ name: "a.png", type: "image/png", bytes: exact }).ok).toBe(true);
  });

  it("refuses an empty file, a type off the list and bytes that are not the type they claim", () => {
    expect(checkUpload({ name: "a.png", type: "image/png", bytes: new Uint8Array(0) })).toEqual({
      ok: false,
      error: "unsupported",
    });
    expect(checkUpload({ name: "a.gif", type: "image/gif", bytes: ascii("GIF89a....") })).toEqual({
      ok: false,
      error: "unsupported",
    });
    expect(checkUpload({ name: "a.html", type: "text/html", bytes: ascii("<html>") })).toEqual({
      ok: false,
      error: "unsupported",
    });
    expect(checkUpload({ name: "a.png", type: "image/png", bytes: ascii("%PDF-1.7 /Type /Page") })).toEqual({
      ok: false,
      error: "unsupported",
    });
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", bytes: PNG })).toEqual({
      ok: false,
      error: "unsupported",
    });
  });

  it("refuses a PDF with more pages than the limit, and one whose pages cannot be counted", () => {
    const max = flags.documentLimits.maxPdfPages;
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", bytes: pdfWithPages(max) })).toEqual({
      ok: true,
      mime: "application/pdf",
      pageCount: max,
    });
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", bytes: pdfWithPages(max + 1) })).toEqual({
      ok: false,
      error: "too_many_pages",
    });
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", bytes: ascii("%PDF-1.7\n/ObjStm\n%%EOF") })).toEqual({
      ok: false,
      error: "too_many_pages",
    });
    expect(checkUpload({ name: "a.pdf", type: "application/pdf", bytes: ascii("%PDF-1.7\n%%EOF") })).toEqual({
      ok: false,
      error: "too_many_pages",
    });
  });
});

describe("safeFilename", () => {
  it("keeps plain names and drops any folder", () => {
    expect(safeFilename("receipt 01.jpg")).toBe("receipt 01.jpg");
    expect(safeFilename("C:\\Users\\x\\scan.pdf")).toBe("scan.pdf");
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
  });

  it("turns other characters into underscores and caps the length", () => {
    expect(safeFilename("rate<con>\"x\".pdf")).toBe("rate_con__x_.pdf");
    expect(safeFilename(`${"a".repeat(200)}.pdf`)).toHaveLength(120);
  });

  it("names a file that has nothing left 'document'", () => {
    expect(safeFilename("")).toBe("document");
    expect(safeFilename("...")).toBe("document");
    expect(safeFilename("folder/")).toBe("document");
  });
});

describe("viewOf", () => {
  const row = (over: Partial<DocumentMetaRow> = {}): DocumentMetaRow => ({
    id: "d1",
    filename: "a.png",
    mime: "image/png",
    byte_length: 12,
    page_count: 1,
    read_status: "pending",
    read_attempts: 1,
    document_kind: null,
    reading: null,
    match: "{}",
    untrusted_input_id: null,
    read_call_id: null,
    trace_id: "t1",
    created_at: "2026-10-24T14:00:00.000Z",
    updated_at: "2026-10-24T14:58:00.000Z",
    markup_status: "none",
    markup_attempts: 0,
    markup_category: null,
    markup_at: null,
    crop_status: "none",
    crop_attempts: 0,
    crop_method: null,
    crop_category: null,
    crop_confidence: null,
    crop_quad: null,
    crop_box: null,
    crop_at: null,
    ...over,
  });

  it("calls a pending read stalled only after two minutes", () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(viewOf(row({ updated_at: at(STALLED_MS) }), NOW).stalled).toBe(false);
    expect(viewOf(row({ updated_at: at(STALLED_MS + 1) }), NOW).stalled).toBe(true);
    expect(viewOf(row({ updated_at: at(STALLED_MS + 1), read_status: "budget" }), NOW).stalled).toBe(false);
  });

  it("shows no reading for a row that is not read, and no match for a match it cannot parse", () => {
    const v = viewOf(row({ read_status: "unreadable", reading: "{}", match: "not json" }), NOW);
    expect(v.read).toBeNull();
    expect(v.match).toBeNull();
    expect(viewOf(row({ match: JSON.stringify({ found: false, reason: "unreadable" }) }), NOW).match).toEqual({
      found: false,
      reason: "unreadable",
    });
  });

  describe("markup", () => {
    const reading = JSON.stringify({
      document_kind: "lumper_receipt",
      sample_word: true,
      vendor: null,
      date_mmddyyyy: null,
      total_cents: 17_500,
      load_number: null,
      truck_unit: null,
      gallons_milli: null,
      price_cents: null,
      loaded_miles: null,
      rate_per_mile_cents: null,
      linehaul_cents: null,
      fuel_surcharge_cents: null,
      customer_name: null,
      stops: [],
      text_lines: ["Total $175.00"],
      confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])),
    });
    const match = JSON.stringify({
      found: true,
      table: "loads",
      id: "l1",
      humanRef: "BR-1",
      loadId: "l1",
      driverId: null,
      fields: [{ name: "total_cents", claim: 17_500, record: null, status: "no_record_value" }],
      notes: ["reimbursement_missing"],
      supports: "missing_reimbursement",
    });
    const readRow = (over: Partial<DocumentMetaRow> = {}) => row({ read_status: "read", reading, match, ...over });
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

    it("says whether a copy can be made, and leaves that out of a list row", () => {
      expect(viewOf(readRow(), NOW).markup).toEqual({
        status: "none",
        attemptsLeft: 3,
        category: null,
        at: null,
        stalled: false,
        eligibility: "eligible",
      });
      expect(viewOf(readRow(), NOW, { plan: false }).markup.eligibility).toBeNull();
      expect(viewOf(readRow({ mime: "application/pdf" }), NOW).markup.eligibility).toBe("not_image");
      expect(viewOf(row(), NOW).markup.eligibility).toBe("not_read");
      expect(viewOf(readRow({ match: JSON.stringify({ found: false, reason: "no_record" }) }), NOW).markup.eligibility).toBe(
        "not_matched",
      );
    });

    it("counts tries left and calls a try stalled only after three minutes", () => {
      expect(viewOf(readRow({ markup_attempts: 2, markup_status: "mismatch", markup_category: "callout_wrong" }), NOW).markup).toMatchObject({
        attemptsLeft: 1,
        category: "callout_wrong",
      });
      expect(viewOf(readRow({ markup_attempts: 9 }), NOW).markup.attemptsLeft).toBe(0);
      const marking = (ms: number) => viewOf(readRow({ markup_status: "marking", markup_at: at(ms) }), NOW).markup.stalled;
      expect(marking(MARKUP_STALLED_MS)).toBe(false);
      expect(marking(MARKUP_STALLED_MS + 1)).toBe(true);
      expect(viewOf(readRow({ markup_status: "unavailable", markup_at: at(MARKUP_STALLED_MS * 2) }), NOW).markup.stalled).toBe(false);
    });
  });

  describe("crop", () => {
    const quad = [
      { x: 10, y: 12 },
      { x: 90, y: 10 },
      { x: 92, y: 80 },
      { x: 8, y: 82 },
    ];
    const box = { x1: 8, y1: 10, x2: 92, y2: 82, width: 100, height: 100 };

    it("shows a photo never cropped as none, with nothing else", () => {
      expect(viewOf(row(), NOW).crop).toEqual({
        status: "none",
        method: null,
        category: null,
        confidence: null,
        quad: null,
        box: null,
        at: null,
      });
    });

    it("carries a kept crop's corners, box and confidence, never its bytes", () => {
      const view = viewOf(
        row({
          crop_status: "cropped",
          crop_attempts: 1,
          crop_method: "quad",
          crop_confidence: 930,
          crop_quad: JSON.stringify(quad),
          crop_box: JSON.stringify(box),
          crop_at: "2026-10-24T14:00:00.000Z",
        }),
        NOW,
      );
      expect(view.crop).toEqual({
        status: "cropped",
        method: "quad",
        category: null,
        confidence: 930,
        quad,
        box,
        at: "2026-10-24T14:00:00.000Z",
      });
      expect(JSON.stringify(view)).not.toContain("crop_bytes");
    });

    it("reads a malformed corner list or box as none rather than guessing", () => {
      const crop = (over: Partial<DocumentMetaRow>) => viewOf(row({ crop_status: "skipped", crop_category: "too_small", ...over }), NOW).crop;
      expect(crop({ crop_quad: JSON.stringify(quad.slice(0, 3)) }).quad).toBeNull();
      expect(crop({ crop_quad: JSON.stringify([...quad.slice(0, 3), { x: "1", y: 2 }]) }).quad).toBeNull();
      expect(crop({ crop_quad: "not json" }).quad).toBeNull();
      expect(crop({ crop_box: JSON.stringify({ ...box, height: null }) }).box).toBeNull();
      expect(crop({ crop_box: JSON.stringify([1, 2, 3, 4]) }).box).toBeNull();
      expect(crop({ crop_box: JSON.stringify(box) })).toMatchObject({ status: "skipped", category: "too_small", box });
    });
  });
});

describe("refusals before anything is stored", () => {
  it("refuses an upload and a read again while the switch is off", async () => {
    flags.documentsEnabled = false;
    const file = { name: "a.png", type: "image/png", bytes: PNG };
    expect(await uploadDocument(SESSION, file, { db: UNTOUCHED, now: () => NOW })).toEqual({
      ok: false,
      error: "disabled",
    });
    expect(await readAgain(SESSION, "d1", { db: UNTOUCHED, now: () => NOW })).toEqual({ ok: false, error: "disabled" });
  });

  it("refuses a file that fails its own checks without opening a transaction", async () => {
    const file = { name: "a.pdf", type: "application/pdf", bytes: pdfWithPages(4) };
    expect(await uploadDocument(SESSION, file, { db: UNTOUCHED, now: () => NOW })).toEqual({
      ok: false,
      error: "too_many_pages",
    });
  });
});
