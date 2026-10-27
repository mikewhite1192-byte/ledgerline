import { createHash } from "node:crypto";
import type { Queryable } from "../db";
import type { Agreement, StopTimes } from "./agreement";
import { readMp4Header } from "./mp4";
import { parseStoredRedaction, type StoredBox, type StoredRedaction } from "./redaction";
import type { ClipReading } from "./schema";
import type { ClipStatus, ClipStop, ClipView, StoredReading } from "./types";

// Every statement the clip pipeline runs, each inside a tenant transaction the service opens
// (row level security scopes them; no statement names a tenant). The redacted file is written by
// its own statement in its own transaction and read back by its own statement, so a failure there
// loses nothing already paid for; no statement anywhere takes the raw file.

// A lease is this many seconds: a second request for the same clip inside it is "busy", and a
// request that died holding one is free to retry once it lapses.
export const LEASE_SECONDS = 90;
export const MAX_ATTEMPTS = 3;
const LEASE_FREE = (col: string) =>
  `(${col} IS NULL OR ${col} <= now() - interval '${LEASE_SECONDS} seconds')`;
const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const ID = "CAST($1 AS uuid)";

export type Concept = "face" | "plate";
// Fixed column names per concept, so no SQL is ever built from input.
const CALL_COLUMN: Readonly<Record<Concept, string>> = { face: "face_call_id", plate: "plate_call_id" };

// Serializes one carrier's uploads (the daily count and the duplicate check), without blocking
// writes elsewhere: NO KEY UPDATE does not conflict with the key-share locks foreign keys take.
export async function lockTenantClips(q: Queryable): Promise<void> {
  const rows = await q.query<{ id: string }>(
    "SELECT id FROM tenants WHERE id = current_tenant_id() FOR NO KEY UPDATE",
  );
  if (rows.length !== 1) throw new Error("tenant row not found");
}

export async function findLoad(q: Queryable, loadId: string): Promise<{ loadNumber: string } | null> {
  const rows = await q.query<{ load_number: string }>(
    `SELECT load_number FROM loads WHERE id = ${ID}`,
    [loadId],
  );
  return rows.length === 1 ? { loadNumber: rows[0].load_number } : null;
}

// New clips today (UTC), for clipLimits.perTenantPerDay.
export async function countToday(q: Queryable): Promise<number> {
  const rows = await q.query<{ n: number }>(
    `SELECT CAST(count(*) AS integer) AS n FROM evidence_clips
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
  );
  return Number(rows[0]?.n ?? Number.NaN);
}

export type RedactState = {
  id: string;
  loadId: string;
  stop: ClipStop;
  status: ClipStatus;
  hasFace: boolean;
  hasPlate: boolean;
  attempts: number;
  leaseFree: boolean;
  traceId: string | null;
};

type RedactStateRow = {
  id: string;
  load_id: string;
  stop: ClipStop;
  status: ClipStatus;
  has_face: boolean;
  has_plate: boolean;
  redact_attempts: number;
  lease_free: boolean;
  trace_id: string | null;
};

const REDACT_STATE = `id, load_id, stop, status, face_call_id IS NOT NULL AS has_face, plate_call_id IS NOT NULL AS has_plate,
  CAST(redact_attempts AS integer) AS redact_attempts, ${LEASE_FREE("redact_started_at")} AS lease_free,
  CAST(trace_id AS text) AS trace_id`;

function redactState(row: RedactStateRow): RedactState {
  return {
    id: row.id,
    loadId: row.load_id,
    stop: row.stop,
    status: row.status,
    hasFace: row.has_face,
    hasPlate: row.has_plate,
    attempts: Number(row.redact_attempts),
    leaseFree: row.lease_free,
    traceId: row.trace_id,
  };
}

export async function findByRawHash(q: Queryable, rawHash: string): Promise<RedactState | null> {
  const rows = await q.query<RedactStateRow>(
    `SELECT ${REDACT_STATE} FROM evidence_clips WHERE raw_hash = $1`,
    [rawHash],
  );
  return rows.length === 1 ? redactState(rows[0]) : null;
}

export type NewClip = {
  id: string;
  loadId: string;
  stop: ClipStop;
  uploadedBy: string;
  filename: string;
  rawHash: string;
  rawByteLength: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationMs: number;
  traceId: string;
};

// The reservation: the row exists, holding the redaction lease and its first attempt, before any
// model call is made.
export async function insertClip(q: Queryable, c: NewClip): Promise<void> {
  await q.execute(
    `INSERT INTO evidence_clips (id, tenant_id, load_id, stop, uploaded_by, filename, raw_hash,
       raw_byte_length, width, height, frames_per_second, frame_count, duration_ms, status,
       redact_attempts, redact_started_at, trace_id)
     VALUES (${ID}, current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       'redacting', 1, now(), CAST($13 AS uuid))`,
    [
      c.id,
      c.loadId,
      c.stop,
      c.uploadedBy,
      c.filename,
      c.rawHash,
      c.rawByteLength,
      c.width,
      c.height,
      c.fps,
      c.frameCount,
      c.durationMs,
      c.traceId,
    ],
  );
}

// Takes the redaction lease for a retry and counts the attempt. Null when the clip is past
// redacting, the lease is held or the attempts are spent.
export async function takeRedactLease(q: Queryable, id: string): Promise<RedactState | null> {
  const rows = await q.query<RedactStateRow>(
    `UPDATE evidence_clips SET redact_started_at = now(), redact_attempts = redact_attempts + 1
      WHERE id = ${ID} AND status = 'redacting' AND redact_attempts < ${MAX_ATTEMPTS}
        AND ${LEASE_FREE("redact_started_at")}
      RETURNING ${REDACT_STATE}`,
    [id],
  );
  return rows.length === 1 ? redactState(rows[0]) : null;
}

// One segmentation answer, kept the moment it lands. Set once: a second save of the same concept
// changes nothing (and the trigger refuses a different one).
export async function saveConcept(
  q: Queryable,
  id: string,
  concept: Concept,
  boxes: StoredBox[],
  callId: string,
): Promise<boolean> {
  const column = CALL_COLUMN[concept];
  const n = await q.execute(
    `UPDATE evidence_clips SET redaction = redaction || CAST($2 AS jsonb), ${column} = CAST($3 AS uuid)
      WHERE id = ${ID} AND ${column} IS NULL AND status = 'redacting'`,
    [id, JSON.stringify({ [concept]: boxes }), callId],
  );
  return n === 1;
}

export async function releaseRedactLease(q: Queryable, id: string): Promise<void> {
  await q.execute(`UPDATE evidence_clips SET redact_started_at = NULL WHERE id = ${ID}`, [id]);
}

export type ClipFacts = {
  id: string;
  status: ClipStatus;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  rawHash: string;
  redactedHash: string | null;
  redaction: StoredRedaction | null;
};

type ClipFactsRow = {
  id: string;
  status: ClipStatus;
  width: number;
  height: number;
  frame_count: number;
  duration_ms: number;
  raw_hash: string;
  redacted_hash: string | null;
  redaction: string;
  has_face: boolean;
  has_plate: boolean;
};

// The facts a check needs, with the redaction boxes read back only when both answers are kept
// (a partial redaction is never a plan).
export async function clipFacts(q: Queryable, id: string): Promise<ClipFacts | null> {
  const rows = await q.query<ClipFactsRow>(
    `SELECT id, status, width, height, frame_count, duration_ms, raw_hash, redacted_hash,
            CAST(redaction AS text) AS redaction,
            face_call_id IS NOT NULL AS has_face, plate_call_id IS NOT NULL AS has_plate
       FROM evidence_clips WHERE id = ${ID}`,
    [id],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  const size = { width: Number(r.width), height: Number(r.height), frameCount: Number(r.frame_count) };
  let redaction: StoredRedaction | null = null;
  if (r.has_face && r.has_plate) {
    try {
      redaction = parseStoredRedaction(JSON.parse(r.redaction), size);
    } catch {
      redaction = null;
    }
  }
  return {
    id: r.id,
    status: r.status,
    ...size,
    durationMs: Number(r.duration_ms),
    rawHash: r.raw_hash,
    redactedHash: r.redacted_hash,
    redaction,
  };
}

// The redacted file's write, alone in its transaction. Rows affected: 1 stored, 0 when the clip
// was no longer waiting for it.
export async function storeRedactedBytes(
  q: Queryable,
  id: string,
  bytes: Uint8Array,
  hash: string,
): Promise<number> {
  return q.execute(
    `UPDATE evidence_clips SET status = 'redacted', redacted_bytes = decode($2, 'base64'),
            redacted_hash = $3, redacted_byte_length = $4, redacted_at = now(), redact_started_at = NULL
      WHERE id = ${ID} AND status = 'redacting'
        AND face_call_id IS NOT NULL AND plate_call_id IS NOT NULL`,
    [id, Buffer.from(bytes).toString("base64"), hash, bytes.length],
  );
}

export type ReadState = { status: ClipStatus; attempts: number; leaseFree: boolean; traceId: string | null };

type ReadStateRow = { status: ClipStatus; read_attempts: number; lease_free: boolean; trace_id: string | null };

const READ_STATE = `status, CAST(read_attempts AS integer) AS read_attempts,
  ${LEASE_FREE("read_started_at")} AS lease_free, CAST(trace_id AS text) AS trace_id`;

const readState = (r: ReadStateRow): ReadState => ({
  status: r.status,
  attempts: Number(r.read_attempts),
  leaseFree: r.lease_free,
  traceId: r.trace_id,
});

export async function findReadState(q: Queryable, id: string): Promise<ReadState | null> {
  const rows = await q.query<ReadStateRow>(`SELECT ${READ_STATE} FROM evidence_clips WHERE id = ${ID}`, [id]);
  return rows.length === 1 ? readState(rows[0]) : null;
}

export async function takeReadLease(q: Queryable, id: string): Promise<ReadState | null> {
  const rows = await q.query<ReadStateRow>(
    `UPDATE evidence_clips SET read_started_at = now(), read_attempts = read_attempts + 1
      WHERE id = ${ID} AND status IN ('redacted', 'budget') AND read_attempts < ${MAX_ATTEMPTS}
        AND ${LEASE_FREE("read_started_at")}
      RETURNING ${READ_STATE}`,
    [id],
  );
  return rows.length === 1 ? readState(rows[0]) : null;
}

export async function releaseReadLease(q: Queryable, id: string): Promise<void> {
  await q.execute(`UPDATE evidence_clips SET read_started_at = NULL WHERE id = ${ID}`, [id]);
}

declare const redactedBrand: unique symbol;

// The only video the reading model is ever given. Built here and nowhere else, from the redacted
// column, after its hash is checked against the one stored with it.
export type RedactedClip = {
  readonly bytes: Uint8Array;
  readonly frameCount: number;
  readonly durationMs: number;
  readonly [redactedBrand]: true;
};

// Its own statement, selecting only the file (as base64 with no line breaks, 933,336 characters
// at the 700,000 byte cap, under the Data API's 1 MiB response) and its hash. Null when the clip
// has no redacted file or the bytes do not match their hash.
export async function readRedactedBytes(q: Queryable, id: string): Promise<RedactedClip | null> {
  const rows = await q.query<{ b64: string; redacted_hash: string }>(
    `SELECT translate(encode(redacted_bytes, 'base64'), chr(10), '') AS b64, redacted_hash
       FROM evidence_clips WHERE id = ${ID} AND redacted_bytes IS NOT NULL`,
    [id],
  );
  if (rows.length !== 1 || typeof rows[0].b64 !== "string") return null;
  const bytes = new Uint8Array(Buffer.from(rows[0].b64, "base64"));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== rows[0].redacted_hash) return null;
  // The file's own header, which the model wrapper checks the frame count against (the upload
  // allowed the redacted file to differ from the raw by a frame).
  const header = readMp4Header(bytes);
  if (!header.ok) return null;
  return { bytes, frameCount: header.header.frameCount, durationMs: header.header.durationMs } as RedactedClip;
}

export type StoredStop = StopTimes;

// The stored stop times the reading is compared with, and the carrier's zone.
export async function stopTimesFor(q: Queryable, id: string): Promise<StoredStop | null> {
  const rows = await q.query<{ zone: string; arrived_at: string | null; departed_at: string | null }>(
    `SELECT t.timezone AS zone,
            CASE c.stop WHEN 'pickup' THEN ${ISO("l.pickup_arrived_at")} ELSE ${ISO("l.delivery_arrived_at")} END
              AS arrived_at,
            CASE c.stop WHEN 'pickup' THEN ${ISO("l.pickup_departed_at")} ELSE ${ISO("l.delivery_departed_at")} END
              AS departed_at
       FROM evidence_clips c
       JOIN loads l ON l.tenant_id = c.tenant_id AND l.id = c.load_id
       JOIN tenants t ON t.id = c.tenant_id
      WHERE c.id = ${ID}`,
    [id],
  );
  return rows.length === 1
    ? { zone: rows[0].zone, arrivedAt: rows[0].arrived_at, departedAt: rows[0].departed_at }
    : null;
}

// The reading's outcome, set once. Rows affected: 1 kept, 0 when another request already did.
export async function finishRead(
  q: Queryable,
  id: string,
  outcome:
    | { status: "read"; reading: ClipReading & { agreement: Agreement }; callId: string }
    | { status: "unreadable"; callId: string },
): Promise<number> {
  return q.execute(
    `UPDATE evidence_clips SET status = $2, reading = CAST($3 AS jsonb), read_call_id = CAST($4 AS uuid),
            read_at = now(), read_started_at = NULL
      WHERE id = ${ID} AND status IN ('redacted', 'budget') AND read_call_id IS NULL`,
    [id, outcome.status, outcome.status === "read" ? JSON.stringify(outcome.reading) : null, outcome.callId],
  );
}

export async function markBudget(q: Queryable, id: string): Promise<void> {
  await q.execute(
    `UPDATE evidence_clips SET status = 'budget', read_started_at = NULL
      WHERE id = ${ID} AND status IN ('redacted', 'budget')`,
    [id],
  );
}

// The spend checks would refuse the reading, so the clip waits on the cap with no try counted and
// no lease taken. Only a clip free to read (lease free, tries left) is marked. Rows affected: 1
// marked, 0 when another request holds it or its tries are spent.
export async function markBudgetUntried(q: Queryable, id: string): Promise<number> {
  return q.execute(
    `UPDATE evidence_clips SET status = 'budget'
      WHERE id = ${ID} AND status IN ('redacted', 'budget') AND read_attempts < ${MAX_ATTEMPTS}
        AND ${LEASE_FREE("read_started_at")}`,
    [id],
  );
}

type ViewRow = {
  id: string;
  load_id: string;
  load_number: string;
  stop: ClipStop;
  filename: string;
  status: ClipStatus;
  width: number;
  height: number;
  frames_per_second: number;
  frame_count: number;
  duration_ms: number;
  plan_ready: boolean;
  redacted_byte_length: number | null;
  reading: string | null;
  face_frames: number | null;
  plate_frames: number | null;
  created_at: string;
  redacted_at: string | null;
  read_at: string | null;
};

const frameCount = (concept: Concept) =>
  `(SELECT CAST(count(DISTINCT b ->> 0) AS integer) FROM jsonb_array_elements(c.redaction -> '${concept}') b)`;

// No byte column and no hash: a view is small and says nothing about the raw file.
const VIEW = `SELECT c.id, c.load_id, l.load_number, c.stop, c.filename, c.status, c.width, c.height,
         c.frames_per_second, c.frame_count, c.duration_ms,
         c.face_call_id IS NOT NULL AND c.plate_call_id IS NOT NULL AS plan_ready,
         c.redacted_byte_length, CAST(c.reading AS text) AS reading,
         CASE WHEN c.face_call_id IS NOT NULL THEN ${frameCount("face")} END AS face_frames,
         CASE WHEN c.plate_call_id IS NOT NULL THEN ${frameCount("plate")} END AS plate_frames,
         ${ISO("c.created_at")} AS created_at, ${ISO("c.redacted_at")} AS redacted_at,
         ${ISO("c.read_at")} AS read_at
    FROM evidence_clips c
    JOIN loads l ON l.tenant_id = c.tenant_id AND l.id = c.load_id`;

function storedReading(text: string | null): StoredReading | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as StoredReading) : null;
  } catch {
    return null;
  }
}

function view(r: ViewRow): ClipView {
  return {
    id: r.id,
    loadId: r.load_id,
    loadNumber: r.load_number,
    stop: r.stop,
    filename: r.filename,
    status: r.status,
    width: Number(r.width),
    height: Number(r.height),
    fps: Number(r.frames_per_second),
    frameCount: Number(r.frame_count),
    durationMs: Number(r.duration_ms),
    planReady: r.plan_ready,
    redactedByteLength: r.redacted_byte_length === null ? null : Number(r.redacted_byte_length),
    reading: storedReading(r.reading),
    coverage:
      r.face_frames === null || r.plate_frames === null
        ? null
        : { faceFrames: Number(r.face_frames), plateFrames: Number(r.plate_frames) },
    createdAt: r.created_at,
    redactedAt: r.redacted_at,
    readAt: r.read_at,
  };
}

export async function clipView(q: Queryable, id: string): Promise<ClipView | null> {
  const rows = await q.query<ViewRow>(`${VIEW} WHERE c.id = ${ID}`, [id]);
  return rows.length === 1 ? view(rows[0]) : null;
}

export const LIST_LIMIT = 50;

export async function listViews(q: Queryable, loadId: string | null): Promise<ClipView[]> {
  const rows = loadId
    ? await q.query<ViewRow>(`${VIEW} WHERE c.load_id = ${ID} ORDER BY c.created_at DESC LIMIT ${LIST_LIMIT}`, [
        loadId,
      ])
    : await q.query<ViewRow>(`${VIEW} ORDER BY c.created_at DESC LIMIT ${LIST_LIMIT}`);
  return rows.map(view);
}

export async function redactedFile(q: Queryable, id: string): Promise<Uint8Array | null> {
  const clip = await readRedactedBytes(q, id);
  return clip ? clip.bytes : null;
}
