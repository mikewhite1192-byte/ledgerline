import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { checkUpload, readAgain, safeFilename, STALLED_MS, uploadDocument, viewOf } from "./service";
import type { DocumentMetaRow } from "./store";

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
    document_kind: null,
    reading: null,
    match: "{}",
    untrusted_input_id: null,
    read_call_id: null,
    trace_id: "t1",
    created_at: "2026-10-24T14:00:00.000Z",
    updated_at: "2026-10-24T14:58:00.000Z",
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
