import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiResult, type TranscribeResult } from "../ai";
import type { ScreenOutcome } from "../agent/gateway/screen";
import { buildStateSummary } from "../agent/gateway/store/summary";
import { VOICE_NOTE_SQL } from "../agent/gateway/tools/read/get-voice-note";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { assertMembership } from "../tenant/context";
import {
  draftVoiceReply,
  handOffText,
  handOffVoiceNote,
  NOTES_TODAY_SQL,
  prepareVoiceNote,
  uploadVoiceNote,
  type VoiceDeps,
} from "./pipeline";
import { readVoiceAudio, readVoiceDetail, readVoiceList } from "./read";
import { encodeWav } from "./wav-encode";

// Voice notes against a real database, as the app's own role, with the models, the screen and
// the agent faked: a note goes from upload to reply draft; the recording reads back byte for byte;
// the words stay hidden until the screen passed them; the daily count follows the carrier's own
// day; the recording, its tenant and its driver cannot be changed; the checks hold; another
// carrier sees nothing. Fixed instants only. Every tenant made here is removed after each test.

const saved = structuredClone(flags);
// 10:00 in Chicago on Monday Nov 2, 2026.
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const TRANSCRIPT = "Hola, necesito un adelanto de 300 dólares para diesel, por favor.";
const ENGLISH = "Hi, I need a $300 advance for diesel, please.";

let admin: Db;
let app: Db;
let A: Fixture | undefined;
let B: Fixture | undefined;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function modelAnswer(text: string): AiResult {
  return {
    callId: randomUUID(),
    status: "ok",
    text,
    toolCalls: [],
    usage: {} as AiResult["usage"],
    costNanocents: 1,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  };
}

const screenAllowed = (inputId: string): ScreenOutcome =>
  ({
    verdict: {
      inputId,
      verdict: "clean",
      categories: [],
      confidence: null,
      contentHash: "h",
      via: "model",
      modelCallId: null,
      screenerVersion: 1,
    },
    decisionId: randomUUID(),
    decision: "allowed",
    reason: "ok",
  }) as ScreenOutcome;

function deps(over: Partial<VoiceDeps> = {}): VoiceDeps {
  return {
    db: app,
    clock: () => NOW,
    transcribe: async (): Promise<TranscribeResult> => ({
      callId: randomUUID(),
      transcript: TRANSCRIPT,
      turns: [],
      audioDurationMs: 1_000,
      costNanocents: 1,
    }),
    screen: async (_ctx, inputId) => screenAllowed(inputId),
    complete: async () =>
      modelAnswer(JSON.stringify({ language: "es", confidence: 0.95, english_text: ENGLISH, summary: "Advance ask." })),
    triage: async () => ({ category: "advance_request", urgency: "normal", callId: null, decided: true }),
    ...over,
  };
}

const wav = () => encodeWav(new Float32Array(16_000).fill(0.2));

async function uploaded(f: Fixture, original: Uint8Array | null = randomBytes(1_000), d: VoiceDeps = deps()) {
  const r = await uploadVoiceNote(
    f.session,
    { driverId: f.driverId, wav: wav(), original: original ? { bytes: original, mime: "audio/webm" } : null },
    d,
  );
  if (!r.ok) throw new Error(`upload refused: ${r.category}`);
  return r.voiceNoteId;
}

// A note row written by the admin login, so created_at and every column can be set directly.
async function addNote(f: Fixture, cols: Record<string, string | number | null> = {}) {
  const id = randomUUID();
  const row: Record<string, string | number | null> = {
    id,
    trace_id: randomUUID(),
    created_by: f.session.sub,
    status: "failed",
    fail_category: "timeout",
    created_at: new Date(NOW).toISOString(),
    ...cols,
  };
  const names = Object.keys(row);
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO voice_notes (tenant_id, ${names.join(", ")}) VALUES (current_tenant_id(), ${names
        .map((n, i) => (n === "audio" ? `decode($${i + 1}, 'base64')` : `$${i + 1}`))
        .join(", ")})`,
      names.map((n) => row[n]),
    ),
  );
  return id;
}

describe("voice notes (database)", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    flags.voiceIntakeEnabled = true;
    flags.aiEnabled = true;
    flags.agentEnabled = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tag = randomBytes(4).toString("hex");
    A = await makeTenant(admin, `voice-a-${tag}`);
    B = await makeTenant(admin, `voice-b-${tag}`);
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    vi.restoreAllMocks();
    for (const f of [A, B]) await dropTenant(admin, f);
    A = undefined;
    B = undefined;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("takes a note from upload to a reply draft, keeping the words hidden until the screen passed them", async () => {
    const f = A!;
    const id = await uploaded(f);
    const read = (noteId: string) =>
      app.withTenant(f.tenantId, async (q) => {
        await assertMembership(q, f.session);
        return readVoiceDetail(q, noteId);
      });

    const fresh = await read(id);
    expect(fresh).toMatchObject({ status: "transcribed", driverCode: "DRV-1", hasAudio: true, audioMime: "audio/webm", durationMs: 1_000 });
    expect(fresh?.transcript).toBeNull();
    expect(fresh?.createdAt).toBe("2026-11-02T16:00:00.000Z");

    expect(await prepareVoiceNote(f.session, id, deps())).toEqual({ ok: true, voiceNoteId: id, status: "ready", category: null });
    const ready = await read(id);
    expect(ready).toMatchObject({
      status: "ready",
      language: "es",
      confidenceMilli: 950,
      englishText: ENGLISH,
      transcript: TRANSCRIPT,
      category: "advance_request",
      urgency: "normal",
      amountCents: 30_000,
    });

    // The agent's read finds the note by its transcript's input.
    const inputId = ready!.inputId!;
    const [found] = await app.withTenant(f.tenantId, (q) => q.query<{ id: string; english_text: string }>(VOICE_NOTE_SQL, [inputId]));
    expect(found).toMatchObject({ id, english_text: ENGLISH });

    // Hand-off: the turn is faked, but its conversation is real, so the link holds.
    const conversationId = randomUUID();
    await admin.withTenant(f.tenantId, (q) =>
      q.execute("INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)", [
        conversationId,
        f.session.sub,
      ]),
    );
    const handed = await handOffVoiceNote(
      f.session,
      id,
      deps({
        newId: () => randomUUID(),
        open: async (_s, input) => ({ conversationId, turnId: input.turnId }) as never,
        run: async () => "done",
      }),
    );
    expect(handed).toMatchObject({ ok: true, status: "handed_off", conversationId, turnStatus: "done" });
    expect((await read(id))?.conversationId).toBe(conversationId);

    // The state summary for the hand-off sentence names the note's ids, never its words.
    const summary = await app.withTenant(f.tenantId, (q) =>
      buildStateSummary(q, f.session, conversationId, new Date(NOW), 10_000, handOffText(id)),
    );
    expect(summary.text).toContain("Voice note to handle:");
    expect(summary.text).toContain(`requestRef ${inputId}`);
    expect(summary.text).toContain("requestedOn 2026-11-02");
    expect(summary.text).not.toContain("adelanto");
    expect(summary.text).not.toContain("diesel");

    // No proposal yet: the draft says the note was received, translated back to Spanish.
    const spanish = "Recibimos tu nota de voz. La oficina la está revisando y te responderá.";
    const reply = await draftVoiceReply(f.session, id, deps({ complete: async () => modelAnswer(JSON.stringify({ reply: spanish })) }));
    expect(reply).toEqual({ ok: true, voiceNoteId: id, status: "replied", reply: spanish, replyLanguage: "es", outcome: "received" });
    expect((await read(id))?.replyText).toBe(spanish);

    // Once the agent proposed an advance from this note, the draft names the proposal's amount.
    // A translation that loses the figure is dropped for the English sentence.
    const [turnId, decisionId, proposalId] = [randomUUID(), randomUUID(), randomUUID()];
    await admin.withTenant(f.tenantId, async (q) => {
      await q.execute(
        `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, $3, 'done', 'trace-voice-1',
           CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
        [turnId, conversationId, handOffText(id), new Date(NOW).toISOString()],
      );
      await q.execute(
        `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'trace-voice-1', 'operator', 'spark',
           'propose_advance', 'propose', 'allowed', 'ok', 1)`,
        [decisionId, turnId],
      );
      await q.execute(
        `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
           amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
           created_at, updated_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'advance_payout',
           'drivers', CAST($4 AS uuid), 30000, 'out', 'Advance', CAST($5 AS jsonb), 'eligible', CAST($6 AS uuid),
           $7, 'trace-voice-1', CAST($8 AS timestamptz), CAST($8 AS timestamptz))`,
        [
          proposalId,
          conversationId,
          turnId,
          f.driverId,
          JSON.stringify({ driverId: f.driverId, amountCents: 30_000, requestRef: inputId.toUpperCase() }),
          decisionId,
          `advance_payout:${f.driverId}:${randomBytes(32).toString("hex")}`,
          new Date(NOW).toISOString(),
        ],
      );
    });
    const proposed = await draftVoiceReply(
      f.session,
      id,
      deps({ complete: async () => modelAnswer(JSON.stringify({ reply: "Recibimos tu solicitud de adelanto." })) }),
    );
    expect(proposed).toMatchObject({ ok: true, replyLanguage: "en", outcome: "proposed" });
    expect((proposed as { reply: string }).reply).toContain("$300.00");
    const shown = await read(id);
    expect(shown?.proposal).toEqual({ id: proposalId, status: "proposed", amountCents: 30_000 });
  });

  it("reads the recording back byte for byte at the cap", async () => {
    const f = A!;
    const original = randomBytes(flags.voiceLimits.maxOriginalBytes);
    const id = await uploaded(f, original);
    const audio = await app.withTenant(f.tenantId, (q) => readVoiceAudio(q, id));
    expect(audio?.mime).toBe("audio/webm");
    expect(audio?.bytes.byteLength).toBe(original.byteLength);
    expect(sha(audio!.bytes)).toBe(sha(original));
  });

  it("keeps no recording and no input for a failed transcription", async () => {
    const f = A!;
    const r = await uploadVoiceNote(
      f.session,
      { driverId: f.driverId, wav: wav(), original: { bytes: randomBytes(500), mime: "audio/webm" } },
      deps({
        transcribe: async () => {
          throw new AiError("timeout");
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, category: "timeout", retryable: true });
    const id = (r as { voiceNoteId: string }).voiceNoteId;
    const detail = await app.withTenant(f.tenantId, (q) => readVoiceDetail(q, id));
    expect(detail).toMatchObject({ status: "failed", failCategory: "timeout", hasAudio: false, inputId: null });
    const [inputs] = await app.withTenant(f.tenantId, (q) =>
      q.query<{ n: number }>("SELECT CAST(count(*) AS integer) AS n FROM untrusted_inputs WHERE tenant_id = current_tenant_id()"),
    );
    expect(inputs.n).toBe(0);
  });

  it("counts the notes of the carrier's own day, in its own time zone", async () => {
    const f = A!;
    // Chicago is UTC-6 on Nov 2. Its day runs from 06:00Z Nov 2 to 06:00Z Nov 3.
    for (const at of ["2026-11-02T05:59:59Z", "2026-11-02T06:00:00Z", "2026-11-02T23:30:00Z", "2026-11-03T05:59:59Z", "2026-11-03T06:00:00Z"]) {
      await addNote(f, { created_at: at });
    }
    await addNote(B!, { created_at: "2026-11-02T12:00:00Z" });
    const count = (instant: string) =>
      app.withTenant(f.tenantId, async (q) => Number((await q.query<{ n: number }>(NOTES_TODAY_SQL, [instant]))[0].n));
    expect(await count("2026-11-02T16:00:00.000Z")).toBe(3);
    expect(await count("2026-11-02T05:00:00.000Z")).toBe(1);
    expect(await count("2026-11-03T12:00:00.000Z")).toBe(1);
  });

  it("refuses a new note once the day's limit is reached", async () => {
    const f = A!;
    flags.voiceLimits.voiceNotesPerDay = 2;
    await addNote(f);
    await addNote(f);
    let transcribed = 0;
    const r = await uploadVoiceNote(
      f.session,
      { driverId: f.driverId, wav: wav(), original: null },
      deps({
        transcribe: async () => {
          transcribed += 1;
          throw new Error("must not be called");
        },
      }),
    );
    expect(r).toEqual({ ok: false, category: "limit", retryable: false });
    expect(transcribed).toBe(0);
  });

  it("shows another carrier nothing, and refuses a row written into it", async () => {
    const id = await uploaded(A!);
    const b = B!;
    const seen = await app.withTenant(b.tenantId, async (q) => ({
      list: await readVoiceList(q, null),
      detail: await readVoiceDetail(q, id),
      audio: await readVoiceAudio(q, id),
    }));
    expect(seen).toEqual({ list: [], detail: null, audio: null });
    expect(await prepareVoiceNote(b.session, id, deps())).toMatchObject({ ok: false, category: "not_found" });
    expect(await draftVoiceReply(b.session, id, deps())).toMatchObject({ ok: false, category: "not_found" });
    // A driver of carrier A cannot get a note under carrier B.
    expect(
      await uploadVoiceNote(b.session, { driverId: A!.driverId, wav: wav(), original: null }, deps()),
    ).toMatchObject({ ok: false, category: "not_found" });
    const state = await sqlStateOf(
      app.withTenant(b.tenantId, (q) =>
        q.execute(
          "INSERT INTO voice_notes (id, tenant_id, trace_id, created_by, status, fail_category) VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), 'x', 'failed', 'timeout')",
          [randomUUID(), A!.tenantId, randomUUID()],
        ),
      ),
    );
    expect(state).toBe("42501");
    const changed = await app.withTenant(b.tenantId, (q) =>
      q.execute("UPDATE voice_notes SET status = 'failed', fail_category = 'timeout' WHERE id = CAST($1 AS uuid)", [id]),
    );
    expect(changed).toBe(0);
  });

  it("fixes the recording, its driver, its input and its tenant once written", async () => {
    const f = A!;
    const id = await uploaded(f);
    for (const set of [
      "audio = decode('AAAA', 'base64')",
      "audio_mime = 'audio/wav'",
      "audio_bytes = 3",
      "driver_id = NULL",
      "input_id = NULL",
      "trace_id = gen_random_uuid()",
      `tenant_id = CAST('${B!.tenantId}' AS uuid)`,
    ]) {
      const state = await sqlStateOf(
        app.withTenant(f.tenantId, (q) =>
          q.execute(`UPDATE voice_notes SET ${set} WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`, [id]),
        ),
      );
      expect(state, set).toBe("42501");
    }
  });

  it("holds the table's checks", async () => {
    const f = A!;
    const b64 = (n: number) => randomBytes(n).toString("base64");
    const refused = async (cols: Record<string, string | number | null>) => sqlStateOf(addNote(f, cols));
    expect(await refused({ status: "replied", fail_category: null, language: "es", english_text: "x" })).toBe("23514");
    expect(await refused({ status: "failed", fail_category: null })).toBe("23514");
    expect(await refused({ status: "transcribed", fail_category: "timeout" })).toBe("23514");
    expect(await refused({ status: "ready", fail_category: null })).toBe("23514");
    expect(await refused({ fail_category: "Upstream said 500" })).toBe("23514");
    expect(await refused({ audio: b64(10), audio_mime: "text/html", audio_bytes: 10 })).toBe("23514");
    expect(await refused({ audio: b64(10), audio_mime: "audio/webm", audio_bytes: 11 })).toBe("23514");
    expect(await refused({ audio: b64(10), audio_mime: null, audio_bytes: 10 })).toBe("23514");
    expect(await refused({ audio: b64(700_001), audio_mime: "audio/webm", audio_bytes: 700_001 })).toBe("23514");
    expect(await refused({ amount_cents: 0 })).toBe("23514");
    expect(await refused({ language_confidence_milli: 1_001 })).toBe("23514");
    expect(await refused({ status: "nonsense" })).toBe("23514");
    expect(await refused({ audio: b64(10), audio_mime: "audio/webm", audio_bytes: 10 })).toBe("no error");
  });
});
