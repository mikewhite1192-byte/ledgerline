import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, transcribe, type TranscribeRequest, type TranscribeResult } from "../ai";
import { readWav } from "../ai/wav";
import { readDriverCode } from "../advances/read";
import { screenUntrustedInput } from "../agent/gateway";
import { dbTurnStore, openAgentTurn, type StoreDeps } from "../agent/gateway/store";
import { UNTRUSTED_WARNING } from "../agent/gateway/tools/read/get-inbound-message";
import { runTriage, type TriageResult } from "../agent/gateway/triage/run";
import type { CompleteFn, GatewayContext, GatewayDeps } from "../agent/gateway/types";
import { defaultTurnDeps, runTurn } from "../agent/operator/turn";
import { LOOP_TEXT } from "../agent/policy";
import type { TurnStatus } from "../agent/view";
import type { Session } from "../auth/claims";
import { untrustedContentHash } from "../data/content-hash";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { readTenantZone } from "../money/read";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { extractAmountCents } from "./amount";
import { isVoiceMime } from "./mime";
import { PREPARE_FORMAT, PREPARE_INPUT_CHARS, PREPARE_SYSTEM, parsePrepared } from "./prepare";
import { REPLY_FORMAT, REPLY_SYSTEM, parseTranslated, replyTemplate, type ReplyOutcome } from "./reply";

// A driver's voice note, in four steps, each one request inside the 30 second window and each
// resumable from voice_notes.status:
//   1. upload: check the clip, transcribe it (Muse Voice Transcribe), store the transcript as an
//      untrusted input with its note, then the original recording for playback on its own (a
//      recording the database refuses costs only the recording). Status 'transcribed'.
//   2. prepare: the gateway's safety screen (Muse Spark Open), then one Muse Spark call for the
//      language and an English copy, then the gateway's triage. Status 'ready', or 'blocked'.
//   3. handOff: one agent turn with the fixed sentence "Handle voice note <id>". The agent reads
//      the note through get_voice_note (screened again, cached) and proposes; a person approves.
//   4. reply: a fixed sentence per outcome with the engine's numbers, translated for a Spanish
//      note. Nothing is sent: the page shows the draft with a Copy button.
// Nothing here decides an amount or moves money. Users and stored reasons get categories only;
// the log gets an error's name, never audio, a transcript or upstream text.

export { VOICE_MIMES, voiceMime, type VoiceMime } from "./mime";

export type VoiceStatus = "transcribed" | "blocked" | "ready" | "handed_off" | "replied" | "failed";

// Everything a transcription sends but the clip and the trace.
export function transcribeOptions(): Omit<TranscribeRequest, "wav" | "traceId"> {
  return {
    mode: "PUSH_TO_TALK",
    languageBias: ["Spanish", "English"],
    keywords: ["advance", "adelanto", "fuel", "diesel", "settlement", "pay"],
    purpose: "voice_note_transcribe",
    maxCostCents: 2,
    timeoutMs: 20_000,
  };
}

export const PREPARE_CALL = { purpose: "voice_note_prepare", maxCostCents: 3, timeoutMs: 15_000, maxOutputTokens: 600 } as const;
export const REPLY_CALL = { purpose: "voice_note_reply", maxCostCents: 2, timeoutMs: 12_000, maxOutputTokens: 400 } as const;

// Each request stops starting new model calls this long after it began, and needs at least
// MIN_CALL_MS left to start one.
export const STEP_BUDGET_MS = 27_000;
export const MIN_CALL_MS = 3_000;

// Model failures worth another press of the button: the note keeps its status. A spent budget, a
// switch, missing keys or a billing hold pass once someone fixes them, so they keep it too.
const TRANSIENT = new Set(["timeout", "unavailable", "rate_limited", "network", "cap", "not_configured", "disabled", "billing"]);

type Opened = Awaited<ReturnType<typeof openAgentTurn>>;
type OpenTurn = Exclude<Opened, { refused: unknown }>;

export type VoiceDeps = {
  db?: TenantDb;
  clock?: () => number;
  newId?: () => string;
  transcribe?: (request: TranscribeRequest, session: Session) => Promise<TranscribeResult>;
  complete?: CompleteFn;
  screen?: typeof screenUntrustedInput;
  triage?: typeof runTriage;
  open?: (session: Session, input: Parameters<typeof openAgentTurn>[1]) => Promise<Opened>;
  run?: (session: Session, turn: OpenTurn, text: string, startedAt: number) => Promise<TurnStatus>;
};

export type Refusal = { ok: false; category: string; retryable: boolean; voiceNoteId?: string };
const refused = (category: string, retryable = false, voiceNoteId?: string): Refusal =>
  voiceNoteId ? { ok: false, category, retryable, voiceNoteId } : { ok: false, category, retryable };

function inTenant<T>(db: TenantDb, session: Session, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function aiCategory(err: unknown): string | null {
  return err instanceof AiError ? err.category : null;
}

// What the log may say about a failure that is not a model's: a category or a name, never text.
function errorName(err: unknown): string {
  if (err instanceof DbError) return err.category;
  return err instanceof Error ? err.name : "unknown";
}

// --- 1. upload ---

export type UploadInput = {
  driverId: string;
  // 16 kHz mono 16-bit PCM, made in the browser; sent to the model, never stored.
  wav: Uint8Array;
  // The clip as recorded or picked, kept for playback. Optional.
  original: { bytes: Uint8Array; mime: string } | null;
};

export type UploadResult = { ok: true; voiceNoteId: string; status: "transcribed" } | Refusal;

// Counts every note the carrier stored today in its own zone, failed ones too: each one cost a
// transcription. A note a phone call handed off (its input is a call segment's, 0068) counts in
// the call's own daily limit instead. Advisory under a race (two uploads in the same instant can
// both pass).
export const NOTES_TODAY_SQL =
  "SELECT CAST(count(*) AS integer) AS n FROM voice_notes v JOIN tenants t ON t.id = v.tenant_id" +
  " WHERE v.tenant_id = current_tenant_id()" +
  " AND CAST(timezone(t.timezone, v.created_at) AS date) =" +
  " CAST(timezone(t.timezone, CAST($1 AS timestamptz)) AS date)" +
  " AND NOT EXISTS (SELECT 1 FROM call_segments s" +
  " WHERE s.tenant_id = v.tenant_id AND s.input_id = v.input_id)";

const INSERT_FAILED_SQL =
  "INSERT INTO voice_notes (id, tenant_id, driver_id, trace_id, created_by, status, fail_category," +
  " duration_ms, created_at, updated_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, 'failed', $5," +
  " $6, CAST($7 AS timestamptz), CAST($7 AS timestamptz))";

const INSERT_INPUT_SQL =
  "INSERT INTO untrusted_inputs (id, tenant_id, kind, source, driver_id, body_text, content_hash, received_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), 'transcript', 'voice', CAST($2 AS uuid), $3, $4," +
  " CAST($5 AS timestamptz))";

const INSERT_NOTE_SQL =
  "INSERT INTO voice_notes (id, tenant_id, driver_id, input_id, trace_id, created_by, status," +
  " duration_ms, transcript_call_id, created_at, updated_at)" +
  " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5," +
  " 'transcribed', $6, CAST($7 AS uuid), CAST($8 AS timestamptz), CAST($8 AS timestamptz))";

// The recording travels as one base64 parameter of up to 933,336 characters. The Data API
// documents a limit on the SQL text and on the answer, not on a parameter, so this statement runs
// alone, after the note is stored.
const INSERT_AUDIO_SQL =
  "INSERT INTO voice_note_audio (tenant_id, voice_note_id, audio, audio_mime, audio_bytes)" +
  " VALUES (current_tenant_id(), CAST($1 AS uuid), decode($2, 'base64'), $3, $4)";

// The checks that need no database, in order: switches, sizes, the recording's type, the WAV.
export function checkUpload(input: UploadInput): { durationMs: number } | Refusal {
  if (flags.voiceIntakeEnabled !== true) return refused("disabled");
  if (flags.aiEnabled !== true) return refused("ai_off");
  if (!isUuid(input.driverId)) return refused("bad_request");
  const limits = flags.voiceLimits;
  if (!(input.wav instanceof Uint8Array)) return refused("bad_wav");
  if (input.wav.byteLength > limits.maxWavBytes) return refused("too_large");
  if (input.original) {
    if (input.original.bytes.byteLength > limits.maxOriginalBytes) return refused("too_large");
    if (input.original.bytes.byteLength === 0) return refused("bad_audio");
    if (!isVoiceMime(input.original.mime)) return refused("bad_audio");
  }
  const wav = readWav(input.wav);
  if (!wav) return refused("bad_wav");
  const durationMs = Math.ceil((wav.samples * 1000) / wav.sampleRate);
  if (durationMs > limits.maxDurationMs) return refused("too_long");
  return { durationMs };
}

export async function uploadVoiceNote(
  session: Session,
  input: UploadInput,
  deps: VoiceDeps = {},
): Promise<UploadResult> {
  const checked = checkUpload(input);
  if ("ok" in checked) return checked;
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const driverId = input.driverId.toLowerCase();

  const before = await inTenant(db, session, async (q) => {
    const code = await readDriverCode(q, driverId);
    if (code === null) return "not_found" as const;
    const [row] = await q.query<{ n: number | string }>(NOTES_TODAY_SQL, [new Date(clock()).toISOString()]);
    const n = Number(row?.n);
    if (!Number.isSafeInteger(n)) throw new Error("note count unreadable");
    return n >= flags.voiceLimits.voiceNotesPerDay ? ("limit" as const) : ("ok" as const);
  });
  if (before !== "ok") return refused(before);

  const noteId = newId();
  const traceId = newId();
  let result: TranscribeResult;
  try {
    result = await (deps.transcribe ?? transcribe)(
      { ...transcribeOptions(), wav: input.wav, traceId },
      session,
    );
  } catch (err) {
    const category = aiCategory(err);
    if (category === null) throw err;
    // A failed transcription keeps no recording and no input: only the category and the size.
    console.error("voice note transcription failed:", category);
    await inTenant(db, session, (q) =>
      q.execute(INSERT_FAILED_SQL, [noteId, driverId, traceId, session.sub, category, checked.durationMs, new Date(clock()).toISOString()]),
    );
    return refused(category, TRANSIENT.has(category), noteId);
  }

  const transcript = result.transcript.trim();
  const nowIso = new Date(clock()).toISOString();
  if (transcript.length === 0) {
    await inTenant(db, session, (q) =>
      q.execute(INSERT_FAILED_SQL, [noteId, driverId, traceId, session.sub, "no_speech", checked.durationMs, nowIso]),
    );
    return refused("no_speech", false, noteId);
  }

  const inputId = newId();
  await inTenant(db, session, async (q) => {
    await q.execute(INSERT_INPUT_SQL, [inputId, driverId, transcript, untrustedContentHash("transcript", transcript), nowIso]);
    await q.execute(INSERT_NOTE_SQL, [
      noteId,
      driverId,
      inputId,
      traceId,
      session.sub,
      checked.durationMs,
      isUuid(result.callId) ? result.callId : null,
      nowIso,
    ]);
  });

  // The note and its transcript are stored. A refused recording leaves the note without one (its
  // page says no recording was kept) and is never a reason to transcribe again.
  const original = input.original;
  if (original) {
    try {
      await inTenant(db, session, (q) =>
        q.execute(INSERT_AUDIO_SQL, [noteId, base64(original.bytes), original.mime, original.bytes.byteLength]),
      );
    } catch (err) {
      console.error("voice note recording not kept:", errorName(err));
    }
  }
  return { ok: true, voiceNoteId: noteId, status: "transcribed" };
}

// --- reading one note for a step ---

type StepRow = {
  id: string;
  status: VoiceStatus;
  input_id: string | null;
  trace_id: string;
  fail_category: string | null;
  language: string | null;
  triage_category: string | null;
  amount_cents: number | string | null;
  conversation_id: string | null;
  body_text: string | null;
};

const STEP_SQL =
  "SELECT CAST(v.id AS text) AS id, v.status, CAST(v.input_id AS text) AS input_id," +
  " CAST(v.trace_id AS text) AS trace_id, v.fail_category, v.language, v.triage_category, v.amount_cents," +
  " CAST(v.conversation_id AS text) AS conversation_id, i.body_text" +
  " FROM voice_notes v LEFT JOIN untrusted_inputs i ON i.tenant_id = v.tenant_id AND i.id = v.input_id" +
  " WHERE v.tenant_id = current_tenant_id() AND v.id = CAST($1 AS uuid)";

async function readStep(q: Queryable, id: string): Promise<StepRow | null> {
  const [row] = await q.query<StepRow>(STEP_SQL, [id]);
  return row ?? null;
}

// --- 2. prepare ---

export type StepResult =
  | { ok: true; voiceNoteId: string; status: VoiceStatus; category: string | null }
  | Refusal;

const SET_STOPPED_SQL =
  "UPDATE voice_notes SET status = $2, fail_category = $3, updated_at = CAST($4 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'transcribed'";

const SET_READY_SQL =
  "UPDATE voice_notes SET status = 'ready', language = $2, language_confidence_milli = $3, english_text = $4," +
  " prepare_call_id = CAST($5 AS uuid), triage_category = $6, triage_urgency = $7," +
  " triage_call_id = CAST($8 AS uuid), amount_cents = $9, updated_at = CAST($10 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'transcribed'";

const stepOk = (id: string, status: VoiceStatus, category: string | null): StepResult => ({
  ok: true,
  voiceNoteId: id,
  status,
  category,
});

export async function prepareVoiceNote(session: Session, voiceNoteId: string, deps: VoiceDeps = {}): Promise<StepResult> {
  if (flags.voiceIntakeEnabled !== true) return refused("disabled");
  if (flags.aiEnabled !== true) return refused("ai_off");
  if (!isUuid(voiceNoteId)) return refused("bad_request");
  const id = voiceNoteId.toLowerCase();
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;
  const started = clock();

  const read = await inTenant(db, session, async (q) => ({ note: await readStep(q, id), zone: await readTenantZone(q) }));
  const note = read.note;
  if (!note) return refused("not_found");
  if (note.status !== "transcribed") return stepOk(id, note.status, note.fail_category);
  if (!note.input_id || note.body_text === null) return refused("not_found");
  const inputId = note.input_id;
  const transcript = note.body_text;

  const stop = async (status: "blocked" | "failed", category: string): Promise<StepResult> => {
    await inTenant(db, session, (q) => q.execute(SET_STOPPED_SQL, [id, status, category, new Date(clock()).toISOString()]));
    return stepOk(id, status, category);
  };

  const ctx: GatewayContext = {
    session,
    role: "triage",
    model: "spark_open",
    turnId: null,
    traceId: note.trace_id,
    now: new Date(started),
    deadlineAt: started + STEP_BUDGET_MS,
    timeZone: read.zone,
  };
  const gateway: GatewayDeps = { db, clock, ...(deps.complete ? { complete: deps.complete } : {}) };

  // The safety screen first: nothing reads the words before it passes them.
  const screen = await (deps.screen ?? screenUntrustedInput)(ctx, inputId, gateway);
  if (screen.decision === "blocked") return stop("blocked", screen.reason);

  const remaining = () => ctx.deadlineAt - clock();
  if (remaining() < MIN_CALL_MS) return refused("out_of_time", true, id);
  const call = deps.complete ?? complete;
  let answer: Awaited<ReturnType<CompleteFn>>;
  try {
    answer = await call(
      "spark",
      {
        purpose: PREPARE_CALL.purpose,
        maxCostCents: PREPARE_CALL.maxCostCents,
        timeoutMs: Math.min(PREPARE_CALL.timeoutMs, Math.floor(remaining())),
        traceId: note.trace_id,
        maxOutputTokens: PREPARE_CALL.maxOutputTokens,
        format: PREPARE_FORMAT,
        messages: [
          { role: "system", content: PREPARE_SYSTEM },
          { role: "user", content: `${UNTRUSTED_WARNING}\n\n${transcript.slice(0, PREPARE_INPUT_CHARS)}` },
        ],
      },
      session,
    );
  } catch (err) {
    const category = aiCategory(err);
    if (category === null) throw err;
    console.error("voice note prepare failed:", category);
    if (TRANSIENT.has(category)) return refused(category, true, id);
    return stop("failed", category);
  }
  const prepared = answer.status === "ok" ? parsePrepared(answer.text, transcript) : null;
  if (!prepared) return stop("failed", "bad_answer");

  // Sorting is a help, not a gate: a failed or missing classification is "other".
  let triage: TriageResult = { category: "other", urgency: "normal", callId: null, decided: false };
  if (remaining() >= MIN_CALL_MS) {
    try {
      triage = await (deps.triage ?? runTriage)(ctx, { text: prepared.englishText, inputId }, gateway);
    } catch (err) {
      if (aiCategory(err) === null) throw err;
      console.error("voice note triage failed:", aiCategory(err));
    }
  }

  const amount = extractAmountCents(transcript);
  const changed = await inTenant(db, session, (q) =>
    q.execute(SET_READY_SQL, [
      id,
      prepared.language,
      prepared.confidenceMilli,
      prepared.englishText,
      isUuid(answer.callId) ? answer.callId : null,
      triage.category,
      triage.urgency,
      triage.callId && isUuid(triage.callId) ? triage.callId : null,
      amount,
      new Date(clock()).toISOString(),
    ]),
  );
  if (changed === 0) {
    const now = await inTenant(db, session, (q) => readStep(q, id));
    return now ? stepOk(id, now.status, now.fail_category) : refused("not_found");
  }
  return stepOk(id, "ready", null);
}

// --- 3. hand off to the agent ---

export type HandOffResult =
  | { ok: true; voiceNoteId: string; status: "handed_off" | "replied"; conversationId: string | null; turnId: string | null; turnStatus: TurnStatus | null }
  | Refusal;

export const handOffText = (id: string) => `Handle voice note ${id}`;

const CLAIM_SQL =
  "UPDATE voice_notes SET status = 'handed_off', updated_at = CAST($2 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'ready'";
const UNCLAIM_SQL =
  "UPDATE voice_notes SET status = 'ready', updated_at = CAST($2 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'handed_off'" +
  " AND conversation_id IS NULL";
const LINK_SQL =
  "UPDATE voice_notes SET conversation_id = CAST($2 AS uuid), updated_at = CAST($3 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'handed_off'";

// A turn that failed or will never run, closed as failed so it does not stay running.
async function closeFailedTurn(session: Session, turnId: string, store: StoreDeps = {}): Promise<void> {
  try {
    await dbTurnStore(session, store).finishTurn(turnId, {
      status: "failed",
      endedReason: "store",
      text: LOOP_TEXT.failed,
      summary: "",
      stepCount: 0,
      modelCallCount: 0,
      costNanocents: 0,
    });
  } catch (err) {
    console.error("voice note turn could not be closed:", errorName(err));
  }
}

async function runDefault(session: Session, turn: OpenTurn, text: string, startedAt: number): Promise<TurnStatus> {
  try {
    return (await runTurn({ session, turn, text, startedAt }, defaultTurnDeps(session))).status;
  } catch (err) {
    console.error("voice note turn failed:", err instanceof Error ? err.name : "unknown");
    await closeFailedTurn(session, turn.turnId);
    return "failed";
  }
}

export async function handOffVoiceNote(session: Session, voiceNoteId: string, deps: VoiceDeps = {}): Promise<HandOffResult> {
  if (flags.voiceIntakeEnabled !== true) return refused("disabled");
  if (flags.agentEnabled !== true) return refused("agent_off");
  if (flags.aiEnabled !== true) return refused("ai_off");
  if (!isUuid(voiceNoteId)) return refused("bad_request");
  const id = voiceNoteId.toLowerCase();
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const iso = () => new Date(clock()).toISOString();

  const note = await inTenant(db, session, (q) => readStep(q, id));
  if (!note) return refused("not_found");
  if (note.status === "handed_off" || note.status === "replied") {
    return { ok: true, voiceNoteId: id, status: note.status, conversationId: note.conversation_id, turnId: null, turnStatus: null };
  }
  if (note.status !== "ready") return refused("not_ready");

  // Claim the note first, so two presses start one turn.
  const claimed = await inTenant(db, session, (q) => q.execute(CLAIM_SQL, [id, iso()]));
  if (claimed === 0) return refused("busy", true);

  const text = handOffText(id);
  let opened: Opened;
  try {
    opened = await (deps.open ?? openAgentTurn)(session, {
      conversationId: null,
      turnId: (deps.newId ?? randomUUID)(),
      text,
      now: new Date(startedAt),
      summaryChars: flags.agentTurnLimits.summaryChars,
      readNotes: true,
    });
  } catch (err) {
    await inTenant(db, session, (q) => q.execute(UNCLAIM_SQL, [id, iso()]));
    throw err;
  }
  if ("refused" in opened) {
    await inTenant(db, session, (q) => q.execute(UNCLAIM_SQL, [id, iso()]));
    return refused(opened.refused === "busy" ? "busy" : "not_found", opened.refused === "busy");
  }
  try {
    await inTenant(db, session, (q) => q.execute(LINK_SQL, [id, opened.conversationId, iso()]));
  } catch (err) {
    // The turn opened but the note may not name it. Give the claim back (UNCLAIM touches only a
    // note with no conversation, so a link that did land stays) and close the turn that will not
    // run.
    try {
      await inTenant(db, session, (q) => q.execute(UNCLAIM_SQL, [id, iso()]));
    } catch (unclaimErr) {
      console.error("voice note claim not given back:", errorName(unclaimErr));
    }
    await closeFailedTurn(session, opened.turnId, { db, clock: () => new Date(clock()) });
    throw err;
  }
  const turnStatus = await (deps.run ?? runDefault)(session, opened, text, startedAt);
  return { ok: true, voiceNoteId: id, status: "handed_off", conversationId: opened.conversationId, turnId: opened.turnId, turnStatus };
}

// --- 4. the reply draft ---

type ProposalRow = {
  status: string;
  amount_cents: number | string;
  decision_note: string | null;
  advance_status: string | null;
  advance_amount: number | string | null;
  fee_cents: number | string | null;
};

// The latest advance proposal made from this note's transcript, and its advance once approved.
const PROPOSAL_SQL =
  "SELECT p.status, p.amount_cents, p.decision_note, a.status AS advance_status," +
  " a.amount_cents AS advance_amount, a.fee_cents" +
  " FROM proposals p LEFT JOIN advances a ON a.tenant_id = p.tenant_id AND a.proposal_id = p.id" +
  " WHERE p.tenant_id = current_tenant_id() AND p.kind = 'advance_payout'" +
  " AND lower(p.args->>'requestRef') = $1" +
  " ORDER BY p.created_at DESC, p.id DESC LIMIT 1";

const SET_REPLY_SQL =
  "UPDATE voice_notes SET status = 'replied', reply_text = $2, reply_call_id = CAST($3 AS uuid)," +
  " updated_at = CAST($4 AS timestamptz)" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status IN ('handed_off', 'replied')";

function cents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// What the reply says, from the proposal and the advance, never from the model.
export function outcomeOf(
  note: { triage_category: string | null; amount_cents: number | string | null },
  proposal: ProposalRow | null,
): ReplyOutcome {
  if (!proposal) {
    return note.triage_category === "advance_request" && cents(note.amount_cents) === null
      ? { kind: "need_amount" }
      : { kind: "received" };
  }
  const amount = cents(proposal.amount_cents);
  switch (proposal.status) {
    case "proposed":
      return amount === null ? { kind: "received" } : { kind: "proposed", amountCents: amount };
    case "rejected":
    case "expired":
      return { kind: "rejected", note: proposal.status === "expired" ? "expired" : proposal.decision_note };
    case "done": {
      const paid = cents(proposal.advance_amount);
      const fee = cents(proposal.fee_cents);
      if (proposal.advance_status === "paid" && paid !== null && fee !== null) {
        return { kind: "paid", amountCents: paid, feeCents: fee };
      }
      return amount === null ? { kind: "received" } : { kind: "approved", amountCents: amount };
    }
    default:
      // approved, executing, failed: approved by a person, the payment not confirmed.
      return amount === null ? { kind: "received" } : { kind: "approved", amountCents: amount };
  }
}

export type ReplyResult =
  | { ok: true; voiceNoteId: string; status: "replied"; reply: string; replyLanguage: "en" | "es"; outcome: ReplyOutcome["kind"] }
  | Refusal;

export async function draftVoiceReply(session: Session, voiceNoteId: string, deps: VoiceDeps = {}): Promise<ReplyResult> {
  if (flags.voiceIntakeEnabled !== true) return refused("disabled");
  if (!isUuid(voiceNoteId)) return refused("bad_request");
  const id = voiceNoteId.toLowerCase();
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;

  const read = await inTenant(db, session, async (q) => {
    const note = await readStep(q, id);
    if (!note || !note.input_id) return { note, proposal: null };
    const [proposal] = await q.query<ProposalRow>(PROPOSAL_SQL, [note.input_id.toLowerCase()]);
    return { note, proposal: proposal ?? null };
  });
  const note = read.note;
  if (!note) return refused("not_found");
  if (note.status !== "handed_off" && note.status !== "replied") return refused("not_ready");

  const outcome = outcomeOf(note, read.proposal);
  const template = replyTemplate(outcome);
  let reply = template;
  let replyLanguage: "en" | "es" = "en";
  let callId: string | null = null;
  if (note.language === "es" && flags.aiEnabled === true) {
    try {
      const answer = await (deps.complete ?? complete)(
        "spark",
        {
          purpose: REPLY_CALL.purpose,
          maxCostCents: REPLY_CALL.maxCostCents,
          timeoutMs: REPLY_CALL.timeoutMs,
          traceId: note.trace_id,
          maxOutputTokens: REPLY_CALL.maxOutputTokens,
          format: REPLY_FORMAT,
          messages: [
            { role: "system", content: REPLY_SYSTEM },
            { role: "user", content: template },
          ],
        },
        session,
      );
      callId = isUuid(answer.callId) ? answer.callId : null;
      const translated = answer.status === "ok" ? parseTranslated(answer.text, template) : null;
      if (translated !== null) {
        reply = translated;
        replyLanguage = "es";
      }
    } catch (err) {
      // The English sentence stands; a person can still copy it.
      if (aiCategory(err) === null) throw err;
      console.error("voice note reply translation failed:", aiCategory(err));
    }
  }

  const changed = await inTenant(db, session, (q) => q.execute(SET_REPLY_SQL, [id, reply, callId, new Date(clock()).toISOString()]));
  if (changed === 0) return refused("not_ready");
  return { ok: true, voiceNoteId: id, status: "replied", reply, replyLanguage, outcome: outcome.kind };
}
