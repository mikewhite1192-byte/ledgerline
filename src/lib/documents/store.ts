import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { untrustedContentHash } from "../data/content-hash";
import { transcriptionOf } from "./schema";
import {
  READ_ATTEMPTS_MAX,
  type DocumentKind,
  type DocumentMime,
  type DocumentRead,
  type ReadStatus,
} from "./types";

// The documents table, inside a tenant transaction the caller opened (row-level security scopes
// every statement, and each one also names the tenant). Bytes travel as base64 both ways; no
// statement here but readDocumentBytes ever selects them.

export type DocumentMetaRow = {
  id: string;
  filename: string;
  mime: DocumentMime;
  byte_length: number;
  page_count: number;
  read_status: ReadStatus;
  read_attempts: number;
  document_kind: DocumentKind | null;
  reading: string | null;
  match: string;
  untrusted_input_id: string | null;
  read_call_id: string | null;
  trace_id: string;
  created_at: string;
  updated_at: string;
};

const columns = (reading: string) =>
  "id, filename, mime, byte_length, page_count, read_status, read_attempts, document_kind," +
  ` ${reading} AS reading, CAST(match AS text) AS match, untrusted_input_id,` +
  " read_call_id, trace_id," +
  ` to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,` +
  ` to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

const META_COLUMNS = columns("CAST(reading AS text)");

// The list leaves out the transcription (up to 80 lines of 160 characters a row): 50 full
// readings could near the Data API's 1 MiB answer limit. An empty list keeps the strict shape.
export const LIST_COLUMNS = columns("CAST(jsonb_set(reading, '{text_lines}', '[]'::jsonb) AS text)");

export type NewDocument = {
  id: string;
  uploadedBy: string;
  filename: string;
  mime: DocumentMime;
  byteLength: number;
  bytesBase64: string;
  contentHash: string;
  pageCount: number;
  traceId: string;
};

// Uploads by one tenant are counted and inserted one at a time: this lock holds to the end of the
// transaction, so two uploads at once cannot both pass the daily count.
export async function lockTenantUploads(q: Queryable): Promise<void> {
  await q.query(
    "SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended('documents:' || CAST(current_tenant_id() AS text), 0))) AS l",
  );
}

// Uploads in the 24 hours before now (a rolling day, so the count never resets at a midnight).
export async function countRecentUploads(q: Queryable, nowIso: string): Promise<number> {
  const rows = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM documents
      WHERE tenant_id = current_tenant_id()
        AND created_at > CAST($1 AS timestamptz) - interval '24 hours'`,
    [nowIso],
  );
  const n = Number(rows[0]?.n);
  if (!Number.isSafeInteger(n)) throw new Error("count is not a number");
  return n;
}

// 1 when inserted, 0 when this tenant already holds the same file (content_hash).
export async function insertDocument(q: Queryable, d: NewDocument, nowIso: string): Promise<number> {
  return q.execute(
    `INSERT INTO documents
       (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash, page_count,
        trace_id, created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, $5, decode($6, 'base64'), $7, $8,
             CAST($9 AS uuid), CAST($10 AS timestamptz), CAST($10 AS timestamptz))
     ON CONFLICT (tenant_id, content_hash) DO NOTHING`,
    [d.id, d.uploadedBy, d.filename, d.mime, d.byteLength, d.bytesBase64, d.contentHash, d.pageCount, d.traceId, nowIso],
  );
}

export async function findDocumentByHash(q: Queryable, contentHash: string): Promise<DocumentMetaRow | null> {
  const rows = await q.query<DocumentMetaRow>(
    `SELECT ${META_COLUMNS} FROM documents WHERE tenant_id = current_tenant_id() AND content_hash = $1`,
    [contentHash],
  );
  return rows[0] ?? null;
}

export async function readDocumentMeta(
  q: Queryable,
  id: string,
  opts: { lock?: boolean } = {},
): Promise<DocumentMetaRow | null> {
  const rows = await q.query<DocumentMetaRow>(
    `SELECT ${META_COLUMNS} FROM documents
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)${opts.lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function readDocumentBytes(
  q: Queryable,
  id: string,
): Promise<{ mime: DocumentMime; base64: string } | null> {
  const rows = await q.query<{ mime: DocumentMime; base64: string }>(
    `SELECT mime, encode(bytes, 'base64') AS base64 FROM documents
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listDocumentRows(q: Queryable, limit = 50): Promise<DocumentMetaRow[]> {
  const n = Math.max(1, Math.min(50, Math.trunc(limit)));
  return q.query<DocumentMetaRow>(
    `SELECT ${LIST_COLUMNS} FROM documents WHERE tenant_id = current_tenant_id()
      ORDER BY created_at DESC, id DESC LIMIT ${n}`,
  );
}

// Read again takes the pending row only when its last attempt is older than the cutoff and it
// has attempts left, and marks the new attempt (time and count), so two clicks start one read
// and a read that keeps failing stops at READ_ATTEMPTS_MAX. 1 when taken.
export async function claimStalledRead(
  q: Queryable,
  id: string,
  cutoffIso: string,
  nowIso: string,
): Promise<number> {
  return q.execute(
    `UPDATE documents SET updated_at = CAST($3 AS timestamptz), read_attempts = read_attempts + 1
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND read_status = 'pending' AND updated_at < CAST($2 AS timestamptz) AND read_attempts < $4`,
    [id, cutoffIso, nowIso, READ_ATTEMPTS_MAX],
  );
}

export type ReadPatch = {
  readStatus: Exclude<ReadStatus, "pending">;
  kind: DocumentKind | null;
  reading: Record<string, unknown> | null;
  match: Record<string, unknown>;
  inputId: string | null;
  callId: string | null;
};

// Finishes a pending read, once. 1 when this call finished it, 0 when it was already finished.
export async function finishRead(q: Queryable, id: string, patch: ReadPatch, nowIso: string): Promise<number> {
  return q.execute(
    `UPDATE documents
        SET read_status = $2, document_kind = $3, reading = CAST($4 AS jsonb),
            match = CAST($5 AS jsonb), untrusted_input_id = CAST($6 AS uuid),
            read_call_id = CAST($7 AS uuid), updated_at = CAST($8 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND read_status = 'pending'`,
    [
      id,
      patch.readStatus,
      patch.kind,
      patch.reading === null ? null : JSON.stringify(patch.reading),
      JSON.stringify(patch.match),
      patch.inputId,
      patch.callId,
      nowIso,
    ],
  );
}

// The document's transcription (transcriptionOf: the printed lines and every string value read)
// as an outside input the gateway screens before any model sees it. One row per document: the
// screening cache already dedupes equal text by its content hash. Returns the new input's id.
export async function insertTranscription(q: Queryable, read: DocumentRead, nowIso: string): Promise<string> {
  const text = transcriptionOf(read);
  const id = randomUUID();
  await q.execute(
    `INSERT INTO untrusted_inputs (id, tenant_id, kind, source, body_text, content_hash, received_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'document', 'upload', $2, $3, CAST($4 AS timestamptz))`,
    [id, text, untrustedContentHash("document", text), nowIso],
  );
  return id;
}
