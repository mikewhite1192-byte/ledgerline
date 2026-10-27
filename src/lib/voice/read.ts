import { DbError, type Queryable } from "../db";
import { isUuid } from "../uuid";
import type { VoiceStatus } from "./pipeline";

// What the voice note pages read, inside the request's tenant transaction. Every statement names
// its tenant. The transcript and the English copy are shown to staff only after the safety screen
// passed them; a blocked note shows its category, never its words. The recording leaves only
// through the audio route.

export type VoiceListRow = {
  id: string;
  driverId: string | null;
  driverCode: string | null;
  driverName: string | null;
  status: VoiceStatus;
  failCategory: string | null;
  language: string | null;
  category: string | null;
  urgency: string | null;
  amountCents: number | null;
  durationMs: number | null;
  createdAt: string;
};

export type VoiceTraceRow = {
  target: string;
  purpose: string;
  status: string;
  durationMs: number | null;
  costNanocents: number;
};

export type VoiceDetail = VoiceListRow & {
  inputId: string | null;
  traceId: string;
  hasAudio: boolean;
  audioMime: string | null;
  confidenceMilli: number | null;
  transcript: string | null;
  englishText: string | null;
  replyText: string | null;
  conversationId: string | null;
  screen: { verdict: "clean" | "flagged"; categories: string[] } | null;
  proposal: { id: string; status: string; amountCents: number } | null;
  trace: VoiceTraceRow[];
};

const LIST_LIMIT = 200;

type BaseRow = {
  id: string;
  driver_id: string | null;
  driver_code: string | null;
  first_name: string | null;
  last_name: string | null;
  status: VoiceStatus;
  fail_category: string | null;
  language: string | null;
  triage_category: string | null;
  triage_urgency: string | null;
  amount_cents: number | string | null;
  duration_ms: number | string | null;
  created_at: string | Date;
};

const BASE_COLUMNS =
  "CAST(v.id AS text) AS id, CAST(v.driver_id AS text) AS driver_id, d.code AS driver_code," +
  " d.first_name, d.last_name, v.status, v.fail_category, v.language, v.triage_category, v.triage_urgency," +
  " v.amount_cents, v.duration_ms, v.created_at";
const BASE_FROM =
  " FROM voice_notes v LEFT JOIN drivers d ON d.tenant_id = v.tenant_id AND d.id = v.driver_id" +
  " WHERE v.tenant_id = current_tenant_id()";

function whole(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new DbError("unknown");
  return n;
}

function iso(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new DbError("unknown");
  return d.toISOString();
}

function base(r: BaseRow): VoiceListRow {
  return {
    id: r.id,
    driverId: r.driver_id,
    driverCode: r.driver_code,
    driverName: r.first_name !== null && r.last_name !== null ? `${r.first_name} ${r.last_name}` : null,
    status: r.status,
    failCategory: r.fail_category,
    language: r.language,
    category: r.triage_category,
    urgency: r.triage_urgency,
    amountCents: whole(r.amount_cents),
    durationMs: whole(r.duration_ms),
    createdAt: iso(r.created_at),
  };
}

// Newest first; one driver's notes when driverId is a well-formed id.
export async function readVoiceList(q: Queryable, driverId: string | null): Promise<VoiceListRow[]> {
  const byDriver = driverId !== null && isUuid(driverId);
  const rows = await q.query<BaseRow>(
    `SELECT ${BASE_COLUMNS}${BASE_FROM}${byDriver ? " AND v.driver_id = CAST($1 AS uuid)" : ""}` +
      ` ORDER BY v.created_at DESC, v.id DESC LIMIT ${LIST_LIMIT}`,
    byDriver ? [driverId.toLowerCase()] : [],
  );
  return rows.map(base);
}

type DetailRow = BaseRow & {
  input_id: string | null;
  trace_id: string;
  has_audio: boolean;
  audio_mime: string | null;
  language_confidence_milli: number | string | null;
  english_text: string | null;
  reply_text: string | null;
  conversation_id: string | null;
  body_text: string | null;
  content_hash: string | null;
};

const SHOWN_AFTER_SCREEN = new Set<VoiceStatus>(["ready", "handed_off", "replied"]);

export async function readVoiceDetail(q: Queryable, id: string): Promise<VoiceDetail | null> {
  if (!isUuid(id)) return null;
  const [r] = await q.query<DetailRow>(
    `SELECT ${BASE_COLUMNS}, CAST(v.input_id AS text) AS input_id, CAST(v.trace_id AS text) AS trace_id,` +
      " (v.audio IS NOT NULL) AS has_audio, v.audio_mime, v.language_confidence_milli, v.english_text," +
      " v.reply_text, CAST(v.conversation_id AS text) AS conversation_id, i.body_text, i.content_hash" +
      " FROM voice_notes v LEFT JOIN drivers d ON d.tenant_id = v.tenant_id AND d.id = v.driver_id" +
      " LEFT JOIN untrusted_inputs i ON i.tenant_id = v.tenant_id AND i.id = v.input_id" +
      " WHERE v.tenant_id = current_tenant_id() AND v.id = CAST($1 AS uuid)",
    [id.toLowerCase()],
  );
  if (!r) return null;

  let screen: VoiceDetail["screen"] = null;
  if (r.content_hash) {
    const [s] = await q.query<{ verdict: "clean" | "flagged"; categories: string }>(
      "SELECT verdict, CAST(categories AS text) AS categories FROM screenings WHERE tenant_id = current_tenant_id() AND content_hash = $1" +
        " AND via <> 'error' ORDER BY created_at DESC LIMIT 1",
      [r.content_hash],
    );
    if (s) {
      let raw: unknown = null;
      try {
        raw = JSON.parse(s.categories);
      } catch {
        raw = null;
      }
      const categories = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
      screen = { verdict: s.verdict, categories };
    }
  }

  let proposal: VoiceDetail["proposal"] = null;
  if (r.input_id) {
    const [p] = await q.query<{ id: string; status: string; amount_cents: number | string }>(
      "SELECT CAST(id AS text) AS id, status, amount_cents FROM proposals" +
        " WHERE tenant_id = current_tenant_id() AND kind = 'advance_payout' AND lower(args->>'requestRef') = $1" +
        " ORDER BY created_at DESC, id DESC LIMIT 1",
      [r.input_id.toLowerCase()],
    );
    if (p) proposal = { id: p.id, status: p.status, amountCents: whole(p.amount_cents) ?? 0 };
  }

  const calls = await q.query<{
    target: string;
    purpose: string;
    status: string;
    duration_ms: number | string | null;
    cost_nanocents: number | string;
  }>(
    "SELECT target, purpose, status, duration_ms, cost_nanocents FROM model_calls" +
      " WHERE tenant_id = current_tenant_id() AND trace_id = CAST($1 AS uuid)" +
      " ORDER BY created_at, id LIMIT 50",
    [r.trace_id],
  );
  // In the order the calls were made: transcribe, screen, prepare, sort, reply.
  const trace = calls.map((c) => ({
    target: c.target,
    purpose: c.purpose,
    status: c.status,
    durationMs: whole(c.duration_ms),
    costNanocents: whole(c.cost_nanocents) ?? 0,
  }));

  const shown = SHOWN_AFTER_SCREEN.has(r.status);
  return {
    ...base(r),
    inputId: r.input_id,
    traceId: r.trace_id,
    hasAudio: r.has_audio === true,
    audioMime: r.audio_mime,
    confidenceMilli: whole(r.language_confidence_milli),
    transcript: shown ? r.body_text : null,
    englishText: shown ? r.english_text : null,
    replyText: r.reply_text,
    conversationId: r.conversation_id,
    screen,
    proposal,
    trace,
  };
}

// The stored recording as base64 (the Data API returns bytea that way), with its type.
export async function readVoiceAudio(q: Queryable, id: string): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!isUuid(id)) return null;
  const [r] = await q.query<{ audio_mime: string | null; audio_b64: string | null; audio_bytes: number | string | null }>(
    "SELECT audio_mime, encode(audio, 'base64') AS audio_b64, audio_bytes FROM voice_notes" +
      " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [id.toLowerCase()],
  );
  if (!r || r.audio_mime === null || r.audio_b64 === null) return null;
  const bytes = Buffer.from(r.audio_b64.replace(/\s+/g, ""), "base64");
  if (bytes.byteLength !== whole(r.audio_bytes)) throw new DbError("unknown");
  return { mime: r.audio_mime, bytes };
}
