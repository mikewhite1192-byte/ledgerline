import { createHash, randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { looksLike, pdfPages } from "../ai/providers/media";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { loadCandidates } from "./candidates";
import { cropDocument, type CropDeps, type CropOutcome } from "./crop";
import { matchDocument } from "./match";
import { planMarkup } from "./markup-text";
import { READ_TIMEOUT_MS, readDocument, type ReadDeps, type ReadOutcome } from "./read";
import { parseRead, rawOf } from "./schema";
import {
  claimCrop,
  claimStalledRead,
  countRecentUploads,
  findDocumentByHash,
  finishCrop,
  finishRead,
  insertDocument,
  insertTranscription,
  listDocumentRows,
  lockTenantUploads,
  readCropBytes,
  readDocumentBytes,
  readDocumentMeta,
  reclaimStalledCrop,
  releaseCrop,
  type CropEnding,
  type DocumentMetaRow,
  type ReadPatch,
} from "./store";
import {
  DOCUMENT_MIMES,
  MARKUP_ATTEMPTS_MAX,
  READ_ATTEMPTS_MAX,
  type CropBox,
  type CropPoint,
  type CropView,
  type DocumentMime,
  type DocumentRead,
  type DocumentView,
  type MarkupView,
  type MatchResult,
} from "./types";

// What the document routes call. Each step opens its own short tenant transaction with the
// membership check; the model read runs between them, never inside one (it can take 25 seconds).
//
// Upload: check the file, then in one transaction take the tenant's upload lock, return the
// existing row for a file already held (no second read, no second charge), refuse past the daily
// count, and insert the row as pending. Then one Muse Spark read. Then in a second transaction,
// with the row locked and still pending, store the transcription as an outside input, match the
// reading against the records, and finish the row. A crash between the two, or a read whose
// outcome is not known (a timeout, a 5xx), leaves the row pending; after two minutes the page
// offers Read again, which takes the row with a lease (so two clicks start one read) and does the
// same work. A row gets READ_ATTEMPTS_MAX reads in all, the upload's included.
//
// With flags.documentCrop on, a photo is cropped to the paper before its read (prepareForRead):
// the kept crop when the row has one, else a new try when one may start, else the file as
// uploaded. The crop never changes the stored file, its content hash or the read itself.

export const STALLED_MS = 2 * 60 * 1000;

// A marked copy's try runs one edit (up to 60 seconds) and one check (up to 25): one marked
// running for longer than this lost its request, so another try may start.
export const MARKUP_STALLED_MS = 3 * 60 * 1000;

// The hosting server ends a request at 30 seconds, so the crop and the read share 27 of them,
// with 2 kept for the finish transaction. A read is not started with under 10 seconds left: the
// row stays pending for Read again, which reads a kept crop with no second segment call.
export const REQUEST_BUDGET_MS = 27_000;
export const FINISH_RESERVE_MS = 2_000;
export const MIN_READ_MS = 10_000;

export type ServiceDeps = {
  db?: TenantDb;
  now?: () => Date;
  read?: ReadDeps;
  crop?: CropDeps;
  // A monotonic clock for the request's time budget.
  steady?: () => number;
};

export type UploadFile = { name: string; type: string; bytes: Uint8Array };

export type UploadRefusal = "disabled" | "too_large" | "unsupported" | "too_many_pages" | "limit";

export type UploadOutcome =
  | { ok: true; view: DocumentView; duplicate: boolean }
  | { ok: false; error: UploadRefusal };

export type ReadAgainOutcome =
  | { ok: true; view: DocumentView }
  | { ok: false; error: "disabled" | "not_found" | "already_read" | "in_progress" | "attempt_limit" };

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

function markupOf(
  row: DocumentMetaRow,
  doc: { read: DocumentRead | null; match: MatchResult | null },
  now: Date,
  withPlan: boolean,
): MarkupView {
  const attempts = Number(row.markup_attempts);
  const plan = withPlan ? planMarkup({ mime: row.mime, read: doc.read, match: doc.match }) : null;
  return {
    status: row.markup_status,
    attemptsLeft: Number.isSafeInteger(attempts) ? Math.max(0, MARKUP_ATTEMPTS_MAX - attempts) : 0,
    category: row.markup_category,
    at: row.markup_at,
    stalled:
      row.markup_status === "marking" &&
      row.markup_at !== null &&
      new Date(row.markup_at).getTime() < now.getTime() - MARKUP_STALLED_MS,
    eligibility: plan === null ? null : plan.ok ? "eligible" : plan.reason,
  };
}

function jsonOf(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function quadOf(text: string | null): CropPoint[] | null {
  const v = jsonOf(text);
  if (!Array.isArray(v) || v.length !== 4) return null;
  const points: CropPoint[] = [];
  for (const p of v) {
    const r = p !== null && typeof p === "object" ? (p as Record<string, unknown>) : null;
    if (!r || !isNumber(r.x) || !isNumber(r.y)) return null;
    points.push({ x: r.x, y: r.y });
  }
  return points;
}

function boxOf(text: string | null): CropBox | null {
  const v = jsonOf(text);
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  if (![b.x1, b.y1, b.x2, b.y2, b.width, b.height].every(isNumber)) return null;
  return {
    x1: b.x1 as number,
    y1: b.y1 as number,
    x2: b.x2 as number,
    y2: b.y2 as number,
    width: b.width as number,
    height: b.height as number,
  };
}

function cropOf(row: DocumentMetaRow): CropView {
  const confidence = row.crop_confidence === null ? null : Number(row.crop_confidence);
  return {
    status: row.crop_status,
    method: row.crop_method,
    category: row.crop_category,
    confidence: confidence !== null && Number.isSafeInteger(confidence) ? confidence : null,
    quad: quadOf(row.crop_quad),
    box: boxOf(row.crop_box),
    at: row.crop_at,
  };
}

// opts.plan false (a list row, which carries no transcription): the markup's eligibility is null.
export function viewOf(row: DocumentMetaRow, now: Date, opts: { plan?: boolean } = {}): DocumentView {
  const read = row.read_status === "read" && row.reading !== null ? parseRead(row.reading) : null;
  const match = parseMatch(row.match);
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    byteLength: Number(row.byte_length),
    pageCount: Number(row.page_count),
    readStatus: row.read_status,
    kind: row.document_kind,
    read,
    match,
    inputId: row.untrusted_input_id,
    readCallId: row.read_call_id,
    traceId: row.trace_id,
    createdAt: row.created_at,
    stalled:
      row.read_status === "pending" && new Date(row.updated_at).getTime() < now.getTime() - STALLED_MS,
    readAttempts: Number(row.read_attempts),
    markup: markupOf(row, { read, match }, now, opts.plan ?? true),
    crop: cropOf(row),
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
const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64.replace(/\s+/g, ""), "base64"));

async function patchFor(
  q: Queryable,
  outcome: Exclude<ReadOutcome, { status: "retry" }>,
  nowIso: string,
): Promise<ReadPatch> {
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
  const inputId = await insertTranscription(q, outcome.read, nowIso);
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

function endingOf(outcome: Exclude<CropOutcome, { status: "off" }>): CropEnding {
  if (outcome.status !== "cropped") return outcome;
  return {
    status: "cropped",
    method: outcome.method,
    bytesBase64: base64Of(outcome.bytes),
    byteLength: outcome.bytes.byteLength,
    hash: outcome.hash,
    quad: outcome.quad,
    box: outcome.box,
    confidence: outcome.confidence,
    callId: outcome.callId,
  };
}

// The image the read uses. In a short transaction: a try marked running for longer than
// STALLED_MS ends stalled, then the row's next try is claimed (a photo never tried, or one whose
// last try had no answer, with tries left). Not claimed: the kept crop when there is one, else
// the file as uploaded. Claimed: the segment call and the warp run outside any transaction, then
// one write under the claim ends the try, and the read uses the crop only when that write kept
// it. Any failure here reads the file as uploaded; a crash leaves the row cropping, which the
// next Read again ends stalled.
async function prepareForRead(
  session: Session,
  doc: { id: string; bytes: Uint8Array; mime: DocumentMime; traceId: string },
  deps: ServiceDeps,
): Promise<{ bytes: Uint8Array; mime: DocumentMime }> {
  const raw = { bytes: doc.bytes, mime: doc.mime };
  if (!flags.documentCrop || doc.mime === "application/pdf") return raw;
  const mime = doc.mime;
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  try {
    const claimed = await tx(db, session, async (q) => {
      await reclaimStalledCrop(q, doc.id, new Date(now.getTime() - STALLED_MS).toISOString());
      const attempt = await claimCrop(q, doc.id, nowIso);
      if (attempt !== null) return { lease: { attempt, atIso: nowIso } };
      return { kept: await readCropBytes(q, doc.id) };
    });
    if ("kept" in claimed) {
      return claimed.kept ? { bytes: bytesOf(claimed.kept.base64), mime: "image/jpeg" } : raw;
    }
    const lease = claimed.lease;
    const outcome = await cropDocument(
      { documentId: doc.id, bytes: doc.bytes, mime, traceId: doc.traceId },
      session,
      deps.crop,
    );
    const wrote = await tx(db, session, (q) =>
      outcome.status === "off" ? releaseCrop(q, doc.id, lease) : finishCrop(q, doc.id, lease, endingOf(outcome)),
    );
    if (wrote !== 1) {
      console.error(`documents: crop ${doc.id} lost its claim before the try ended`);
      return raw;
    }
    if (outcome.status === "off") return raw;
    if (outcome.status === "cropped") {
      console.log(`documents: crop ${doc.id} status=cropped method=${outcome.method}`);
      return { bytes: outcome.bytes, mime: "image/jpeg" };
    }
    console.log(`documents: crop ${doc.id} status=${outcome.status} category=${outcome.category}`);
    return raw;
  } catch (err) {
    console.error(`documents: crop ${doc.id} failed error=${(err as Error)?.name ?? "unknown"}`);
    return raw;
  }
}

// The read's timeout once elapsedMs of the request has gone: READ_TIMEOUT_MS with none gone (the
// crop off), else what the budget has left less the finish's reserve. Null when that is under
// MIN_READ_MS, or the clock gave no number.
export function readTimeoutFor(elapsedMs: number): number | null {
  if (!Number.isFinite(elapsedMs)) return null;
  const left = REQUEST_BUDGET_MS - Math.max(0, Math.floor(elapsedMs)) - FINISH_RESERVE_MS;
  const timeoutMs = Math.min(READ_TIMEOUT_MS, left);
  return timeoutMs >= MIN_READ_MS ? timeoutMs : null;
}

async function readAndFinish(
  session: Session,
  doc: { id: string; bytes: Uint8Array; mime: DocumentMime; traceId: string },
  deps: ServiceDeps,
): Promise<DocumentView> {
  const db = deps.db ?? getDb();
  const clock = deps.now ?? (() => new Date());
  const steady = deps.steady ?? (() => performance.now());
  const started = steady();
  const image = await prepareForRead(session, doc, deps);
  const elapsed = steady() - started;
  const timeoutMs = readTimeoutFor(elapsed);
  let outcome: ReadOutcome;
  if (timeoutMs === null) {
    // Too little of the request is left: no read, and the outcome a timeout would have.
    console.error(`documents: read ${doc.id} not started category=deadline elapsed=${Math.round(elapsed)}`);
    outcome = { ok: false, status: "retry", category: "model_error", callId: null };
  } else {
    outcome = await readDocument(
      { documentId: doc.id, bytes: image.bytes, mime: image.mime, traceId: doc.traceId, timeoutMs },
      session,
      deps.read,
    );
  }
  const now = clock();
  const view = await tx(db, session, async (q) => {
    const row = await readDocumentMeta(q, doc.id, { lock: true });
    if (!row) throw new Error("document vanished");
    // A read whose outcome is not known leaves the row pending, so Read again can take it later.
    if (row.read_status === "pending" && (outcome.ok || outcome.status !== "retry")) {
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
    | { error: "not_found" | "already_read" | "in_progress" | "attempt_limit" }
    | { row: DocumentMetaRow; file: { mime: DocumentMime; base64: string } };
  const claimed = await tx(db, session, async (q): Promise<Claim> => {
    const row = await readDocumentMeta(q, id, { lock: true });
    if (!row) return { error: "not_found" };
    if (row.read_status !== "pending") return { error: "already_read" };
    if (Number(row.read_attempts) >= READ_ATTEMPTS_MAX) return { error: "attempt_limit" };
    const cutoff = new Date(now.getTime() - STALLED_MS).toISOString();
    if ((await claimStalledRead(q, id, cutoff, now.toISOString())) !== 1) return { error: "in_progress" };
    const file = await readDocumentBytes(q, id);
    if (!file) return { error: "not_found" };
    return { row, file };
  });
  if ("error" in claimed) return { ok: false, error: claimed.error };
  const view = await readAndFinish(
    session,
    { id, bytes: bytesOf(claimed.file.base64), mime: claimed.file.mime, traceId: claimed.row.trace_id },
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
  return rows.map((r) => viewOf(r, now, { plan: false }));
}

export async function readDocumentFile(
  session: Session,
  id: string,
  deps: ServiceDeps = {},
): Promise<{ mime: DocumentMime; bytes: Uint8Array } | null> {
  const db = deps.db ?? getDb();
  const file = await tx(db, session, (q) => readDocumentBytes(q, id));
  if (!file) return null;
  return { mime: file.mime, bytes: bytesOf(file.base64) };
}

// The kept crop, for a later page: only a cropped row holds one, so any other answers null.
export async function readCropFile(
  session: Session,
  id: string,
  deps: ServiceDeps = {},
): Promise<{ mime: "image/jpeg"; bytes: Uint8Array } | null> {
  const db = deps.db ?? getDb();
  const file = await tx(db, session, (q) => readCropBytes(q, id));
  if (!file || file.mime !== "image/jpeg") return null;
  return { mime: "image/jpeg", bytes: bytesOf(file.base64) };
}
