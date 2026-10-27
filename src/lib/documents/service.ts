import { createHash, randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { looksLike, pdfPages } from "../ai/providers/media";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { loadCandidates } from "./candidates";
import { matchDocument } from "./match";
import { readDocument, type ReadDeps, type ReadOutcome } from "./read";
import { parseRead, rawOf } from "./schema";
import {
  claimStalledRead,
  countRecentUploads,
  findDocumentByHash,
  finishRead,
  insertDocument,
  insertTranscription,
  listDocumentRows,
  lockTenantUploads,
  readDocumentBytes,
  readDocumentMeta,
  type DocumentMetaRow,
  type ReadPatch,
} from "./store";
import { DOCUMENT_MIMES, type DocumentMime, type DocumentView, type MatchResult } from "./types";

// What the document routes call. Each step opens its own short tenant transaction with the
// membership check; the model read runs between them, never inside one (it can take 25 seconds).
//
// Upload: check the file, then in one transaction take the tenant's upload lock, return the
// existing row for a file already held (no second read, no second charge), refuse past the daily
// count, and insert the row as pending. Then one Muse Spark read. Then in a second transaction,
// with the row locked and still pending, store the transcription as an outside input, match the
// reading against the records, and finish the row. A crash between the two leaves the row
// pending; after two minutes the page offers Read again, which takes the row with a lease (so
// two clicks start one read) and does the same work.

export const STALLED_MS = 2 * 60 * 1000;

export type ServiceDeps = { db?: TenantDb; now?: () => Date; read?: ReadDeps };

export type UploadFile = { name: string; type: string; bytes: Uint8Array };

export type UploadRefusal = "disabled" | "too_large" | "unsupported" | "too_many_pages" | "limit";

export type UploadOutcome =
  | { ok: true; view: DocumentView; duplicate: boolean }
  | { ok: false; error: UploadRefusal };

export type ReadAgainOutcome =
  | { ok: true; view: DocumentView }
  | { ok: false; error: "disabled" | "not_found" | "already_read" | "in_progress" };

export type CheckedFile = { ok: true; mime: DocumentMime; pageCount: number } | { ok: false; error: UploadRefusal };

// The file's own checks, before anything is stored: size, a type on the allowlist whose bytes
// look like that type, and a PDF of at most maxPdfPages pages (a PDF whose pages cannot be
// counted reads as the 50-page worst case, so it is refused too).
export function checkUpload(file: UploadFile): CheckedFile {
  const limits = flags.documentLimits;
  if (file.bytes.byteLength > limits.maxBytes) return { ok: false, error: "too_large" };
  if (file.bytes.byteLength === 0) return { ok: false, error: "unsupported" };
  const mime = (DOCUMENT_MIMES as readonly string[]).includes(file.type) ? (file.type as DocumentMime) : null;
  if (!mime || !looksLike(mime, file.bytes)) return { ok: false, error: "unsupported" };
  if (mime !== "application/pdf") return { ok: true, mime, pageCount: 1 };
  const pages = pdfPages(file.bytes);
  if (pages > limits.maxPdfPages) return { ok: false, error: "too_many_pages" };
  return { ok: true, mime, pageCount: pages };
}

// A file name the table accepts: allowed characters kept, anything else an underscore.
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").trim().slice(0, 120).trim();
  return cleaned === "" || /^[._ -]+$/.test(cleaned) ? "document" : cleaned;
}

function parseMatch(text: string): MatchResult | null {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const m = v as Record<string, unknown>;
    if (m.found === true && Array.isArray(m.fields) && Array.isArray(m.notes)) return m as MatchResult;
    if (m.found === false && typeof m.reason === "string") return m as MatchResult;
    return null;
  } catch {
    return null;
  }
}

export function viewOf(row: DocumentMetaRow, now: Date): DocumentView {
  const read = row.read_status === "read" && row.reading !== null ? parseRead(row.reading) : null;
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    byteLength: Number(row.byte_length),
    pageCount: Number(row.page_count),
    readStatus: row.read_status,
    kind: row.document_kind,
    read,
    match: parseMatch(row.match),
    inputId: row.untrusted_input_id,
    readCallId: row.read_call_id,
    traceId: row.trace_id,
    createdAt: row.created_at,
    stalled:
      row.read_status === "pending" && new Date(row.updated_at).getTime() < now.getTime() - STALLED_MS,
  };
}

function tx<T>(db: TenantDb, session: Session, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base64Of = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

async function patchFor(q: Queryable, outcome: ReadOutcome, nowIso: string): Promise<ReadPatch> {
  if (!outcome.ok) {
    return {
      readStatus: outcome.status,
      kind: null,
      reading: null,
      match: { found: false, reason: "unreadable" },
      inputId: null,
      callId: outcome.callId,
    };
  }
  const inputId = await insertTranscription(q, outcome.read.textLines, nowIso);
  // A failed record read leaves the comparison empty (not compared), never "no record".
  let match: Record<string, unknown> = {};
  try {
    match = matchDocument(outcome.read, await loadCandidates(q, outcome.read)) as Record<string, unknown>;
  } catch (err) {
    console.error("documents: match failed:", err instanceof Error ? err.name : "unknown");
  }
  return {
    readStatus: "read",
    kind: outcome.read.kind,
    reading: rawOf(outcome.read),
    match,
    inputId,
    callId: outcome.callId,
  };
}

async function readAndFinish(
  session: Session,
  doc: { id: string; bytes: Uint8Array; mime: DocumentMime; traceId: string },
  deps: ServiceDeps,
): Promise<DocumentView> {
  const db = deps.db ?? getDb();
  const clock = deps.now ?? (() => new Date());
  const outcome = await readDocument(
    { documentId: doc.id, bytes: doc.bytes, mime: doc.mime, traceId: doc.traceId },
    session,
    deps.read,
  );
  const now = clock();
  const view = await tx(db, session, async (q) => {
    const row = await readDocumentMeta(q, doc.id, { lock: true });
    if (!row) throw new Error("document vanished");
    if (row.read_status === "pending") {
      const patch = await patchFor(q, outcome, now.toISOString());
      await finishRead(q, doc.id, patch, now.toISOString());
    }
    const after = await readDocumentMeta(q, doc.id);
    if (!after) throw new Error("document vanished");
    return viewOf(after, now);
  });
  const cost = outcome.ok ? outcome.costNanocents : 0;
  console.log(`documents: read ${doc.id} status=${view.readStatus} kind=${view.kind ?? "none"} cost=${cost}`);
  return view;
}

export async function uploadDocument(
  session: Session,
  file: UploadFile,
  deps: ServiceDeps = {},
): Promise<UploadOutcome> {
  if (!flags.documentsEnabled) return { ok: false, error: "disabled" };
  const checked = checkUpload(file);
  if (!checked.ok) return checked;
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const id = randomUUID();
  const traceId = randomUUID();
  const contentHash = sha256(file.bytes);
  const first = await tx(db, session, async (q) => {
    await lockTenantUploads(q);
    const existing = await findDocumentByHash(q, contentHash);
    if (existing) return { existing };
    const recent = await countRecentUploads(q, nowIso);
    if (recent >= flags.documentLimits.perTenantPerDay) return { limit: true as const };
    const inserted = await insertDocument(
      q,
      {
        id,
        uploadedBy: session.sub,
        filename: safeFilename(file.name),
        mime: checked.mime,
        byteLength: file.bytes.byteLength,
        bytesBase64: base64Of(file.bytes),
        contentHash,
        pageCount: checked.pageCount,
        traceId,
      },
      nowIso,
    );
    if (inserted !== 1) {
      const again = await findDocumentByHash(q, contentHash);
      if (again) return { existing: again };
      throw new Error("document insert took no row");
    }
    return { inserted: true as const };
  });
  if ("existing" in first && first.existing) return { ok: true, view: viewOf(first.existing, now), duplicate: true };
  if ("limit" in first) return { ok: false, error: "limit" };
  const view = await readAndFinish(session, { id, bytes: file.bytes, mime: checked.mime, traceId }, deps);
  return { ok: true, view, duplicate: false };
}

export async function readAgain(
  session: Session,
  id: string,
  deps: ServiceDeps = {},
): Promise<ReadAgainOutcome> {
  if (!flags.documentsEnabled) return { ok: false, error: "disabled" };
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  type Claim =
    | { error: "not_found" | "already_read" | "in_progress" }
    | { row: DocumentMetaRow; file: { mime: DocumentMime; base64: string } };
  const claimed = await tx(db, session, async (q): Promise<Claim> => {
    const row = await readDocumentMeta(q, id, { lock: true });
    if (!row) return { error: "not_found" };
    if (row.read_status !== "pending") return { error: "already_read" };
    const cutoff = new Date(now.getTime() - STALLED_MS).toISOString();
    if ((await claimStalledRead(q, id, cutoff, now.toISOString())) !== 1) return { error: "in_progress" };
    const file = await readDocumentBytes(q, id);
    if (!file) return { error: "not_found" };
    return { row, file };
  });
  if ("error" in claimed) return { ok: false, error: claimed.error };
  const bytes = new Uint8Array(Buffer.from(claimed.file.base64.replace(/\s+/g, ""), "base64"));
  const view = await readAndFinish(
    session,
    { id, bytes, mime: claimed.file.mime, traceId: claimed.row.trace_id },
    deps,
  );
  return { ok: true, view };
}

export async function getDocument(session: Session, id: string, deps: ServiceDeps = {}): Promise<DocumentView | null> {
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const row = await tx(db, session, (q) => readDocumentMeta(q, id));
  return row ? viewOf(row, now) : null;
}

export async function listDocuments(session: Session, deps: ServiceDeps = {}): Promise<DocumentView[]> {
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const rows = await tx(db, session, (q) => listDocumentRows(q, 50));
  return rows.map((r) => viewOf(r, now));
}

export async function readDocumentFile(
  session: Session,
  id: string,
  deps: ServiceDeps = {},
): Promise<{ mime: DocumentMime; bytes: Uint8Array } | null> {
  const db = deps.db ?? getDb();
  const file = await tx(db, session, (q) => readDocumentBytes(q, id));
  if (!file) return null;
  return { mime: file.mime, bytes: new Uint8Array(Buffer.from(file.base64.replace(/\s+/g, ""), "base64")) };
}
