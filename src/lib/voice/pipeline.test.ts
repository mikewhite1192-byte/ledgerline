import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiResult, type TranscribeRequest, type TranscribeResult } from "../ai";
import type { ScreenOutcome } from "../agent/gateway/screen";
import { UNTRUSTED_WARNING } from "../agent/gateway/tools/read/get-inbound-message";
import type { Param, Queryable, TenantDb } from "../db";
import {
  checkUpload,
  draftVoiceReply,
  handOffText,
  handOffVoiceNote,
  MIN_CALL_MS,
  outcomeOf,
  PREPARE_CALL,
  prepareVoiceNote,
  REPLY_CALL,
  STEP_BUDGET_MS,
  transcribeOptions,
  uploadVoiceNote,
  type UploadInput,
  type VoiceDeps,
} from "./pipeline";
import { encodeWav } from "./wav-encode";

// The four voice steps with the database, the models, the screen and the agent faked: the order
// of the checks, what each step stores, what a failure leaves behind, and that the words of a
// note never reach the log. No database, no network, no wall clock.

const saved = structuredClone(flags);
const T0 = Date.UTC(2026, 10, 2, 16, 0, 0);
const session = { sub: "sub-1", email: "staff@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const DRIVER = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";
const INPUT = "44444444-4444-4444-8444-444444444444";
const TRACE = "55555555-5555-4555-8555-555555555555";
const CALL = "66666666-6666-4666-8666-666666666666";
const TRANSCRIPT = "Hola, necesito un adelanto de 300 dólares para diesel.";

let logged: unknown[][] = [];

beforeEach(() => {
  Object.assign(flags, structuredClone(saved));
  flags.voiceIntakeEnabled = true;
  flags.aiEnabled = true;
  flags.agentEnabled = true;
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  // Nothing a driver said, and no upstream text, is ever logged.
  for (const line of logged) {
    const text = line.map(String).join(" ");
    expect(text).not.toContain("adelanto");
    expect(text).not.toContain("upstream");
  }
  vi.restoreAllMocks();
});

type StepRow = {
  id: string;
  status: string;
  input_id: string | null;
  trace_id: string;
  fail_category: string | null;
  language: string | null;
  triage_category: string | null;
  amount_cents: number | null;
  conversation_id: string | null;
  body_text: string | null;
};

const stepRow = (over: Partial<StepRow> = {}): StepRow => ({
  id: NOTE,
  status: "transcribed",
  input_id: INPUT,
  trace_id: TRACE,
  fail_category: null,
  language: null,
  triage_category: null,
  amount_cents: null,
  conversation_id: null,
  body_text: TRANSCRIPT,
  ...over,
});

type Fake = {
  member?: boolean;
  driverCode?: string | null;
  notesToday?: number;
  note?: StepRow | null;
  // Rows read on a second read of the note, after an update changed nothing.
  noteAfter?: StepRow | null;
  proposal?: Record<string, unknown> | null;
  // Rows affected per statement, by a word it contains; 1 when not named.
  affected?: Record<string, number>;
};

type Written = { sql: string; params: Param[] };

function fakeDb(f: Fake = {}): TenantDb & { writes: Written[]; reads: string[] } {
  const writes: Written[] = [];
  const reads: string[] = [];
  let noteReads = 0;
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      reads.push(sql);
      if (sql.includes("FROM memberships")) return ((f.member ?? true) ? [{ ok: 1 }] : []) as T[];
      if (sql.includes("count(*)")) return [{ n: f.notesToday ?? 0 }] as T[];
      if (sql.includes("FROM drivers")) {
        const code = f.driverCode === undefined ? "BR-C01" : f.driverCode;
        return (code && params[0] === DRIVER ? [{ code }] : []) as T[];
      }
      if (sql.startsWith("SELECT timezone FROM tenants")) return [{ timezone: "America/Chicago" }] as T[];
      if (sql.includes("FROM voice_notes v LEFT JOIN untrusted_inputs")) {
        noteReads += 1;
        const row = noteReads > 1 && f.noteAfter !== undefined ? f.noteAfter : f.note === undefined ? stepRow() : f.note;
        return (row ? [row] : []) as T[];
      }
      if (sql.includes("FROM proposals p")) return (f.proposal ? [f.proposal] : []) as T[];
      throw new Error(`unexpected read: ${sql.slice(0, 60)}`);
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      writes.push({ sql, params });
      for (const [word, n] of Object.entries(f.affected ?? {})) if (sql.includes(word)) return n;
      return 1;
    },
  };
  return { writes, reads, withTenant: async (_tenant, fn) => fn(q) } as TenantDb & { writes: Written[]; reads: string[] };
}

function ids(...list: string[]) {
  let i = 0;
  return () => {
    const next = list[i];
    i += 1;
    if (!next) throw new Error("ran out of ids");
    return next;
  };
}

const oneSecond = () => encodeWav(new Float32Array(16_000).fill(0.1));

const upload = (over: Partial<UploadInput> = {}): UploadInput => ({
  driverId: DRIVER,
  wav: oneSecond(),
  original: { bytes: new Uint8Array([1, 2, 3, 4]), mime: "audio/webm" },
  ...over,
});

const aiAnswer = (text: string, over: Partial<AiResult> = {}): AiResult => ({
  callId: CALL,
  status: "ok",
  text,
  toolCalls: [],
  usage: {} as AiResult["usage"],
  costNanocents: 1,
  upstreamId: null,
  replay: [],
  toolSearches: 0,
  ...over,
});

const prepared = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ language: "es", confidence: 0.96, english_text: "Hi, I need a $300 advance for diesel.", summary: "Advance ask.", ...over });

const screened = (decision: "allowed" | "blocked", reason: ScreenOutcome["reason"], verdict: "clean" | "flagged" = "clean"): ScreenOutcome => ({
  verdict: {
    inputId: INPUT,
    verdict,
    categories: verdict === "flagged" ? ["instruction_to_agent"] : [],
    confidence: null,
    contentHash: "h",
    via: "model",
    modelCallId: null,
    screenerVersion: 1,
  } as ScreenOutcome["verdict"],
  decisionId: "77777777-7777-4777-8777-777777777777",
  decision,
  reason,
});

describe("checkUpload", () => {
  it("passes a short clip and measures it", () => {
    expect(checkUpload(upload())).toEqual({ durationMs: 1_000 });
    expect(checkUpload(upload({ original: null }))).toEqual({ durationMs: 1_000 });
  });

  it("checks the switches first, then the driver, the sizes, the type and the clip", () => {
    const refusal = (input: UploadInput) => {
      const r = checkUpload(input);
      return "ok" in r ? r.category : "passed";
    };
    flags.voiceIntakeEnabled = false;
    expect(refusal(upload({ driverId: "x" }))).toBe("disabled");
    flags.voiceIntakeEnabled = true;
    flags.aiEnabled = false;
    expect(refusal(upload({ driverId: "x" }))).toBe("ai_off");
    flags.aiEnabled = true;
    expect(refusal(upload({ driverId: "x" }))).toBe("bad_request");
    expect(refusal(upload({ wav: "RIFF" as unknown as Uint8Array }))).toBe("bad_wav");
    expect(refusal(upload({ wav: new Uint8Array(flags.voiceLimits.maxWavBytes + 1) }))).toBe("too_large");
    const big = new Uint8Array(flags.voiceLimits.maxOriginalBytes + 1);
    expect(refusal(upload({ original: { bytes: big, mime: "audio/webm" } }))).toBe("too_large");
    expect(refusal(upload({ original: { bytes: new Uint8Array(0), mime: "audio/webm" } }))).toBe("bad_audio");
    expect(refusal(upload({ original: { bytes: new Uint8Array(4), mime: "text/html" } }))).toBe("bad_audio");
    expect(refusal(upload({ wav: new Uint8Array(100) }))).toBe("bad_wav");
    flags.voiceLimits.maxDurationMs = 999;
    expect(refusal(upload())).toBe("too_long");
  });

  it("asks the transcription for a capped, push-to-talk call biased to Spanish and English", () => {
    expect(transcribeOptions()).toEqual({
      mode: "PUSH_TO_TALK",
      languageBias: ["Spanish", "English"],
      keywords: ["advance", "adelanto", "fuel", "diesel", "settlement", "pay"],
      purpose: "voice_note_transcribe",
      maxCostCents: 2,
      timeoutMs: 20_000,
    });
    expect(PREPARE_CALL).toEqual({ purpose: "voice_note_prepare", maxCostCents: 3, timeoutMs: 15_000, maxOutputTokens: 600 });
    expect(REPLY_CALL).toEqual({ purpose: "voice_note_reply", maxCostCents: 2, timeoutMs: 12_000, maxOutputTokens: 400 });
    expect(STEP_BUDGET_MS + MIN_CALL_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("uploadVoiceNote", () => {
  const transcribed = (transcript = TRANSCRIPT): TranscribeResult => ({
    callId: CALL,
    transcript,
    turns: [],
    audioDurationMs: 1_000,
    costNanocents: 1,
  });

  function deps(db: TenantDb, transcribe: VoiceDeps["transcribe"]): VoiceDeps & { sent: TranscribeRequest[] } {
    const sent: TranscribeRequest[] = [];
    return {
      sent,
      db,
      clock: () => T0,
      newId: ids(NOTE, TRACE, INPUT),
      transcribe: async (request, s) => {
        sent.push(request);
        return transcribe!(request, s);
      },
    };
  }

  it("stores the transcript as an untrusted input and the recording as base64", async () => {
    const db = fakeDb();
    const d = deps(db, async () => transcribed(`  ${TRANSCRIPT}  `));
    const input = upload();
    expect(await uploadVoiceNote(session, input, d)).toEqual({ ok: true, voiceNoteId: NOTE, status: "transcribed" });
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].traceId).toBe(TRACE);
    expect(d.sent[0].wav).toBe(input.wav);
    expect(db.reads.find((s) => s.includes("count(*)"))).toBeDefined();
    const [inputRow, noteRow] = db.writes;
    expect(inputRow.sql).toMatch(/^INSERT INTO untrusted_inputs/);
    expect(inputRow.params.slice(0, 3)).toEqual([INPUT, DRIVER, TRANSCRIPT]);
    expect(inputRow.params[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(inputRow.params[4]).toBe("2026-11-02T16:00:00.000Z");
    expect(noteRow.sql).toMatch(/^INSERT INTO voice_notes/);
    expect(noteRow.sql).toContain("decode($6, 'base64')");
    expect(noteRow.params).toEqual([
      NOTE,
      DRIVER,
      INPUT,
      TRACE,
      "sub-1",
      Buffer.from([1, 2, 3, 4]).toString("base64"),
      "audio/webm",
      4,
      1_000,
      CALL,
      "2026-11-02T16:00:00.000Z",
    ]);
  });

  it("keeps no recording when none was sent, and no call id that is not one", async () => {
    const db = fakeDb();
    const d = deps(db, async () => ({ ...transcribed(), callId: "not-an-id" }));
    await uploadVoiceNote(session, upload({ original: null }), d);
    expect(db.writes[1].params.slice(5, 8)).toEqual([null, null, null]);
    expect(db.writes[1].params[9]).toBeNull();
  });

  it("refuses an unknown driver and a full day before any model call", async () => {
    const none = deps(fakeDb({ driverCode: null }), async () => transcribed());
    expect(await uploadVoiceNote(session, upload(), none)).toEqual({ ok: false, category: "not_found", retryable: false });
    const full = deps(fakeDb({ notesToday: flags.voiceLimits.voiceNotesPerDay }), async () => transcribed());
    expect(await uploadVoiceNote(session, upload(), full)).toEqual({ ok: false, category: "limit", retryable: false });
    const under = deps(fakeDb({ notesToday: flags.voiceLimits.voiceNotesPerDay - 1 }), async () => transcribed());
    expect((await uploadVoiceNote(session, upload(), under)).ok).toBe(true);
    expect(none.sent).toHaveLength(0);
    expect(full.sent).toHaveLength(0);
  });

  it("refuses a login that is not a member of the carrier", async () => {
    const d = deps(fakeDb({ member: false }), async () => transcribed());
    await expect(uploadVoiceNote(session, upload(), d)).rejects.toThrow();
    expect(d.sent).toHaveLength(0);
  });

  it.each([
    ["timeout", true],
    ["unavailable", true],
    ["rate_limited", true],
    ["network", true],
    ["cap", false],
    ["too_expensive", false],
    ["bad_request", false],
    ["auth", false],
  ] as const)("stores a %s failure with no recording and no input", async (category, retryable) => {
    const db = fakeDb();
    const d = deps(db, async () => {
      throw new AiError(category);
    });
    expect(await uploadVoiceNote(session, upload(), d)).toEqual({ ok: false, category, retryable, voiceNoteId: NOTE });
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].sql).toMatch(/^INSERT INTO voice_notes/);
    expect(db.writes[0].sql).not.toContain("audio");
    expect(db.writes[0].sql).not.toContain("input_id");
    expect(db.writes[0].params).toEqual([NOTE, DRIVER, TRACE, "sub-1", category, 1_000, "2026-11-02T16:00:00.000Z"]);
  });

  it("rethrows a failure that is not a model failure, storing nothing", async () => {
    const db = fakeDb();
    const d = deps(db, async () => {
      throw new Error("upstream said no");
    });
    await expect(uploadVoiceNote(session, upload(), d)).rejects.toThrow("upstream said no");
    expect(db.writes).toHaveLength(0);
  });

  it("stores an empty transcript as no speech", async () => {
    const db = fakeDb();
    const d = deps(db, async () => transcribed("   "));
    expect(await uploadVoiceNote(session, upload(), d)).toEqual({ ok: false, category: "no_speech", retryable: false, voiceNoteId: NOTE });
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].params[4]).toBe("no_speech");
  });
});

describe("prepareVoiceNote", () => {
  type Calls = { complete: unknown[]; triage: unknown[]; screen: number };

  function deps(db: TenantDb, over: Partial<VoiceDeps> = {}, now = { t: T0 }): VoiceDeps & { calls: Calls } {
    const calls: Calls = { complete: [], triage: [], screen: 0 };
    return {
      calls,
      db,
      clock: () => now.t,
      screen: async () => {
        calls.screen += 1;
        return screened("allowed", "ok");
      },
      complete: async (target, request) => {
        calls.complete.push({ target, request });
        return aiAnswer(prepared());
      },
      triage: async (_ctx, input) => {
        calls.triage.push(input);
        return { category: "advance_request", urgency: "normal", callId: CALL, decided: true };
      },
      ...over,
    };
  }

  it("screens, prepares, sorts and stores the note as ready with the amount heard", async () => {
    const db = fakeDb();
    const d = deps(db);
    expect(await prepareVoiceNote(session, NOTE.toUpperCase(), d)).toEqual({ ok: true, voiceNoteId: NOTE, status: "ready", category: null });
    expect(d.calls.screen).toBe(1);
    const sent = d.calls.complete[0] as { target: string; request: { purpose: string; maxCostCents: number; timeoutMs: number; traceId: string; messages: { content: string }[] } };
    expect(sent.target).toBe("spark");
    expect(sent.request).toMatchObject({ purpose: "voice_note_prepare", maxCostCents: 3, timeoutMs: 15_000, traceId: TRACE });
    expect(sent.request.messages[1].content.startsWith(UNTRUSTED_WARNING)).toBe(true);
    expect(sent.request.messages[1].content).toContain(TRANSCRIPT);
    expect(d.calls.triage[0]).toEqual({ text: "Hi, I need a $300 advance for diesel.", inputId: INPUT });
    const ready = db.writes.at(-1)!;
    expect(ready.sql).toMatch(/SET status = 'ready'/);
    expect(ready.params).toEqual([
      NOTE,
      "es",
      960,
      "Hi, I need a $300 advance for diesel.",
      CALL,
      "advance_request",
      "normal",
      CALL,
      30_000,
      "2026-11-02T16:00:00.000Z",
    ]);
  });

  it("stops at the screen: a blocked note is never read by a model", async () => {
    for (const reason of ["screen_error", "budget"] as const) {
      const db = fakeDb();
      const d = deps(db, { screen: async () => screened("blocked", reason) });
      expect(await prepareVoiceNote(session, NOTE, d)).toEqual({ ok: true, voiceNoteId: NOTE, status: "blocked", category: reason });
      expect(d.calls.complete).toHaveLength(0);
      expect(d.calls.triage).toHaveLength(0);
      expect(db.writes).toHaveLength(1);
      expect(db.writes[0].sql).toContain("status = 'transcribed'");
      expect(db.writes[0].params.slice(0, 3)).toEqual([NOTE, "blocked", reason]);
    }
  });

  it("lets a flagged note through to be prepared, so its card needs the second confirm later", async () => {
    const db = fakeDb();
    const d = deps(db, { screen: async () => screened("allowed", "screen_flagged", "flagged") });
    expect((await prepareVoiceNote(session, NOTE, d)).ok).toBe(true);
    expect(d.calls.complete).toHaveLength(1);
  });

  it("keeps the note's place on a passing model failure and stops it on a lasting one", async () => {
    const passing = fakeDb();
    const p = deps(passing, {
      complete: async () => {
        throw new AiError("timeout");
      },
    });
    expect(await prepareVoiceNote(session, NOTE, p)).toEqual({ ok: false, category: "timeout", retryable: true, voiceNoteId: NOTE });
    expect(passing.writes).toHaveLength(0);

    const lasting = fakeDb();
    const l = deps(lasting, {
      complete: async () => {
        throw new AiError("cap");
      },
    });
    expect(await prepareVoiceNote(session, NOTE, l)).toEqual({ ok: true, voiceNoteId: NOTE, status: "failed", category: "cap" });
    expect(lasting.writes[0].params.slice(0, 3)).toEqual([NOTE, "failed", "cap"]);
  });

  it("stops on an answer it cannot use", async () => {
    for (const answer of [aiAnswer("not json"), aiAnswer(prepared(), { status: "incomplete" }), aiAnswer(prepared({ language: "fr" }))]) {
      const db = fakeDb();
      const d = deps(db, { complete: async () => answer });
      expect(await prepareVoiceNote(session, NOTE, d)).toEqual({ ok: true, voiceNoteId: NOTE, status: "failed", category: "bad_answer" });
      expect(d.calls.triage).toHaveLength(0);
    }
  });

  it("sorts as other when the sorting call fails", async () => {
    const db = fakeDb();
    const d = deps(db, {
      triage: async () => {
        throw new AiError("unavailable");
      },
    });
    expect((await prepareVoiceNote(session, NOTE, d)).ok).toBe(true);
    expect(db.writes.at(-1)!.params.slice(5, 8)).toEqual(["other", "normal", null]);
  });

  it("refuses to start a model call with too little time left", async () => {
    const now = { t: T0 };
    const db = fakeDb();
    const d = deps(
      db,
      {
        screen: async () => {
          now.t = T0 + STEP_BUDGET_MS - MIN_CALL_MS + 1;
          return screened("allowed", "ok");
        },
      },
      now,
    );
    expect(await prepareVoiceNote(session, NOTE, d)).toEqual({ ok: false, category: "out_of_time", retryable: true, voiceNoteId: NOTE });
    expect(d.calls.complete).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  it("gives the model only the time the step has left", async () => {
    const now = { t: T0 };
    const db = fakeDb();
    const d = deps(
      db,
      {
        screen: async () => {
          now.t = T0 + 20_000;
          return screened("allowed", "ok");
        },
      },
      now,
    );
    await prepareVoiceNote(session, NOTE, d);
    expect((d.calls.complete[0] as { request: { timeoutMs: number } }).request.timeoutMs).toBe(STEP_BUDGET_MS - 20_000);
  });

  it("answers a note past this step with where it is, without calling anything", async () => {
    const d = deps(fakeDb({ note: stepRow({ status: "blocked", fail_category: "screen_error" }) }));
    expect(await prepareVoiceNote(session, NOTE, d)).toEqual({ ok: true, voiceNoteId: NOTE, status: "blocked", category: "screen_error" });
    expect(d.calls.screen).toBe(0);
  });

  it("reads the note again when another press got there first", async () => {
    const db = fakeDb({ affected: { "SET status = 'ready'": 0 }, noteAfter: stepRow({ status: "ready" }) });
    expect(await prepareVoiceNote(session, NOTE, deps(db))).toEqual({ ok: true, voiceNoteId: NOTE, status: "ready", category: null });
  });

  it("refuses when switched off, a bad id or an unknown note", async () => {
    flags.voiceIntakeEnabled = false;
    expect(await prepareVoiceNote(session, NOTE, deps(fakeDb()))).toMatchObject({ category: "disabled" });
    flags.voiceIntakeEnabled = true;
    flags.aiEnabled = false;
    expect(await prepareVoiceNote(session, NOTE, deps(fakeDb()))).toMatchObject({ category: "ai_off" });
    flags.aiEnabled = true;
    expect(await prepareVoiceNote(session, "nope", deps(fakeDb()))).toMatchObject({ category: "bad_request" });
    expect(await prepareVoiceNote(session, NOTE, deps(fakeDb({ note: null })))).toMatchObject({ category: "not_found" });
  });
});

describe("handOffVoiceNote", () => {
  const TURN = "88888888-8888-4888-8888-888888888888";

  function deps(db: TenantDb, opened: "ok" | "busy" | "not_found" | "throw" = "ok") {
    const calls: { open: { text: string; conversationId: null }[]; run: string[] } = { open: [], run: [] };
    const d: VoiceDeps = {
      db,
      clock: () => T0,
      newId: () => TURN,
      open: async (_s, input) => {
        calls.open.push(input as never);
        if (opened === "throw") throw new Error("store down");
        if (opened !== "ok") return { refused: opened } as never;
        return { conversationId: "c-1", turnId: input.turnId } as never;
      },
      run: async (_s, _turn, text) => {
        calls.run.push(text);
        return "done";
      },
    };
    return { d, calls };
  }

  it("claims the note, opens one turn with the fixed sentence and links it", async () => {
    const db = fakeDb({ note: stepRow({ status: "ready" }) });
    const { d, calls } = deps(db);
    expect(await handOffVoiceNote(session, NOTE, d)).toEqual({
      ok: true,
      voiceNoteId: NOTE,
      status: "handed_off",
      conversationId: "c-1",
      turnId: TURN,
      turnStatus: "done",
    });
    expect(handOffText(NOTE)).toBe(`Handle voice note ${NOTE}`);
    expect(calls.open).toHaveLength(1);
    expect(calls.open[0]).toMatchObject({ text: handOffText(NOTE), conversationId: null });
    expect(calls.run).toEqual([handOffText(NOTE)]);
    expect(db.writes.map((w) => w.sql.slice(0, 60))).toEqual([
      expect.stringContaining("SET status = 'handed_off'"),
      expect.stringContaining("SET conversation_id"),
    ]);
    expect(db.writes[1].params.slice(0, 2)).toEqual([NOTE, "c-1"]);
  });

  it("starts no second turn when another press holds the claim", async () => {
    const { d, calls } = deps(fakeDb({ note: stepRow({ status: "ready" }), affected: { "SET status = 'handed_off'": 0 } }));
    expect(await handOffVoiceNote(session, NOTE, d)).toEqual({ ok: false, category: "busy", retryable: true });
    expect(calls.open).toHaveLength(0);
  });

  it("gives the claim back when the turn cannot open", async () => {
    for (const how of ["busy", "not_found"] as const) {
      const db = fakeDb({ note: stepRow({ status: "ready" }) });
      const { d } = deps(db, how);
      expect(await handOffVoiceNote(session, NOTE, d)).toMatchObject({ ok: false, category: how });
      expect(db.writes.at(-1)!.sql).toContain("SET status = 'ready'");
      expect(db.writes.at(-1)!.sql).toContain("conversation_id IS NULL");
    }
    const db = fakeDb({ note: stepRow({ status: "ready" }) });
    await expect(handOffVoiceNote(session, NOTE, deps(db, "throw").d)).rejects.toThrow("store down");
    expect(db.writes.at(-1)!.sql).toContain("SET status = 'ready'");
  });

  it("answers a note already handed over without a new turn, and refuses one not ready", async () => {
    const done = deps(fakeDb({ note: stepRow({ status: "replied", conversation_id: "c-9" }) }));
    expect(await handOffVoiceNote(session, NOTE, done.d)).toMatchObject({ ok: true, status: "replied", conversationId: "c-9", turnId: null });
    expect(done.calls.open).toHaveLength(0);
    const early = deps(fakeDb());
    expect(await handOffVoiceNote(session, NOTE, early.d)).toEqual({ ok: false, category: "not_ready", retryable: false });
  });

  it("needs the agent switch too", async () => {
    flags.agentEnabled = false;
    const { d, calls } = deps(fakeDb({ note: stepRow({ status: "ready" }) }));
    expect(await handOffVoiceNote(session, NOTE, d)).toMatchObject({ category: "agent_off" });
    expect(calls.open).toHaveLength(0);
  });
});

describe("the reply draft", () => {
  const proposal = (over: Record<string, unknown> = {}) => ({
    status: "proposed",
    amount_cents: 30_000,
    decision_note: null,
    advance_status: null,
    advance_amount: null,
    fee_cents: null,
    ...over,
  });
  const asked = { triage_category: "advance_request", amount_cents: null };

  it("says what the engine and the people decided, never what a model said", () => {
    expect(outcomeOf(asked, null)).toEqual({ kind: "need_amount" });
    expect(outcomeOf({ triage_category: "advance_request", amount_cents: 30_000 }, null)).toEqual({ kind: "received" });
    expect(outcomeOf({ triage_category: "pay_question", amount_cents: null }, null)).toEqual({ kind: "received" });
    expect(outcomeOf(asked, proposal())).toEqual({ kind: "proposed", amountCents: 30_000 });
    expect(outcomeOf(asked, proposal({ amount_cents: "30000" }))).toEqual({ kind: "proposed", amountCents: 30_000 });
    expect(outcomeOf(asked, proposal({ status: "approved" }))).toEqual({ kind: "approved", amountCents: 30_000 });
    expect(outcomeOf(asked, proposal({ status: "executing" }))).toEqual({ kind: "approved", amountCents: 30_000 });
    expect(outcomeOf(asked, proposal({ status: "rejected", decision_note: "over_limit" }))).toEqual({ kind: "rejected", note: "over_limit" });
    expect(outcomeOf(asked, proposal({ status: "expired", decision_note: "x" }))).toEqual({ kind: "rejected", note: "expired" });
    expect(outcomeOf(asked, proposal({ status: "done", advance_status: "paid", advance_amount: 30_000, fee_cents: 500 }))).toEqual({
      kind: "paid",
      amountCents: 30_000,
      feeCents: 500,
    });
    expect(outcomeOf(asked, proposal({ status: "done", advance_status: "pending" }))).toEqual({ kind: "approved", amountCents: 30_000 });
    expect(outcomeOf(asked, proposal({ amount_cents: 1.5 }))).toEqual({ kind: "received" });
    expect(outcomeOf(asked, proposal({ amount_cents: -100 }))).toEqual({ kind: "received" });
  });

  function deps(db: TenantDb, complete?: VoiceDeps["complete"]): VoiceDeps & { sent: number } {
    const d: VoiceDeps & { sent: number } = { db, clock: () => T0, sent: 0 };
    d.complete = async (target, request, s) => {
      d.sent += 1;
      if (!complete) throw new Error("no model in this test");
      return complete(target, request, s);
    };
    return d;
  }

  it("drafts the English sentence for an English note without a model call", async () => {
    const db = fakeDb({ note: stepRow({ status: "handed_off", language: "en" }), proposal: proposal() });
    const d = deps(db);
    const r = await draftVoiceReply(session, NOTE, d);
    expect(r).toMatchObject({ ok: true, status: "replied", replyLanguage: "en", outcome: "proposed" });
    expect(d.sent).toBe(0);
    expect(db.writes[0].params.slice(0, 3)).toEqual([NOTE, (r as { reply: string }).reply, null]);
    expect(db.reads.find((s) => s.includes("FROM proposals p"))).toContain("lower(p.args->>'requestRef') = $1");
  });

  it("keeps a Spanish translation only when every figure survived", async () => {
    const good = "Recibimos tu solicitud de adelanto de $300.00. Está esperando aprobación y te avisaremos cuando se pague.";
    const db = fakeDb({ note: stepRow({ status: "handed_off", language: "es" }), proposal: proposal() });
    const r = await draftVoiceReply(session, NOTE, deps(db, async () => aiAnswer(JSON.stringify({ reply: good }))));
    expect(r).toMatchObject({ ok: true, reply: good, replyLanguage: "es" });
    expect(db.writes[0].params[2]).toBe(CALL);

    const changed = fakeDb({ note: stepRow({ status: "handed_off", language: "es" }), proposal: proposal() });
    const bad = await draftVoiceReply(session, NOTE, deps(changed, async () => aiAnswer(JSON.stringify({ reply: good.replace("$300.00", "$3,000.00") }))));
    expect(bad).toMatchObject({ ok: true, replyLanguage: "en" });
    expect((bad as { reply: string }).reply).toContain("$300.00");
  });

  it("falls back to English when the translation call fails or the models are off", async () => {
    const failing = fakeDb({ note: stepRow({ status: "handed_off", language: "es" }) });
    const r = await draftVoiceReply(
      session,
      NOTE,
      deps(failing, async () => {
        throw new AiError("unavailable");
      }),
    );
    expect(r).toMatchObject({ ok: true, replyLanguage: "en", outcome: "received" });

    flags.aiEnabled = false;
    const off = fakeDb({ note: stepRow({ status: "handed_off", language: "es" }) });
    const d = deps(off, async () => aiAnswer("{}"));
    expect(await draftVoiceReply(session, NOTE, d)).toMatchObject({ ok: true, replyLanguage: "en" });
    expect(d.sent).toBe(0);
  });

  it("refuses a note the agent has not seen yet", async () => {
    expect(await draftVoiceReply(session, NOTE, deps(fakeDb({ note: stepRow({ status: "ready" }) })))).toEqual({
      ok: false,
      category: "not_ready",
      retryable: false,
    });
    expect(await draftVoiceReply(session, NOTE, deps(fakeDb({ note: null })))).toMatchObject({ category: "not_found" });
  });
});
