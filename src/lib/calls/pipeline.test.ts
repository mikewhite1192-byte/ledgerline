import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiErrorCategory, type AiResult, type TranscribeResult } from "../ai";
import type { ScreenOutcome } from "../agent/gateway/screen";
import { UNTRUSTED_WARNING } from "../agent/gateway/tools/read/get-inbound-message";
import type { CompleteFn } from "../agent/gateway/types";
import type { Param, Queryable, TenantDb } from "../db";
import type { HandOffResult } from "../voice/pipeline";
import { encodeWav } from "../voice/wav-encode";
import * as P from "./pipeline";
import { CALL_UPDATE_FORMAT, MAX_TURNS } from "./update";

// One call segment's steps with the database, the models, the screen and the hand-off faked: the
// order of the checks, what each step stores, what a re-send costs, what a failure leaves behind,
// and that a driver's words never reach the answer or the log. The fake database keeps the three
// call tables in memory and rolls a transaction back when it throws. No database, no network, no
// wall clock.

const saved = structuredClone(flags);
const T0 = Date.UTC(2026, 10, 2, 16, 0, 0);
// The hand-off runs inline only while a whole agent turn fits in the 27 second step budget.
const STEP_LEFT_FOR_TURN = 27_000 - saved.agentTurnLimits.wallClockMs;
const session = { sub: "sub-1", email: "staff@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const CALL = "22222222-2222-4222-8222-222222222222";
const DRIVER = "33333333-3333-4333-8333-333333333333";
const OTHER_DRIVER = "44444444-4444-4444-8444-444444444444";
const TRANSCRIBE_CALL = "55555555-5555-4555-8555-555555555555";
const UPDATE_CALL = "66666666-6666-4666-8666-666666666666";
const CONVERSATION = "77777777-7777-4777-8777-777777777777";
const TURN = "88888888-8888-4888-8888-888888888888";

// Synthetic words only. "How is the load" is said and never answered back.
const SAID = [
  { startMs: 0, endMs: 2_500, transcript: "Hi, this is dispatch. How is the load going?", turnId: "t-a" },
  { startMs: 3_000, endMs: 7_000, transcript: "Fine. Can I get a $300 advance for diesel?", turnId: "t-b" },
  { startMs: 7_500, endMs: 9_000, transcript: "Let me check your settlement." },
];

let logged: unknown[][] = [];
let now = { t: T0 };

beforeEach(() => {
  Object.assign(flags, structuredClone(saved));
  flags.phoneLineEnabled = true;
  flags.aiEnabled = true;
  flags.agentEnabled = true;
  flags.voiceIntakeEnabled = true;
  now = { t: T0 };
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
    expect(text).not.toContain("diesel");
    expect(text).not.toContain("upstream");
  }
  vi.restoreAllMocks();
});

// --- the fake database ---

type Seg = {
  id: string;
  seq: number;
  status: P.SegmentStatus;
  fail_category: string | null;
  attempts: number;
  input_id: string | null;
  transcript_call_id: string | null;
  offset_ms: number;
  duration_ms: number;
  update_call_id: string | null;
  updated_at: number;
};

type Turn = {
  turn_key: string;
  upstream_turn_id: string | null;
  start_ms: number;
  end_ms: number;
  text: string;
  update_kind: string | null;
  english_text: string | null;
  amount_cents: number | null;
  summary: string | null;
  voice_note_id: string | null;
  conversation_id: string | null;
};

type Note = {
  id: string;
  input_id: string;
  driver_id: string;
  trace_id: string;
  duration_ms: number;
  transcript_call_id: string | null;
  language: string;
  english_text: string;
  prepare_call_id: string | null;
  triage_category: string;
  amount_cents: number | null;
};

type State = {
  call: null | {
    id: string;
    driver_id: string;
    trace_id: string;
    status: "open" | "ended";
    segments: number;
    hand_offs: number;
    started_at: number;
    last_segment_at: number | null;
    ended_at: number | null;
  };
  segments: Seg[];
  turns: Record<string, Turn[]>;
  inputs: Record<string, string>;
  notes: Note[];
};

type FakeOptions = { callsToday?: number; driverCode?: string | null; foreignCall?: boolean };

function fakeDb(opts: FakeOptions = {}) {
  let state: State = { call: null, segments: [], turns: {}, inputs: {}, notes: [] };
  const statements: string[] = [];
  const at = (p: Param) => Date.parse(String(p));
  const seg = (id: Param) => {
    const s = state.segments.find((x) => x.id === id);
    if (!s) throw new Error("no such segment");
    return s;
  };
  const turnOf = (segmentId: Param, key: Param) => (state.turns[String(segmentId)] ?? []).find((t) => t.turn_key === key);
  const stale = (s: Seg, nowIso: Param, lease: Param) => s.updated_at <= at(nowIso) - Number(lease);

  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      statements.push(sql);
      const rows = (r: unknown[]) => r as T[];
      if (sql.includes("FROM memberships")) return rows([{ ok: 1 }]);
      if (sql.startsWith("SELECT timezone FROM tenants")) return rows([{ timezone: "America/Chicago" }]);
      if (sql.includes("FROM drivers")) {
        const code = opts.driverCode === undefined ? "DRV-7" : opts.driverCode;
        return rows(code !== null && (params[0] === DRIVER || params[0] === OTHER_DRIVER) ? [{ code }] : []);
      }
      if (sql === P.CALL_SQL) {
        const c = state.call;
        if (!c || c.id !== params[0]) return [];
        const t = at(params[1]);
        return rows([
          {
            id: c.id,
            driver_id: c.driver_id,
            trace_id: c.trace_id,
            status: c.status,
            segments: c.segments,
            hand_offs: c.hand_offs,
            age_ms: String(t - c.started_at),
            idle_ms: String(t - (c.last_segment_at ?? c.started_at)),
          },
        ]);
      }
      if (sql === P.CALLS_TODAY_SQL) return rows([{ n: opts.callsToday ?? 0 }]);
      if (sql === P.SEGMENT_SQL) {
        const s = state.call?.id === params[0] ? state.segments.find((x) => x.seq === params[1]) : undefined;
        return rows(s ? [{ ...s, stale: stale(s, params[2], params[3]) }] : []);
      }
      if (sql === P.TURNS_SQL || sql === P.LINE_TURNS_SQL) return rows((state.turns[String(params[0])] ?? []).map((t) => ({ ...t })));
      if (sql === P.INPUT_BODY_SQL) {
        const body = state.inputs[String(params[0])];
        return rows(body === undefined ? [] : [{ body_text: body }]);
      }
      if (sql === P.WAITING_SQL) {
        const s = state.call?.id === params[0] ? state.segments.find((x) => x.seq === params[1]) : undefined;
        if (!s) return [];
        const t = (state.turns[s.id] ?? []).find((x) => x.voice_note_id !== null);
        return rows([
          { id: s.id, status: s.status, turn_key: t?.turn_key ?? null, voice_note_id: t?.voice_note_id ?? null, conversation_id: t?.conversation_id ?? null },
        ]);
      }
      if (sql === P.CALL_STATUS_SQL) return rows(state.call?.id === params[0] ? [{ status: state.call.status }] : []);
      throw new Error(`unexpected read: ${sql.slice(0, 60)}`);
    },

    async execute(sql: string, params: Param[] = []): Promise<number> {
      statements.push(sql);
      const c = state.call;
      if (sql === P.INSERT_CALL_SQL) {
        if (opts.foreignCall || c) return 0;
        state.call = {
          id: String(params[0]),
          driver_id: String(params[1]),
          trace_id: String(params[2]),
          status: "open",
          segments: 0,
          hand_offs: 0,
          started_at: at(params[4]),
          last_segment_at: null,
          ended_at: null,
        };
        return 1;
      }
      if (sql === P.END_CALL_SQL) {
        if (!c || c.id !== params[0] || c.status !== "open") return 0;
        Object.assign(c, { status: "ended", ended_at: at(params[1]) });
        return 1;
      }
      if (sql === P.COUNT_SEGMENT_SQL) {
        if (!c) return 0;
        Object.assign(c, { segments: c.segments + 1, last_segment_at: at(params[1]) });
        return 1;
      }
      if (sql === P.COUNT_HAND_OFF_SQL) {
        if (!c || c.hand_offs >= Number(params[1])) return 0;
        c.hand_offs += 1;
        return 1;
      }
      if (sql === P.INSERT_SEGMENT_SQL) {
        if (state.segments.some((s) => s.seq === params[2])) return 0;
        state.segments.push({
          id: String(params[0]),
          seq: Number(params[2]),
          status: "received",
          fail_category: null,
          attempts: 1,
          input_id: null,
          transcript_call_id: null,
          offset_ms: Number(params[3]),
          duration_ms: Number(params[4]),
          update_call_id: null,
          updated_at: at(params[5]),
        });
        return 1;
      }
      if (sql === P.RECLAIM_SQL) {
        const s = seg(params[0]);
        const moving = s.status === "received" || s.status === "transcribed";
        if (s.attempts !== params[1] || s.attempts >= 3 || !(s.status === "failed" || (moving && stale(s, params[2], params[3])))) return 0;
        Object.assign(s, {
          status: s.input_id === null ? "received" : "transcribed",
          fail_category: null,
          attempts: s.attempts + 1,
          updated_at: at(params[2]),
        });
        return 1;
      }
      if (sql === P.GIVE_UP_SQL) {
        const s = seg(params[0]);
        if (s.attempts !== params[1] || !["received", "transcribed"].includes(s.status) || !stale(s, params[2], params[3])) return 0;
        Object.assign(s, { status: "failed", fail_category: "unavailable", updated_at: at(params[2]) });
        return 1;
      }
      if (sql === P.SET_FAILED_SQL) {
        const s = seg(params[0]);
        if (s.attempts !== params[1] || !["received", "transcribed"].includes(s.status)) return 0;
        Object.assign(s, { status: "failed", fail_category: String(params[2]), updated_at: at(params[3]) });
        return 1;
      }
      if (sql === P.SET_EMPTY_SQL) {
        const s = seg(params[0]);
        if (s.attempts !== params[1] || s.status !== "received") return 0;
        Object.assign(s, { status: "empty", transcript_call_id: params[2], updated_at: at(params[3]) });
        return 1;
      }
      if (sql === P.INSERT_INPUT_SQL) {
        state.inputs[String(params[0])] = String(params[2]);
        return 1;
      }
      if (sql === P.SET_TRANSCRIBED_SQL) {
        const s = seg(params[0]);
        if (s.attempts !== params[1] || s.status !== "received") return 0;
        Object.assign(s, { status: "transcribed", input_id: params[2], transcript_call_id: params[3], updated_at: at(params[4]) });
        return 1;
      }
      if (sql === P.INSERT_TURN_SQL) {
        const list = (state.turns[String(params[1])] ??= []);
        if (list.some((t) => t.turn_key === params[2])) return 0;
        list.push({
          turn_key: String(params[2]),
          upstream_turn_id: params[3] === null ? null : String(params[3]),
          start_ms: Number(params[4]),
          end_ms: Number(params[5]),
          text: String(params[6]),
          update_kind: null,
          english_text: null,
          amount_cents: null,
          summary: null,
          voice_note_id: null,
          conversation_id: null,
        });
        return 1;
      }
      if (sql === P.SET_BLOCKED_SQL) {
        const s = seg(params[0]);
        if (s.attempts !== params[1] || s.status !== "transcribed") return 0;
        Object.assign(s, { status: "blocked", updated_at: at(params[2]) });
        return 1;
      }
      if (sql === P.SET_TURN_UPDATE_SQL) {
        const t = turnOf(params[0], params[1]);
        if (!t) return 0;
        Object.assign(t, { update_kind: params[2], english_text: params[3], amount_cents: params[4], summary: params[5] });
        return 1;
      }
      if (sql === P.INSERT_NOTE_SQL) {
        if (state.notes.some((n) => n.input_id === params[2])) return 0;
        state.notes.push({
          id: String(params[0]),
          driver_id: String(params[1]),
          input_id: String(params[2]),
          trace_id: String(params[3]),
          duration_ms: Number(params[5]),
          transcript_call_id: params[6] === null ? null : String(params[6]),
          language: String(params[7]),
          english_text: String(params[8]),
          prepare_call_id: params[9] === null ? null : String(params[9]),
          triage_category: String(params[10]),
          amount_cents: params[11] === null ? null : Number(params[11]),
        });
        return 1;
      }
      if (sql === P.LINK_NOTE_SQL) {
        const t = turnOf(params[0], params[1]);
        if (!t) return 0;
        t.voice_note_id = String(params[2]);
        return 1;
      }
      if (sql === P.SET_DONE_SQL) {
        const s = seg(params[0]);
        if (s.attempts !== params[1] || s.status !== "transcribed") return 0;
        Object.assign(s, { status: "done", update_call_id: params[2], updated_at: at(params[3]) });
        return 1;
      }
      if (sql === P.LINK_CONVERSATION_SQL) {
        const t = turnOf(params[0], params[1]);
        if (!t || t.conversation_id !== null) return 0;
        t.conversation_id = String(params[2]);
        return 1;
      }
      throw new Error(`unexpected write: ${sql.slice(0, 60)}`);
    },
  };

  const db: TenantDb & { statements: string[]; state: () => State } = {
    statements,
    state: () => state,
    async withTenant<T>(_tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
      const before = structuredClone(state);
      try {
        return await fn(q);
      } catch (err) {
        state = before;
        throw err;
      }
    },
  };
  return db;
}

// --- the fakes around it ---

const heard = (over: Partial<TranscribeResult> = {}): TranscribeResult => ({
  callId: TRANSCRIBE_CALL,
  transcript: SAID.map((t) => t.transcript).join(" "),
  turns: SAID,
  audioDurationMs: 10_000,
  costNanocents: 1,
  ...over,
});

const aiAnswer = (text: string, over: Partial<AiResult> = {}): AiResult => ({
  callId: UPDATE_CALL,
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

type Kind = "advance_request" | "pay_question" | "dispute" | "promise" | "note" | "none";

// The model's answer for a segment of the three turns above, with the kinds given.
const updates = (seq: number, kinds: [Kind, Kind, Kind] = ["none", "advance_request", "promise"]) =>
  JSON.stringify({
    updates: [
      { turn: `${seq}:0`, kind: kinds[0], language: "en", english_text: "", amount_cents: null, summary: "Dispatch checks in." },
      { turn: `${seq}:1`, kind: kinds[1], language: "en", english_text: "", amount_cents: 30_000, summary: "Asks for $300 ahead of payday." },
      { turn: `${seq}:2`, kind: kinds[2], language: "en", english_text: "", amount_cents: null, summary: "Dispatch will look." },
    ],
  });

const screened = (decision: "allowed" | "blocked"): ScreenOutcome => ({
  verdict: {
    inputId: "99999999-9999-4999-8999-999999999999",
    verdict: decision === "blocked" ? "flagged" : "clean",
    categories: [],
    confidence: null,
    contentHash: "h",
    via: "model",
    modelCallId: null,
    screenerVersion: 1,
  } as ScreenOutcome["verdict"],
  decisionId: "aaaaaaaa-0000-4000-8000-000000000001",
  decision,
  reason: decision === "blocked" ? "screen_error" : "ok",
});

const tenSeconds = () => encodeWav(new Float32Array(16_000 * 10).fill(0.1));

const segment = (seq = 0, over: Partial<P.SegmentInput> = {}): P.SegmentInput => ({
  callId: CALL,
  seq,
  offsetMs: seq * 10_000,
  driverId: DRIVER,
  wav: tenSeconds(),
  ...over,
});

function harness(opts: FakeOptions = {}) {
  const db = fakeDb(opts);
  let n = 0;
  const newId = () => `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const transcribe = vi.fn<NonNullable<P.CallDeps["transcribe"]>>(async () => heard());
  const screen = vi.fn(async () => screened("allowed"));
  let seqForAnswer = 0;
  const complete = vi.fn<CompleteFn>(async () => aiAnswer(updates(seqForAnswer)));
  const handOff = vi.fn<NonNullable<P.CallDeps["handOff"]>>(
    async (_s, voiceNoteId): Promise<HandOffResult> => ({
      ok: true,
      voiceNoteId,
      status: "handed_off",
      conversationId: CONVERSATION,
      turnId: TURN,
      turnStatus: "done",
    }),
  );
  const deps: P.CallDeps = {
    db,
    clock: () => now.t,
    newId,
    transcribe,
    screen: screen as unknown as P.CallDeps["screen"],
    complete,
    handOff,
  };
  const send = (seq = 0, over: Partial<P.SegmentInput> = {}) => {
    seqForAnswer = seq;
    return P.receiveSegment(session, segment(seq, over), deps);
  };
  const modelCalls = () => transcribe.mock.calls.length + screen.mock.calls.length + complete.mock.calls.length;
  return { db, deps, transcribe, screen, complete, handOff, send, modelCalls };
}

const fail = (category: AiErrorCategory) => {
  throw new AiError(category);
};

describe("checkSegment", () => {
  it("passes a 16 kHz segment and measures it", () => {
    expect(P.checkSegment(segment())).toEqual({ durationMs: 10_000 });
  });

  it("checks the switches first, then the ids, the place, the size and the WAV", () => {
    const limits = flags.phoneLineLimits;
    flags.phoneLineEnabled = false;
    expect(P.checkSegment(segment())).toEqual({ ok: false, category: "disabled", retryable: false });
    flags.phoneLineEnabled = true;
    flags.aiEnabled = false;
    expect(P.checkSegment(segment())).toEqual({ ok: false, category: "ai_off", retryable: false });
    flags.aiEnabled = true;
    const bad = (over: Partial<P.SegmentInput>) => P.checkSegment(segment(0, over));
    expect(bad({ callId: "call-1" })).toMatchObject({ category: "bad_request" });
    expect(bad({ driverId: "DRV-7" })).toMatchObject({ category: "bad_request" });
    expect(bad({ seq: -1 })).toMatchObject({ category: "bad_request" });
    expect(bad({ seq: 1.5 })).toMatchObject({ category: "bad_request" });
    expect(bad({ seq: limits.maxSegmentsPerCall })).toMatchObject({ category: "bad_request" });
    expect(bad({ seq: limits.maxSegmentsPerCall - 1 })).toEqual({ durationMs: 10_000 });
    expect(bad({ offsetMs: limits.maxCallMs + 1 })).toMatchObject({ category: "bad_request" });
    expect(bad({ wav: new Uint8Array(limits.maxSegmentBytes + 1) })).toMatchObject({ category: "too_large" });
    expect(bad({ wav: new Uint8Array([1, 2, 3, 4]) })).toMatchObject({ category: "bad_request" });
    expect(bad({ wav: encodeWav(new Float32Array(24_000), 24_000) })).toMatchObject({ category: "bad_request" });
    expect(bad({ wav: encodeWav(new Float32Array(0)) })).toMatchObject({ category: "bad_request" });
    // Past the segment's length while under its size: refused for its length.
    const long = encodeWav(new Float32Array((16_000 * (limits.maxSegmentMs + 1)) / 1000));
    expect(long.byteLength).toBeLessThanOrEqual(limits.maxSegmentBytes);
    expect(bad({ wav: long })).toMatchObject({ category: "bad_request" });
  });

  it("refuses a bad segment before anything is reserved or any model is called", async () => {
    const h = harness();
    const long = encodeWav(new Float32Array((16_000 * (flags.phoneLineLimits.maxSegmentMs + 1)) / 1000));
    expect(await h.send(0, { wav: long })).toMatchObject({ ok: false, category: "bad_request" });
    expect(await h.send(0, { wav: new Uint8Array([9, 9, 9]) })).toMatchObject({ ok: false, category: "bad_request" });
    flags.phoneLineEnabled = false;
    expect(await h.send(0)).toEqual({ ok: false, category: "disabled", retryable: false });
    expect(h.db.statements).toEqual([]);
    expect(h.modelCalls()).toBe(0);
  });
});

describe("segmentKeywords", () => {
  it("listens for the pay words and the driver's code, within the wrapper's rules", () => {
    const words = P.segmentKeywords("DRV-7");
    expect(words).toContain("TONU");
    expect(words).toContain("adelanto");
    expect(words.at(-1)).toBe("DRV-7");
    expect(words.length).toBeLessThanOrEqual(20);
    expect(P.segmentKeywords(" DRV-7")).toEqual([...P.CALL_KEYWORDS]);
    expect(P.segmentKeywords("a\u0007b")).toEqual([...P.CALL_KEYWORDS]);
    expect(P.segmentKeywords(null)).toEqual([...P.CALL_KEYWORDS]);
  });
});

describe("buildTurns", () => {
  it("keeps the upstream turn id when it is there and places each turn in the call", () => {
    const turns = P.buildTurns(heard(), 4, 40_000, 10_000);
    expect(turns).toEqual([
      { turnKey: "4:0", upstreamTurnId: "t-a", startMs: 40_000, endMs: 42_500, text: SAID[0].transcript },
      { turnKey: "4:1", upstreamTurnId: "t-b", startMs: 43_000, endMs: 47_000, text: SAID[1].transcript },
      { turnKey: "4:2", upstreamTurnId: null, startMs: 47_500, endMs: 49_000, text: SAID[2].transcript },
    ]);
  });

  it("makes one turn spanning the segment from an answer with words but no turns, and none from silence", () => {
    expect(P.buildTurns(heard({ turns: [], transcript: "  Copy that.  " }), 2, 20_000, 8_000)).toEqual([
      { turnKey: "2:0", upstreamTurnId: null, startMs: 20_000, endMs: 28_000, text: "Copy that." },
    ]);
    expect(P.buildTurns(heard({ turns: [{ startMs: 0, endMs: 5, transcript: "  " }], transcript: " " }), 0, 0, 1_000)).toEqual([]);
  });

  it("drops empty turns, orders by start, clamps into the segment and folds past the turn limit", () => {
    const many = Array.from({ length: MAX_TURNS + 3 }, (_, i) => ({ startMs: i * 100, endMs: i * 100 + 50, transcript: `w${i}` }));
    const turns = P.buildTurns(
      heard({ turns: [{ startMs: 900, endMs: 99_999, transcript: "late" }, { startMs: -5, endMs: -1, transcript: "early" }, { startMs: 1, endMs: 2, transcript: "" }] }),
      0,
      0,
      1_000,
    );
    expect(turns.map((t) => [t.text, t.startMs, t.endMs])).toEqual([
      ["early", 0, 1],
      ["late", 900, 1_000],
    ]);
    const folded = P.buildTurns(heard({ turns: many }), 0, 0, 10_000);
    expect(folded).toHaveLength(MAX_TURNS);
    expect(folded.at(-1)).toMatchObject({ turnKey: `0:${MAX_TURNS - 1}`, text: `w${MAX_TURNS - 1} w${MAX_TURNS} w${MAX_TURNS + 1} w${MAX_TURNS + 2}` });
  });
});

describe("receiveSegment", () => {
  it("reserves the call and the segment, transcribes, screens, reads the updates and hands off the advance request", async () => {
    const h = harness();
    const result = await h.send(0);
    expect(result).toEqual({
      ok: true,
      callId: CALL,
      seq: 0,
      status: "done",
      turns: [
        { turnKey: "0:0", startMs: 0, endMs: 2_500, updateKind: "none", amountCents: null, summary: "Dispatch checks in.", voiceNoteId: null, conversationId: null },
        {
          turnKey: "0:1",
          startMs: 3_000,
          endMs: 7_000,
          updateKind: "advance_request",
          amountCents: 30_000,
          summary: "Asks for $300 ahead of payday.",
          voiceNoteId: expect.stringMatching(/^bbbbbbbb-/),
          conversationId: CONVERSATION,
        },
        { turnKey: "0:2", startMs: 7_500, endMs: 9_000, updateKind: "promise", amountCents: null, summary: "Dispatch will look.", voiceNoteId: null, conversationId: null },
      ],
    });
    // The answer carries no turn's words.
    expect(JSON.stringify(result)).not.toContain("How is the load");

    const [request] = h.transcribe.mock.calls[0];
    expect(request).toMatchObject({ mode: "ENDPOINTING", languageBias: ["English", "Spanish"], purpose: "call_segment_transcribe" });
    expect(request.keywords).toContain("DRV-7");
    expect(request.traceId).toBe(h.db.state().call?.trace_id);

    const [, ask] = h.complete.mock.calls[0];
    expect(ask).toMatchObject({ purpose: "call_segment_update", maxCostCents: flags.phoneLineLimits.maxUpdateCents, format: CALL_UPDATE_FORMAT });
    const text = String(ask.messages?.[1]?.content);
    expect(text.startsWith(UNTRUSTED_WARNING)).toBe(true);
    expect(text).toContain("[0:1 +3000ms] Fine. Can I get a $300 advance for diesel?");

    const state = h.db.state();
    expect(state.call).toMatchObject({ driver_id: DRIVER, status: "open", segments: 1, hand_offs: 1 });
    expect(state.segments[0]).toMatchObject({ status: "done", attempts: 1, transcript_call_id: TRANSCRIBE_CALL, update_call_id: UPDATE_CALL });
    expect(state.notes).toEqual([
      {
        id: result.ok ? result.turns[1].voiceNoteId : "",
        input_id: state.segments[0].input_id,
        driver_id: DRIVER,
        trace_id: state.call?.trace_id,
        duration_ms: 4_000,
        transcript_call_id: TRANSCRIBE_CALL,
        language: "en",
        english_text: SAID[1].transcript,
        prepare_call_id: UPDATE_CALL,
        triage_category: "advance_request",
        amount_cents: 30_000,
      },
    ]);
    // The voice note's own hand-off, with this request's database and clock.
    expect(h.handOff).toHaveBeenCalledTimes(1);
    expect(h.handOff.mock.calls[0][2]).toMatchObject({ db: h.db });
  });

  it("answers a re-sent segment from its row, with no model call and no second count", async () => {
    const h = harness();
    const first = await h.send(0);
    const calls = h.modelCalls();
    now.t += 60_000;
    expect(await h.send(0)).toEqual(first);
    expect(h.modelCalls()).toBe(calls);
    expect(h.handOff).toHaveBeenCalledTimes(1);
    expect(h.db.state().call?.segments).toBe(1);
    expect(h.db.state().notes).toHaveLength(1);
  });

  it("transcribes a segment again after a passing failure, and never past three tries", async () => {
    const h = harness();
    h.transcribe.mockImplementation(async () => fail("timeout"));
    expect(await h.send(0)).toEqual({ ok: false, category: "timeout", retryable: true });
    expect(h.db.state().segments[0]).toMatchObject({ status: "failed", fail_category: "timeout", attempts: 1 });
    expect(await h.send(0)).toEqual({ ok: false, category: "timeout", retryable: true });
    expect(await h.send(0)).toEqual({ ok: false, category: "timeout", retryable: false });
    expect(await h.send(0)).toEqual({ ok: false, category: "timeout", retryable: false });
    expect(h.transcribe).toHaveBeenCalledTimes(3);
    expect(h.db.state().segments[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("finishes a re-sent segment once the failure has passed, counting the segment once", async () => {
    const h = harness();
    h.transcribe.mockImplementationOnce(async () => fail("rate_limited"));
    expect(await h.send(0)).toEqual({ ok: false, category: "rate_limited", retryable: true });
    expect(await h.send(0)).toMatchObject({ ok: true, status: "done" });
    expect(h.transcribe).toHaveBeenCalledTimes(2);
    expect(h.db.state().segments[0]).toMatchObject({ status: "done", attempts: 2 });
    expect(h.db.state().call?.segments).toBe(1);
  });

  it("keeps an unknown outcome open for a re-send, never done or empty", async () => {
    const h = harness();
    h.transcribe.mockImplementationOnce(async () => fail("unknown"));
    expect(await h.send(0)).toEqual({ ok: false, category: "unknown", retryable: true });
    expect(h.db.state().segments[0].status).toBe("failed");
    expect(await h.send(0)).toMatchObject({ ok: true, status: "done" });
  });

  it("answers a final failure with its category and never tries it again", async () => {
    const h = harness();
    h.transcribe.mockImplementation(async () => fail("bad_request"));
    expect(await h.send(0)).toEqual({ ok: false, category: "bad_request", retryable: false });
    expect(await h.send(0)).toEqual({ ok: false, category: "bad_request", retryable: false });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
  });

  it("stores a silent segment as empty and makes no screen or Spark call", async () => {
    const h = harness();
    h.transcribe.mockResolvedValue(heard({ transcript: "   ", turns: [] }));
    expect(await h.send(0)).toEqual({ ok: true, callId: CALL, seq: 0, status: "empty", turns: [] });
    expect(h.screen).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.db.state().inputs).toEqual({});
  });

  it("stops a segment the screen blocks before any Spark call and any hand-off", async () => {
    const h = harness();
    h.screen.mockResolvedValue(screened("blocked"));
    const result = await h.send(0);
    expect(result).toMatchObject({ ok: true, status: "blocked" });
    expect(result.ok && result.turns.map((t) => t.updateKind)).toEqual([null, null, null]);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.handOff).not.toHaveBeenCalled();
    expect(h.db.state().notes).toEqual([]);
    // Blocked is final: a re-send runs nothing.
    expect(await h.send(0)).toMatchObject({ ok: true, status: "blocked" });
    expect(h.screen).toHaveBeenCalledTimes(1);
  });

  it("stores an answer the parser refuses as bad_answer, never as an empty list of updates", async () => {
    const h = harness();
    h.complete.mockResolvedValue(aiAnswer("The driver wants money."));
    expect(await h.send(0)).toEqual({ ok: false, category: "bad_answer", retryable: false });
    expect(h.db.state().segments[0]).toMatchObject({ status: "failed", fail_category: "bad_answer" });
    expect(h.db.state().turns[h.db.state().segments[0].id].every((t) => t.update_kind === null)).toBe(true);
    expect(h.db.state().notes).toEqual([]);
    h.complete.mockResolvedValue(aiAnswer(updates(0), { status: "incomplete" }));
    expect(await h.send(0)).toEqual({ ok: false, category: "bad_answer", retryable: false });
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("resumes a segment that failed after its transcript was stored without transcribing it again", async () => {
    const h = harness();
    h.complete.mockImplementationOnce(async () => fail("unavailable"));
    expect(await h.send(0)).toEqual({ ok: false, category: "unavailable", retryable: true });
    expect(h.db.state().segments[0]).toMatchObject({ status: "failed", input_id: expect.any(String) });
    expect(await h.send(0)).toMatchObject({ ok: true, status: "done" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.db.state().segments[0].attempts).toBe(2);
  });

  it("hands off only the first advance request or pay question in a segment", async () => {
    const h = harness();
    h.complete.mockResolvedValue(aiAnswer(updates(0, ["pay_question", "advance_request", "none"])));
    const result = await h.send(0);
    expect(result.ok && result.turns.map((t) => t.voiceNoteId !== null)).toEqual([true, false, false]);
    expect(h.db.state().notes).toEqual([expect.objectContaining({ triage_category: "pay_question", amount_cents: null })]);
  });

  it("records a fourth action turn in a call but hands off only three", async () => {
    const h = harness();
    expect(flags.phoneLineLimits.maxHandOffsPerCall).toBe(3);
    for (let seq = 0; seq < 4; seq += 1) {
      h.complete.mockResolvedValueOnce(aiAnswer(updates(seq)));
      const result = await h.send(seq);
      expect(result).toMatchObject({ ok: true, status: "done" });
      const turn = result.ok ? result.turns[1] : null;
      expect(turn?.updateKind).toBe("advance_request");
      expect(turn?.voiceNoteId !== null).toBe(seq < 3);
      now.t += 10_000;
    }
    expect(h.handOff).toHaveBeenCalledTimes(3);
    expect(h.db.state().notes).toHaveLength(3);
    expect(h.db.state().call).toMatchObject({ segments: 4, hand_offs: 3 });
  });

  it("leaves the hand-off for its route when a whole agent turn no longer fits in the request", async () => {
    const h = harness();
    h.complete.mockImplementation(async () => {
      now.t += STEP_LEFT_FOR_TURN + 1;
      return aiAnswer(updates(0));
    });
    const result = await h.send(0);
    expect(result.ok && result.turns[1]).toMatchObject({ voiceNoteId: expect.any(String), conversationId: null });
    expect(h.handOff).not.toHaveBeenCalled();

    const finished = await P.finishHandOff(session, CALL, 0, h.deps);
    expect(finished.ok && finished.turns[1].conversationId).toBe(CONVERSATION);
    expect(h.handOff).toHaveBeenCalledTimes(1);
    // A second press answers with the same conversation and runs nothing.
    expect(await P.finishHandOff(session, CALL, 0, h.deps)).toEqual(finished);
    expect(h.handOff).toHaveBeenCalledTimes(1);
  });

  it("keeps a segment done when the hand-off is refused or fails, for the hand-off route to finish", async () => {
    const h = harness();
    h.handOff.mockResolvedValueOnce({ ok: false, category: "agent_off", retryable: false });
    expect(await h.send(0)).toMatchObject({ ok: true, status: "done" });
    h.handOff.mockRejectedValueOnce(new Error("upstream text"));
    expect(await P.finishHandOff(session, CALL, 0, h.deps)).toEqual({ ok: false, category: "unavailable", retryable: true });
    expect(await P.finishHandOff(session, CALL, 0, h.deps)).toMatchObject({ ok: true, status: "done" });
    expect(h.db.state().notes).toHaveLength(1);
  });

  it("refuses a segment of an ended call, of a call quiet past the idle limit and past the call's length", async () => {
    const h = harness();
    await h.send(0);
    expect(await P.endCall(session, CALL, h.deps)).toEqual({ ok: true, callId: CALL, status: "ended" });
    expect(await h.send(1)).toEqual({ ok: false, category: "not_open", retryable: false });

    const idle = harness();
    await idle.send(0);
    now.t += flags.phoneLineLimits.idleEndMs + 1;
    expect(await idle.send(1)).toEqual({ ok: false, category: "not_open", retryable: false });
    expect(idle.db.state().call).toMatchObject({ status: "ended" });

    now.t = T0;
    flags.phoneLineLimits = { ...flags.phoneLineLimits, maxCallMs: 60_000 };
    const long = harness();
    await long.send(0);
    now.t += 60_001;
    expect(await long.send(1)).toEqual({ ok: false, category: "limit", retryable: false });
    expect(long.transcribe).toHaveBeenCalledTimes(1);
  });

  it("refuses the day's 21st call, an unknown driver, another carrier's call id and a second driver before any reservation", async () => {
    const full = harness({ callsToday: flags.phoneLineLimits.callsPerDay });
    expect(await full.send(0)).toEqual({ ok: false, category: "limit", retryable: false });
    expect(full.db.state().call).toBeNull();

    const nobody = harness({ driverCode: null });
    expect(await nobody.send(0)).toEqual({ ok: false, category: "not_found", retryable: false });

    const taken = harness({ foreignCall: true });
    expect(await taken.send(0)).toEqual({ ok: false, category: "conflict", retryable: false });

    const h = harness();
    await h.send(0);
    expect(await h.send(1, { driverId: OTHER_DRIVER })).toEqual({ ok: false, category: "bad_request", retryable: false });
    for (const x of [full, nobody, taken]) expect(x.modelCalls()).toBe(0);
    expect(h.db.state().segments).toHaveLength(1);
  });

  it("turns a thrown wrapper error into its category, and lets any other error through with nothing stored as done", async () => {
    const h = harness();
    h.complete.mockImplementationOnce(async () => {
      throw new AiError("rate_limited", 429);
    });
    const refusedAnswer = await h.send(0);
    expect(refusedAnswer).toEqual({ ok: false, category: "rate_limited", retryable: true });
    expect(JSON.stringify(refusedAnswer)).not.toContain("429");

    const crash = harness();
    crash.transcribe.mockRejectedValue(new Error("upstream body: the driver said diesel"));
    await expect(crash.send(0)).rejects.toThrow();
    expect(crash.db.state().segments[0]).toMatchObject({ status: "received", fail_category: null, attempts: 1 });
  });

  it("takes over a crashed try after the lease, and gives it up on its last try", async () => {
    const h = harness();
    h.transcribe.mockRejectedValue(new Error("crash"));
    await expect(h.send(0)).rejects.toThrow();
    // Still inside the lease: another request may be working on it.
    expect(await h.send(0)).toEqual({ ok: false, category: "busy", retryable: true });
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      now.t += P.SEGMENT_LEASE_MS;
      await expect(h.send(0)).rejects.toThrow();
      expect(h.db.state().segments[0].attempts).toBe(attempt);
    }
    now.t += P.SEGMENT_LEASE_MS;
    expect(await h.send(0)).toEqual({ ok: false, category: "unavailable", retryable: false });
    expect(await h.send(0)).toEqual({ ok: false, category: "unavailable", retryable: false });
    expect(h.transcribe).toHaveBeenCalledTimes(3);
  });

  it("stops before a Spark call it has no time left for", async () => {
    const h = harness();
    h.screen.mockImplementation(async () => {
      now.t += 27_000;
      return screened("allowed");
    });
    expect(await h.send(0)).toEqual({ ok: false, category: "out_of_time", retryable: true });
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe("finishHandOff and endCall", () => {
  it("check the switch first and their ids", async () => {
    const h = harness();
    flags.phoneLineEnabled = false;
    expect(await P.finishHandOff(session, CALL, 0, h.deps)).toEqual({ ok: false, category: "disabled", retryable: false });
    expect(await P.endCall(session, CALL, h.deps)).toEqual({ ok: false, category: "disabled", retryable: false });
    flags.phoneLineEnabled = true;
    expect(await P.finishHandOff(session, "call", 0, h.deps)).toMatchObject({ category: "bad_request" });
    expect(await P.finishHandOff(session, CALL, -1, h.deps)).toMatchObject({ category: "bad_request" });
    expect(await P.endCall(session, "call", h.deps)).toMatchObject({ category: "bad_request" });
    expect(h.db.statements).toEqual([]);
  });

  it("answer not_found for a call or a hand-off that does not exist", async () => {
    const h = harness();
    expect(await P.endCall(session, CALL, h.deps)).toEqual({ ok: false, category: "not_found", retryable: false });
    expect(await P.finishHandOff(session, CALL, 0, h.deps)).toEqual({ ok: false, category: "not_found", retryable: false });
    h.complete.mockResolvedValue(aiAnswer(updates(0, ["none", "note", "none"])));
    await h.send(0);
    expect(await P.finishHandOff(session, CALL, 0, h.deps)).toEqual({ ok: false, category: "not_found", retryable: false });
  });

  it("end a call once, and answer the same for a call already ended", async () => {
    const h = harness();
    await h.send(0);
    now.t += 1_000;
    expect(await P.endCall(session, CALL, h.deps)).toEqual({ ok: true, callId: CALL, status: "ended" });
    const endedAt = h.db.state().call?.ended_at;
    now.t += 1_000;
    expect(await P.endCall(session, CALL.toUpperCase(), h.deps)).toEqual({ ok: true, callId: CALL, status: "ended" });
    expect(h.db.state().call?.ended_at).toBe(endedAt);
  });
});
