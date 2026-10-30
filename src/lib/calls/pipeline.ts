import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, transcribe, type TranscribeResult } from "../ai";
import { readWav } from "../ai/wav";
import { readDriverCode } from "../advances/read";
import { screenUntrustedInput } from "../agent/gateway";
import { UNTRUSTED_WARNING } from "../agent/gateway/tools/read/get-inbound-message";
import type { CompleteFn, GatewayContext, GatewayDeps } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { untrustedContentHash } from "../data/content-hash";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { readTenantZone } from "../money/read";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { handOffVoiceNote, MIN_CALL_MS, STEP_BUDGET_MS, type HandOffResult, type VoiceDeps } from "../voice/pipeline";
import {
  CALL_UPDATE_FORMAT,
  CALL_UPDATE_SYSTEM,
  capChars,
  HAND_OFF_KINDS,
  MAX_TURNS,
  parseUpdates,
  turnLines,
  type LineTurn,
  type TurnUpdate,
  type UpdateKind,
} from "./update";

// The phone line: a dispatcher's call with a driver, posted by the office's browser as segments
// of up to 30 seconds. Each segment is one request, in steps, each resumable from
// call_segments.status:
//   1. reserve: the call (made on its first segment, its driver resolved, the day's calls
//      counted in the carrier's zone) and the segment row, keyed by (call, seq), before any model
//      call. A re-sent segment reads its row: a finished one answers what it stored.
//   2. transcribe (Muse Voice Transcribe, turns split at pauses): the turns as lines become one
//      untrusted input, and each turn a call_turns row. Status 'transcribed', or 'empty'.
//   3. the gateway's safety screen (Muse Spark Open). 'blocked' stops here.
//   4. one Muse Spark call reads a case update per turn (update.ts). Status 'done'. The first
//      advance request or pay question becomes an ordinary voice note, 'ready', and is handed to
//      the agent through the voice note's own hand-off, which reads and proposes; a person
//      approves on the card.
// Nothing here decides an amount or moves money. Users and stored reasons get categories only;
// the log gets an error's name, never audio, a transcript or upstream text. The audio is never
// stored (owner decision 2).

export const SEGMENT_TRANSCRIBE = { purpose: "call_segment_transcribe", maxCostCents: 1, timeoutMs: 15_000 } as const;
// Reasoning counts against the output budget, so the update reasons at the least effort and an
// English turn's copy is left empty for the parser to fill from the turn's own words.
export const SEGMENT_UPDATE = {
  purpose: "call_segment_update",
  timeoutMs: 12_000,
  maxOutputTokens: 700,
  reasoningEffort: "minimal",
} as const;

// The words a segment listens for: the voice note's six, the trucking words a pay call uses, and
// the driver's code.
export const CALL_KEYWORDS = [
  "advance",
  "adelanto",
  "fuel",
  "diesel",
  "settlement",
  "pay",
  "lumper",
  "TONU",
  "detention",
  "layover",
  "deadhead",
  "load",
] as const;
const KEYWORD = /^[^\p{Cc}]{1,50}$/u;
const MAX_KEYWORDS = 20;

// A segment may be started three times (the first try and two re-sends), as 0037's inbound
// messages are. A try still running after the lease is taken to have crashed, and a re-send may
// take it over.
export const MAX_ATTEMPTS = 3;
export const SEGMENT_LEASE_MS = 35_000;

// Failures worth a re-send of the same segment while it has tries left: the voice note's
// transient set, an unknown outcome (nothing is known to have finished) and a request that ran
// out of time. Anything else is final.
const RETRYABLE = new Set([
  "timeout",
  "unavailable",
  "rate_limited",
  "network",
  "cap",
  "not_configured",
  "disabled",
  "billing",
  "unknown",
  "out_of_time",
]);

export type SegmentStatus = "received" | "transcribed" | "blocked" | "done" | "empty" | "failed";

export type CallDeps = {
  db?: TenantDb;
  clock?: () => number;
  newId?: () => string;
  transcribe?: VoiceDeps["transcribe"];
  complete?: CompleteFn;
  screen?: typeof screenUntrustedInput;
  handOff?: (session: Session, voiceNoteId: string, deps: VoiceDeps) => Promise<HandOffResult>;
  // What the hand-off's own steps use (the agent turn's open and run, in tests).
  voice?: VoiceDeps;
};

export type Refusal = { ok: false; category: string; retryable: boolean };
const refused = (category: string, retryable = false): Refusal => ({ ok: false, category, retryable });

export type TurnView = {
  turnKey: string;
  startMs: number;
  endMs: number;
  updateKind: UpdateKind | null;
  amountCents: number | null;
  summary: string | null;
  voiceNoteId: string | null;
  conversationId: string | null;
};

export type SegmentResult =
  | { ok: true; callId: string; seq: number; status: SegmentStatus; turns: TurnView[] }
  | Refusal;

// A conditional write found the segment moved on under it (another request holds it).
class LostClaim extends Error {
  constructor() {
    super("segment claim lost");
    this.name = "LostClaim";
  }
}

function inTenant<T>(db: TenantDb, session: Session, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

function aiCategory(err: unknown): string | null {
  return err instanceof AiError ? err.category : null;
}

function errorName(err: unknown): string {
  if (err instanceof DbError) return err.category;
  return err instanceof Error ? err.name : "unknown";
}

// A whole number read back from the database, or a throw: an unreadable count is never zero.
function whole(value: unknown, what: string): number {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(n)) throw new Error(`${what} unreadable`);
  return n;
}

const uuidOrNull = (value: string | null | undefined) => (value && isUuid(value) ? value : null);

// --- SQL ---

type CallRow = {
  id: string;
  driver_id: string;
  trace_id: string;
  status: "open" | "ended";
  segments: number | string;
  hand_offs: number | string;
  age_ms: number | string;
  idle_ms: number | string;
};

// The call, locked for the rest of the transaction, with its age and its quiet time measured
// against the request's clock ($2) inside the database.
export const CALL_SQL =
  "SELECT CAST(c.id AS text) AS id, CAST(c.driver_id AS text) AS driver_id, CAST(c.trace_id AS text) AS trace_id," +
  " c.status, c.segments, c.hand_offs," +
  " CAST(floor(extract(epoch FROM (CAST($2 AS timestamptz) - c.started_at)) * 1000) AS bigint) AS age_ms," +
  " CAST(floor(extract(epoch FROM (CAST($2 AS timestamptz) - coalesce(c.last_segment_at, c.started_at))) * 1000)" +
  " AS bigint) AS idle_ms" +
  " FROM calls c WHERE c.tenant_id = current_tenant_id() AND c.id = CAST($1 AS uuid) FOR UPDATE";

// Counts every call the carrier started today in its own zone (owner decision 3: its own count,
// apart from the voice notes'). Advisory under a race, like the voice notes' count.
export const CALLS_TODAY_SQL =
  "SELECT CAST(count(*) AS integer) AS n FROM calls c JOIN tenants t ON t.id = c.tenant_id" +
  " WHERE c.tenant_id = current_tenant_id()" +
  " AND CAST(timezone(t.timezone, c.started_at) AS date) =" +
  " CAST(timezone(t.timezone, CAST($1 AS timestamptz)) AS date)";

// A call id is the browser's. One already taken (by this carrier in a race, or by another) is
// left alone; the read after it tells which.
export const INSERT_CALL_SQL =
  "INSERT INTO calls (id, tenant_id, driver_id, trace_id, created_by, status, started_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, 'open'," +
  " CAST($5 AS timestamptz)) ON CONFLICT DO NOTHING";

export const END_CALL_SQL =
  "UPDATE calls SET status = 'ended', ended_at = CAST($2 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'open'";

export const COUNT_SEGMENT_SQL =
  "UPDATE calls SET segments = segments + 1, last_segment_at = CAST($2 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";

export const COUNT_HAND_OFF_SQL =
  "UPDATE calls SET hand_offs = hand_offs + 1" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND hand_offs < $2";

type SegmentRow = {
  id: string;
  status: SegmentStatus;
  fail_category: string | null;
  attempts: number | string;
  input_id: string | null;
  transcript_call_id: string | null;
  offset_ms: number | string;
  duration_ms: number | string;
  stale: boolean;
};

// The segment of a call by its place, with whether its last write is older than the lease.
export const SEGMENT_SQL =
  "SELECT CAST(s.id AS text) AS id, s.status, s.fail_category, s.attempts, CAST(s.input_id AS text) AS input_id," +
  " CAST(s.transcript_call_id AS text) AS transcript_call_id, s.offset_ms, s.duration_ms," +
  " (s.updated_at <= CAST($3 AS timestamptz) - CAST($4 AS integer) * interval '1 millisecond') AS stale" +
  " FROM call_segments s" +
  " WHERE s.tenant_id = current_tenant_id() AND s.call_id = CAST($1 AS uuid) AND s.seq = $2";

// (tenant_id, call_id, seq) is the dedupe key: a second insert of the same place does nothing.
export const INSERT_SEGMENT_SQL =
  "INSERT INTO call_segments (id, tenant_id, call_id, seq, status, attempts, offset_ms, duration_ms," +
  " created_at, updated_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'received', 1, $4, $5," +
  " CAST($6 AS timestamptz), CAST($6 AS timestamptz)) ON CONFLICT DO NOTHING";

// A re-send takes a segment over: a failed one with tries left goes back to the step it stopped
// before, a crashed one (no write for the lease) keeps its step; either way it is one more try.
// Only the try that read `attempts` can win.
export const RECLAIM_SQL =
  "UPDATE call_segments SET status = CASE WHEN input_id IS NULL THEN 'received' ELSE 'transcribed' END," +
  " fail_category = NULL, attempts = attempts + 1, updated_at = CAST($3 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND attempts = $2 AND attempts < 3" +
  " AND (status = 'failed' OR (status IN ('received', 'transcribed')" +
  " AND updated_at <= CAST($3 AS timestamptz) - CAST($4 AS integer) * interval '1 millisecond'))";

// A try that crashed on its last attempt: stopped, so a re-send stops asking.
export const GIVE_UP_SQL =
  "UPDATE call_segments SET status = 'failed', fail_category = 'unavailable', updated_at = CAST($3 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND attempts = $2" +
  " AND status IN ('received', 'transcribed')" +
  " AND updated_at <= CAST($3 AS timestamptz) - CAST($4 AS integer) * interval '1 millisecond'";

export const SET_FAILED_SQL =
  "UPDATE call_segments SET status = 'failed', fail_category = $3, updated_at = CAST($4 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND attempts = $2" +
  " AND status IN ('received', 'transcribed')";

export const SET_EMPTY_SQL =
  "UPDATE call_segments SET status = 'empty', transcript_call_id = CAST($3 AS uuid), updated_at = CAST($4 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND attempts = $2 AND status = 'received'";

export const INSERT_INPUT_SQL =
  "INSERT INTO untrusted_inputs (id, tenant_id, kind, source, driver_id, body_text, content_hash, received_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), 'transcript', 'voice', CAST($2 AS uuid), $3, $4," +
  " CAST($5 AS timestamptz))";

export const SET_TRANSCRIBED_SQL =
  "UPDATE call_segments SET status = 'transcribed', input_id = CAST($3 AS uuid)," +
  " transcript_call_id = CAST($4 AS uuid), updated_at = CAST($5 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND attempts = $2 AND status = 'received'";

// (tenant_id, segment_id, turn_key) holds one row per turn.
export const INSERT_TURN_SQL =
  "INSERT INTO call_turns (id, tenant_id, segment_id, turn_key, upstream_turn_id, start_ms, end_ms, text, created_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, $7, CAST($8 AS timestamptz))" +
  " ON CONFLICT DO NOTHING";

export const SET_BLOCKED_SQL =
  "UPDATE call_segments SET status = 'blocked', updated_at = CAST($3 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND attempts = $2 AND status = 'transcribed'";

// The transcript exactly as it was screened: the model reads this text and nothing else.
export const INPUT_BODY_SQL =
  "SELECT body_text FROM untrusted_inputs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";

type LineRow = { turn_key: string; start_ms: number | string; end_ms: number | string; text: string };

// A segment's turns in the order they were built (by their index in the key).
const BY_INDEX = " ORDER BY CAST(split_part(turn_key, ':', 2) AS integer)";

export const LINE_TURNS_SQL =
  "SELECT turn_key, start_ms, end_ms, text FROM call_turns" +
  " WHERE tenant_id = current_tenant_id() AND segment_id = CAST($1 AS uuid)" +
  BY_INDEX;

export const SET_TURN_UPDATE_SQL =
  "UPDATE call_turns SET update_kind = $3, english_text = $4, amount_cents = $5, summary = $6" +
  " WHERE tenant_id = current_tenant_id() AND segment_id = CAST($1 AS uuid) AND turn_key = $2";

// A handed-off turn becomes an ordinary voice note, already past the screen and the English copy.
// voice_notes' (tenant_id, input_id) index is the dedupe key: one note per segment's transcript.
export const INSERT_NOTE_SQL =
  "INSERT INTO voice_notes (id, tenant_id, driver_id, input_id, trace_id, created_by, status, duration_ms," +
  " transcript_call_id, language, english_text, prepare_call_id, triage_category, triage_urgency, amount_cents," +
  " created_at, updated_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5," +
  " 'ready', $6, CAST($7 AS uuid), $8, $9, CAST($10 AS uuid), $11, 'normal', $12," +
  " CAST($13 AS timestamptz), CAST($13 AS timestamptz))" +
  " ON CONFLICT (tenant_id, input_id) WHERE input_id IS NOT NULL DO NOTHING";

export const LINK_NOTE_SQL =
  "UPDATE call_turns SET voice_note_id = CAST($3 AS uuid)" +
  " WHERE tenant_id = current_tenant_id() AND segment_id = CAST($1 AS uuid) AND turn_key = $2";

export const SET_DONE_SQL =
  "UPDATE call_segments SET status = 'done', update_call_id = CAST($3 AS uuid), updated_at = CAST($4 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND attempts = $2 AND status = 'transcribed'";

export const LINK_CONVERSATION_SQL =
  "UPDATE call_turns SET conversation_id = CAST($3 AS uuid)" +
  " WHERE tenant_id = current_tenant_id() AND segment_id = CAST($1 AS uuid) AND turn_key = $2" +
  " AND conversation_id IS NULL";

type TurnRow = {
  turn_key: string;
  start_ms: number | string;
  end_ms: number | string;
  update_kind: UpdateKind | null;
  amount_cents: number | string | null;
  summary: string | null;
  voice_note_id: string | null;
  conversation_id: string | null;
};

// What a segment answers with: never a turn's words or its English copy.
export const TURNS_SQL =
  "SELECT turn_key, start_ms, end_ms, update_kind, amount_cents, summary," +
  " CAST(voice_note_id AS text) AS voice_note_id, CAST(conversation_id AS text) AS conversation_id" +
  " FROM call_turns WHERE tenant_id = current_tenant_id() AND segment_id = CAST($1 AS uuid)" +
  BY_INDEX;

// --- the checks that need no database ---

export type SegmentInput = {
  callId: string;
  seq: number;
  offsetMs: number;
  driverId: string;
  // 16 kHz mono 16-bit PCM, made in the browser; sent to the model, never stored.
  wav: Uint8Array;
};

// In order: the switches, the ids and places, the size, the WAV and its length.
export function checkSegment(input: SegmentInput): { durationMs: number } | Refusal {
  if (flags.phoneLineEnabled !== true) return refused("disabled");
  if (flags.aiEnabled !== true) return refused("ai_off");
  const limits = flags.phoneLineLimits;
  if (!isUuid(input.callId) || !isUuid(input.driverId)) return refused("bad_request");
  if (!Number.isSafeInteger(input.seq) || input.seq < 0 || input.seq >= limits.maxSegmentsPerCall) {
    return refused("bad_request");
  }
  if (!Number.isSafeInteger(input.offsetMs) || input.offsetMs < 0 || input.offsetMs > limits.maxCallMs) {
    return refused("bad_request");
  }
  if (!(input.wav instanceof Uint8Array)) return refused("bad_request");
  if (input.wav.byteLength > limits.maxSegmentBytes) return refused("too_large");
  const wav = readWav(input.wav);
  if (!wav || wav.sampleRate !== 16_000) return refused("bad_request");
  const durationMs = Math.ceil((wav.samples * 1000) / wav.sampleRate);
  if (durationMs < 1 || durationMs > limits.maxSegmentMs) return refused("bad_request");
  return { durationMs };
}

// The keywords one segment sends: the fixed list and the driver's code when the wrapper would
// take it.
export function segmentKeywords(driverCode: string | null): string[] {
  const out: string[] = [...CALL_KEYWORDS];
  if (driverCode !== null && KEYWORD.test(driverCode) && driverCode.trim() === driverCode && !out.includes(driverCode)) {
    out.push(driverCode);
  }
  return out.slice(0, MAX_KEYWORDS);
}

// --- turns ---

export type BuiltTurn = {
  turnKey: string;
  upstreamTurnId: string | null;
  // In the call, from its start.
  startMs: number;
  endMs: number;
  text: string;
};

const TURN_TEXT_CHARS = 4000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// The transcription's turns as rows: empty ones dropped, in time order, at most MAX_TURNS (the
// rest folded into the last), each placed inside the segment and then in the call. An answer with
// words but no turns is one turn spanning the segment. No words at all is no turns.
export function buildTurns(result: TranscribeResult, seq: number, offsetMs: number, durationMs: number): BuiltTurn[] {
  type Raw = { startMs: number; endMs: number; text: string; turnId: string | null };
  const turns = Array.isArray(result.turns) ? result.turns : [];
  let raw: Raw[] = turns
    .map((t) => ({
      startMs: Number.isFinite(t.startMs) ? Math.round(t.startMs) : 0,
      endMs: Number.isFinite(t.endMs) ? Math.round(t.endMs) : durationMs,
      text: typeof t.transcript === "string" ? t.transcript.trim() : "",
      turnId: typeof t.turnId === "string" && t.turnId.length >= 1 && t.turnId.length <= 64 ? t.turnId : null,
    }))
    .filter((t) => t.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs);
  if (raw.length === 0) {
    const text = typeof result.transcript === "string" ? result.transcript.trim() : "";
    if (text.length === 0) return [];
    raw = [{ startMs: 0, endMs: durationMs, text, turnId: null }];
  }
  if (raw.length > MAX_TURNS) {
    const rest = raw.slice(MAX_TURNS - 1);
    raw = [
      ...raw.slice(0, MAX_TURNS - 1),
      { startMs: rest[0].startMs, endMs: Math.max(...rest.map((r) => r.endMs)), text: rest.map((r) => r.text).join(" "), turnId: null },
    ];
  }
  return raw.map((t, index) => {
    const start = clamp(t.startMs, 0, durationMs - 1);
    const end = clamp(t.endMs, start + 1, durationMs);
    return {
      turnKey: `${seq}:${index}`,
      upstreamTurnId: t.turnId,
      startMs: offsetMs + start,
      endMs: offsetMs + end,
      text: capChars(t.text, TURN_TEXT_CHARS),
    };
  });
}

function toTurnView(row: TurnRow): TurnView {
  return {
    turnKey: row.turn_key,
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    updateKind: row.update_kind,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
    summary: row.summary,
    voiceNoteId: row.voice_note_id,
    conversationId: row.conversation_id,
  };
}

async function readTurns(q: Queryable, segmentId: string): Promise<TurnView[]> {
  return (await q.query<TurnRow>(TURNS_SQL, [segmentId])).map(toTurnView);
}

// --- 1. reserve ---

type Segment = {
  id: string;
  status: SegmentStatus;
  attempts: number;
  inputId: string | null;
  transcriptCallId: string | null;
  offsetMs: number;
  durationMs: number;
};

type Reserved =
  | { kind: "refused"; refusal: Refusal }
  | { kind: "stored"; status: SegmentStatus; turns: TurnView[] }
  | { kind: "run"; segment: Segment; traceId: string; driverId: string; driverCode: string | null; zone: string };

function segmentOf(row: SegmentRow, attempts: number, status: SegmentStatus): Segment {
  return {
    id: row.id,
    status,
    attempts,
    inputId: row.input_id,
    transcriptCallId: row.transcript_call_id,
    offsetMs: whole(row.offset_ms, "segment offset"),
    durationMs: whole(row.duration_ms, "segment length"),
  };
}

async function readCall(q: Queryable, callId: string, nowIso: string): Promise<CallRow | null> {
  const [row] = await q.query<CallRow>(CALL_SQL, [callId, nowIso]);
  return row ?? null;
}

// An existing segment: its stored answer, a take-over for one more try, or a refusal.
async function resumeSegment(q: Queryable, row: SegmentRow, nowIso: string): Promise<Reserved | Segment> {
  const attempts = whole(row.attempts, "segment attempts");
  if (row.status === "done" || row.status === "empty" || row.status === "blocked") {
    return { kind: "stored", status: row.status, turns: await readTurns(q, row.id) };
  }
  if (row.status === "failed") {
    const category = row.fail_category ?? "unknown";
    if (!RETRYABLE.has(category) || attempts >= MAX_ATTEMPTS) return { kind: "refused", refusal: refused(category) };
  } else if (!row.stale) {
    // Another request is working on it.
    return { kind: "refused", refusal: refused("busy", true) };
  } else if (attempts >= MAX_ATTEMPTS) {
    const stopped = await q.execute(GIVE_UP_SQL, [row.id, attempts, nowIso, SEGMENT_LEASE_MS]);
    return { kind: "refused", refusal: stopped === 1 ? refused("unavailable") : refused("busy", true) };
  }
  const taken = await q.execute(RECLAIM_SQL, [row.id, attempts, nowIso, SEGMENT_LEASE_MS]);
  if (taken !== 1) return { kind: "refused", refusal: refused("busy", true) };
  return segmentOf(row, attempts + 1, row.input_id === null ? "received" : "transcribed");
}

async function reserve(
  q: Queryable,
  session: Session,
  input: SegmentInput & { durationMs: number },
  nowIso: string,
  newId: () => string,
): Promise<Reserved> {
  const limits = flags.phoneLineLimits;
  const zone = await readTenantZone(q);
  let call = await readCall(q, input.callId, nowIso);
  if (call === null) {
    if ((await readDriverCode(q, input.driverId)) === null) return { kind: "refused", refusal: refused("not_found") };
    const [count] = await q.query<{ n: number | string }>(CALLS_TODAY_SQL, [nowIso]);
    if (whole(count?.n, "call count") >= limits.callsPerDay) return { kind: "refused", refusal: refused("limit") };
    await q.execute(INSERT_CALL_SQL, [input.callId, input.driverId, newId(), session.sub, nowIso]);
    call = await readCall(q, input.callId, nowIso);
    // The id is another carrier's (or was never stored): this call cannot be used.
    if (call === null) return { kind: "refused", refusal: refused("conflict") };
  }
  if (call.driver_id !== input.driverId) return { kind: "refused", refusal: refused("bad_request") };
  const driverCode = await readDriverCode(q, call.driver_id);
  const run = (segment: Segment): Reserved => ({
    kind: "run",
    segment,
    traceId: call.trace_id,
    driverId: call.driver_id,
    driverCode,
    zone,
  });

  // A segment already reserved answers from its own row, whatever the call has done since.
  const [existing] = await q.query<SegmentRow>(SEGMENT_SQL, [input.callId, input.seq, nowIso, SEGMENT_LEASE_MS]);
  if (existing) {
    const resumed = await resumeSegment(q, existing, nowIso);
    return "kind" in resumed ? resumed : run(resumed);
  }

  if (call.status !== "open") return { kind: "refused", refusal: refused("not_open") };
  if (whole(call.idle_ms, "call quiet time") > limits.idleEndMs) {
    await q.execute(END_CALL_SQL, [call.id, nowIso]);
    return { kind: "refused", refusal: refused("not_open") };
  }
  if (whole(call.segments, "call segments") >= limits.maxSegmentsPerCall || whole(call.age_ms, "call age") > limits.maxCallMs) {
    return { kind: "refused", refusal: refused("limit") };
  }
  const segmentId = newId();
  const inserted = await q.execute(INSERT_SEGMENT_SQL, [segmentId, call.id, input.seq, input.offsetMs, input.durationMs, nowIso]);
  if (inserted !== 1) return { kind: "refused", refusal: refused("busy", true) };
  await q.execute(COUNT_SEGMENT_SQL, [call.id, nowIso]);
  return run({
    id: segmentId,
    status: "received",
    attempts: 1,
    inputId: null,
    transcriptCallId: null,
    offsetMs: input.offsetMs,
    durationMs: input.durationMs,
  });
}

// --- 2 to 4. one segment ---

export async function receiveSegment(session: Session, input: SegmentInput, deps: CallDeps = {}): Promise<SegmentResult> {
  const checked = checkSegment(input);
  if ("ok" in checked) return checked;
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const started = clock();
  const iso = () => new Date(clock()).toISOString();
  const callId = input.callId.toLowerCase();
  const driverId = input.driverId.toLowerCase();
  const seq = input.seq;

  const reserved = await inTenant(db, session, (q) =>
    reserve(q, session, { ...input, callId, driverId, durationMs: checked.durationMs }, iso(), newId),
  );
  if (reserved.kind === "refused") return reserved.refusal;
  if (reserved.kind === "stored") return { ok: true, callId, seq, status: reserved.status, turns: reserved.turns };

  const { segment, traceId } = reserved;
  const deadlineAt = started + STEP_BUDGET_MS;
  const remaining = () => deadlineAt - clock();

  // A step that stopped: stored as a category, answered retryable while it has tries left.
  const fail = async (category: string): Promise<SegmentResult> => {
    await inTenant(db, session, (q) => q.execute(SET_FAILED_SQL, [segment.id, segment.attempts, category, iso()]));
    return refused(category, RETRYABLE.has(category) && segment.attempts < MAX_ATTEMPTS);
  };
  const answerFrom = async (status: SegmentStatus): Promise<SegmentResult> => ({
    ok: true,
    callId,
    seq,
    status,
    turns: await inTenant(db, session, (q) => readTurns(q, segment.id)),
  });

  try {
    let inputId = segment.inputId;
    let transcriptCallId = segment.transcriptCallId;
    if (segment.status === "received") {
      if (remaining() < MIN_CALL_MS) return await fail("out_of_time");
      let result: TranscribeResult;
      try {
        result = await (deps.transcribe ?? transcribe)(
          {
            purpose: SEGMENT_TRANSCRIBE.purpose,
            maxCostCents: SEGMENT_TRANSCRIBE.maxCostCents,
            timeoutMs: Math.min(SEGMENT_TRANSCRIBE.timeoutMs, Math.floor(remaining())),
            traceId,
            wav: input.wav,
            mode: "ENDPOINTING",
            languageBias: ["English", "Spanish"],
            keywords: segmentKeywords(reserved.driverCode),
          },
          session,
        );
      } catch (err) {
        const category = aiCategory(err);
        if (category === null) throw err;
        console.error("call segment transcription failed:", category);
        return await fail(category);
      }
      const turns = buildTurns(result, seq, segment.offsetMs, segment.durationMs);
      transcriptCallId = uuidOrNull(result.callId);
      if (turns.length === 0) {
        const changed = await inTenant(db, session, (q) =>
          q.execute(SET_EMPTY_SQL, [segment.id, segment.attempts, transcriptCallId, iso()]),
        );
        if (changed !== 1) throw new LostClaim();
        return await answerFrom("empty");
      }
      const body = turnLines(turns.map((t) => ({ turnKey: t.turnKey, startMs: t.startMs, text: t.text })));
      const newInput = newId();
      await inTenant(db, session, async (q) => {
        const nowIso = iso();
        await q.execute(INSERT_INPUT_SQL, [newInput, reserved.driverId, body, untrustedContentHash("transcript", body), nowIso]);
        const changed = await q.execute(SET_TRANSCRIBED_SQL, [segment.id, segment.attempts, newInput, transcriptCallId, nowIso]);
        if (changed !== 1) throw new LostClaim();
        for (const t of turns) {
          await q.execute(INSERT_TURN_SQL, [newId(), segment.id, t.turnKey, t.upstreamTurnId, t.startMs, t.endMs, t.text, nowIso]);
        }
      });
      inputId = newInput;
    }
    if (inputId === null) throw new Error("transcribed segment has no input");

    const ctx: GatewayContext = {
      session,
      role: "triage",
      model: "spark_open",
      turnId: null,
      traceId,
      now: new Date(started),
      deadlineAt,
      timeZone: reserved.zone,
    };
    const gateway: GatewayDeps = { db, clock, ...(deps.complete ? { complete: deps.complete } : {}) };

    // The safety screen first: no model reads the words before it passes them.
    const screen = await (deps.screen ?? screenUntrustedInput)(ctx, inputId, gateway);
    if (screen.decision === "blocked") {
      const changed = await inTenant(db, session, (q) => q.execute(SET_BLOCKED_SQL, [segment.id, segment.attempts, iso()]));
      if (changed !== 1) throw new LostClaim();
      return await answerFrom("blocked");
    }

    const read = await inTenant(db, session, async (q) => ({
      body: (await q.query<{ body_text: string }>(INPUT_BODY_SQL, [inputId]))[0]?.body_text ?? null,
      lines: await q.query<LineRow>(LINE_TURNS_SQL, [segment.id]),
    }));
    if (read.body === null || read.lines.length === 0) throw new Error("segment transcript missing");
    const lineTurns: LineTurn[] = read.lines.map((l) => ({ turnKey: l.turn_key, startMs: Number(l.start_ms), text: l.text }));

    if (remaining() < MIN_CALL_MS) return await fail("out_of_time");
    let answer: Awaited<ReturnType<CompleteFn>>;
    try {
      answer = await (deps.complete ?? complete)(
        "spark",
        {
          purpose: SEGMENT_UPDATE.purpose,
          maxCostCents: flags.phoneLineLimits.maxUpdateCents,
          timeoutMs: Math.min(SEGMENT_UPDATE.timeoutMs, Math.floor(remaining())),
          traceId,
          maxOutputTokens: SEGMENT_UPDATE.maxOutputTokens,
          reasoningEffort: SEGMENT_UPDATE.reasoningEffort,
          format: CALL_UPDATE_FORMAT,
          messages: [
            { role: "system", content: CALL_UPDATE_SYSTEM },
            { role: "user", content: `${UNTRUSTED_WARNING}\n\n${read.body}` },
          ],
        },
        session,
      );
    } catch (err) {
      const category = aiCategory(err);
      if (category === null) throw err;
      console.error("call segment update failed:", category);
      return await fail(category);
    }
    const updates = answer.status === "ok" ? parseUpdates(answer.text, lineTurns) : null;
    if (updates === null) return await fail("bad_answer");

    const updateCallId = uuidOrNull(answer.callId);
    const handOff = await inTenant(db, session, (q) =>
      storeUpdates(q, session, {
        callId,
        segment,
        inputId,
        transcriptCallId,
        traceId,
        driverId: reserved.driverId,
        updates,
        lines: read.lines,
        updateCallId,
        nowIso: iso(),
        newId,
      }),
    );

    // The agent's turn runs inside this request only when a whole turn fits in what is left of it,
    // with MIN_CALL_MS more for the writes the turn makes after its own deadline; otherwise the
    // note waits, 'ready', for the hand-off route.
    if (handOff && remaining() >= flags.agentTurnLimits.wallClockMs + MIN_CALL_MS) {
      await runHandOff(session, segment.id, handOff, { db, clock, deps });
    }
    return await answerFrom("done");
  } catch (err) {
    if (err instanceof LostClaim) return refused("busy", true);
    throw err;
  }
}

type HandOffTurn = { turnKey: string; voiceNoteId: string };

// The case updates on their turns, then the first advance request or pay question as a voice note
// while the call has hand-offs left, then the segment 'done'. One transaction, the call locked.
async function storeUpdates(
  q: Queryable,
  session: Session,
  a: {
    callId: string;
    segment: Segment;
    inputId: string;
    transcriptCallId: string | null;
    traceId: string;
    driverId: string;
    updates: TurnUpdate[];
    lines: LineRow[];
    updateCallId: string | null;
    nowIso: string;
    newId: () => string;
  },
): Promise<HandOffTurn | null> {
  const call = await readCall(q, a.callId, a.nowIso);
  if (call === null) throw new Error("call missing");
  for (const u of a.updates) {
    await q.execute(SET_TURN_UPDATE_SQL, [
      a.segment.id,
      u.turnKey,
      u.kind,
      u.englishText.length > 0 ? u.englishText : null,
      u.amountCents,
      u.summary.length > 0 ? u.summary : null,
    ]);
  }
  let handOff: HandOffTurn | null = null;
  const order = new Map(a.lines.map((l, i) => [l.turn_key, i]));
  const action = a.updates
    .filter((u) => HAND_OFF_KINDS.has(u.kind) && u.englishText.length > 0)
    .sort((x, y) => (order.get(x.turnKey) ?? 0) - (order.get(y.turnKey) ?? 0))[0];
  const limit = flags.phoneLineLimits.maxHandOffsPerCall;
  if (action && whole(call.hand_offs, "call hand-offs") < limit) {
    const line = a.lines.find((l) => l.turn_key === action.turnKey);
    if (!line) throw new Error("hand-off turn missing");
    const noteId = a.newId();
    const inserted = await q.execute(INSERT_NOTE_SQL, [
      noteId,
      a.driverId,
      a.inputId,
      a.traceId,
      session.sub,
      whole(line.end_ms, "turn end") - whole(line.start_ms, "turn start"),
      a.transcriptCallId,
      action.language,
      action.englishText,
      a.updateCallId,
      action.kind,
      action.amountCents,
      a.nowIso,
    ]);
    if (inserted === 1) {
      await q.execute(LINK_NOTE_SQL, [a.segment.id, action.turnKey, noteId]);
      const counted = await q.execute(COUNT_HAND_OFF_SQL, [a.callId, limit]);
      if (counted !== 1) throw new Error("hand-off count refused");
      handOff = { turnKey: action.turnKey, voiceNoteId: noteId };
    }
  }
  const changed = await q.execute(SET_DONE_SQL, [a.segment.id, a.segment.attempts, a.updateCallId, a.nowIso]);
  if (changed !== 1) throw new LostClaim();
  return handOff;
}

// The voice note's own hand-off (its switches, its claim, one agent turn), then the conversation
// on the turn. A refusal or a failure leaves the note for the hand-off route; it never undoes the
// segment.
async function runHandOff(
  session: Session,
  segmentId: string,
  turn: HandOffTurn,
  ctx: { db: TenantDb; clock: () => number; deps: CallDeps },
): Promise<HandOffResult> {
  const voiceDeps: VoiceDeps = { db: ctx.db, clock: ctx.clock, ...(ctx.deps.voice ?? {}) };
  let result: HandOffResult;
  try {
    result = await (ctx.deps.handOff ?? handOffVoiceNote)(session, turn.voiceNoteId, voiceDeps);
  } catch (err) {
    console.error("call hand-off failed:", errorName(err));
    return refused("unavailable", true);
  }
  if (!result.ok) {
    console.error("call hand-off refused:", result.category);
    return result;
  }
  const conversationId = uuidOrNull(result.conversationId);
  if (conversationId !== null) {
    await inTenant(ctx.db, session, (q) => q.execute(LINK_CONVERSATION_SQL, [segmentId, turn.turnKey, conversationId]));
  }
  return result;
}

// --- the hand-off route: finish a hand-off the segment left waiting ---

type WaitingRow = {
  id: string;
  status: SegmentStatus;
  turn_key: string | null;
  voice_note_id: string | null;
  conversation_id: string | null;
};

// A segment and the turn it handed off, if any.
export const WAITING_SQL =
  "SELECT CAST(s.id AS text) AS id, s.status, t.turn_key, CAST(t.voice_note_id AS text) AS voice_note_id," +
  " CAST(t.conversation_id AS text) AS conversation_id" +
  " FROM call_segments s LEFT JOIN call_turns t ON t.tenant_id = s.tenant_id AND t.segment_id = s.id" +
  " AND t.voice_note_id IS NOT NULL" +
  " WHERE s.tenant_id = current_tenant_id() AND s.call_id = CAST($1 AS uuid) AND s.seq = $2";

export async function finishHandOff(
  session: Session,
  callId: string,
  seq: number,
  deps: CallDeps = {},
): Promise<SegmentResult> {
  if (flags.phoneLineEnabled !== true) return refused("disabled");
  if (flags.aiEnabled !== true) return refused("ai_off");
  if (!isUuid(callId) || !Number.isSafeInteger(seq) || seq < 0 || seq >= flags.phoneLineLimits.maxSegmentsPerCall) {
    return refused("bad_request");
  }
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;
  const id = callId.toLowerCase();
  const [row] = await inTenant(db, session, (q) => q.query<WaitingRow>(WAITING_SQL, [id, seq]));
  if (!row) return refused("not_found");
  if (row.status !== "done" || row.turn_key === null || row.voice_note_id === null) return refused("not_found");
  // A turn already in a conversation answers with it; nothing runs twice.
  if (row.conversation_id === null) {
    const turn = { turnKey: row.turn_key, voiceNoteId: row.voice_note_id };
    const result = await runHandOff(session, row.id, turn, { db, clock, deps });
    if (!result.ok) return result;
  }
  return { ok: true, callId: id, seq, status: "done", turns: await inTenant(db, session, (q) => readTurns(q, row.id)) };
}

// --- the end route ---

export type EndResult = { ok: true; callId: string; status: "ended" } | Refusal;

export const CALL_STATUS_SQL =
  "SELECT status FROM calls WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";

export async function endCall(session: Session, callId: string, deps: CallDeps = {}): Promise<EndResult> {
  if (flags.phoneLineEnabled !== true) return refused("disabled");
  if (!isUuid(callId)) return refused("bad_request");
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;
  const id = callId.toLowerCase();
  const found = await inTenant(db, session, async (q) => {
    await q.execute(END_CALL_SQL, [id, new Date(clock()).toISOString()]);
    const [row] = await q.query<{ status: string }>(CALL_STATUS_SQL, [id]);
    return row?.status ?? null;
  });
  if (found === null) return refused("not_found");
  return { ok: true, callId: id, status: "ended" };
}
