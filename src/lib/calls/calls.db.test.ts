import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { AiResult, TranscribeResult } from "../ai";
import type { ScreenOutcome } from "../agent/gateway/screen";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { NOTES_TODAY_SQL, type VoiceDeps } from "../voice/pipeline";
import { encodeWav } from "../voice/wav-encode";
import {
  CALLS_TODAY_SQL,
  endCall,
  finishHandOff,
  INSERT_CALL_SQL,
  INSERT_SEGMENT_SQL,
  receiveSegment,
  SEGMENT_LEASE_MS,
  type CallDeps,
  type SegmentInput,
} from "./pipeline";

// The phone line against a real database, as the app's own role, with the models, the screen and
// the agent's turn faked: a segment goes from audio to a handed-off advance request through the
// voice note's own hand-off; a re-sent segment reads its row; a crashed try is taken over after
// the lease; one place holds one segment and one transcript one note; the call count follows the
// carrier's own day and the voice notes' count leaves call notes out; the app role cannot delete
// or move a row; the checks hold; another carrier sees nothing; deleting a driver takes its calls
// along. Fixed instants only. Every tenant made here is removed after each test.

const saved = structuredClone(flags);
// 10:00 in Chicago on Monday Nov 2, 2026.
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const iso = (t: number) => new Date(t).toISOString();

// Synthetic words only.
const SAID = [
  { startMs: 0, endMs: 2_500, transcript: "Hi, this is dispatch. How is the load going?", turnId: "t-a" },
  { startMs: 3_000, endMs: 7_000, transcript: "Fine. Can I get a $300 advance for diesel?" },
];

let admin: Db;
let app: Db;
let A: Fixture | undefined;
let B: Fixture | undefined;

const answer = (text: string): AiResult => ({
  callId: randomUUID(),
  status: "ok",
  text,
  toolCalls: [],
  usage: {} as AiResult["usage"],
  costNanocents: 1,
  upstreamId: null,
  replay: [],
  toolSearches: 0,
});

const updates = (seq: number) =>
  JSON.stringify({
    updates: [
      { turn: `${seq}:0`, kind: "none", language: "en", english_text: "", amount_cents: null, summary: "Dispatch checks in." },
      { turn: `${seq}:1`, kind: "advance_request", language: "en", english_text: "", amount_cents: 30_000, summary: "Asks for $300." },
    ],
  });

const allowed = (inputId: string): ScreenOutcome =>
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

type Counted = CallDeps & { calls: { transcribe: number; complete: number; open: number }; at: { t: number } };

// The faked steps around the real database. The agent's turn opens in a real conversation, so
// the voice note's link to it holds.
function deps(conversationId: string | null, over: Partial<CallDeps> = {}): Counted {
  const calls = { transcribe: 0, complete: 0, open: 0 };
  const at = { t: NOW };
  const voice: VoiceDeps = {
    newId: () => randomUUID(),
    open: async (_s, input) => {
      calls.open += 1;
      if (conversationId === null) throw new Error("no conversation for this test");
      return { conversationId, turnId: input.turnId } as never;
    },
    run: async () => "done",
  };
  return {
    calls,
    at,
    db: app,
    clock: () => at.t,
    newId: () => randomUUID(),
    transcribe: async (): Promise<TranscribeResult> => {
      calls.transcribe += 1;
      return { callId: randomUUID(), transcript: SAID.map((t) => t.transcript).join(" "), turns: SAID, audioDurationMs: 10_000, costNanocents: 1 };
    },
    screen: async (_ctx, inputId) => allowed(inputId),
    complete: async (_model, request) => {
      calls.complete += 1;
      const text = String(request.messages?.[1]?.content ?? "");
      const place = /\[(\d+):0 /.exec(text);
      return answer(updates(place ? Number(place[1]) : 0));
    },
    voice,
    ...over,
  };
}

const wav = () => encodeWav(new Float32Array(16_000 * 10).fill(0.1));

const segment = (f: Fixture, callId: string, seq = 0, over: Partial<SegmentInput> = {}): SegmentInput => ({
  callId,
  seq,
  offsetMs: seq * 10_000,
  driverId: f.driverId,
  wav: wav(),
  ...over,
});

async function addConversation(f: Fixture): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute("INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)", [
      id,
      f.session.sub,
    ]),
  );
  return id;
}

const asAdmin = <T>(f: Fixture, sql: string, params: Param[] = []) => admin.withTenant(f.tenantId, (q) => q.query<T>(sql, params));
const asApp = (f: Fixture, sql: string, params: Param[] = []) => app.withTenant(f.tenantId, (q) => q.execute(sql, params));

// A call, a segment and a turn written by the admin login, so every column can be set directly.
async function addCall(f: Fixture, driverId: string, startedAt = NOW) {
  const callId = randomUUID();
  const segmentId = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      "INSERT INTO calls (id, tenant_id, driver_id, trace_id, created_by, status, started_at)" +
        " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, 'open', CAST($5 AS timestamptz))",
      [callId, driverId, randomUUID(), f.session.sub, iso(startedAt)],
    );
    await q.execute(
      "INSERT INTO call_segments (id, tenant_id, call_id, seq, status, offset_ms, duration_ms)" +
        " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 0, 'empty', 0, 1000)",
      [segmentId, callId],
    );
    await q.execute(
      "INSERT INTO call_turns (id, tenant_id, segment_id, turn_key, start_ms, end_ms, text)" +
        " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), '0:0', 0, 500, 'Copy that.')",
      [randomUUID(), segmentId],
    );
  });
  return { callId, segmentId };
}

describe("phone line (database)", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    flags.phoneLineEnabled = true;
    flags.voiceIntakeEnabled = true;
    flags.aiEnabled = true;
    flags.agentEnabled = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tag = randomBytes(4).toString("hex");
    A = await makeTenant(admin, `call-a-${tag}`);
    B = await makeTenant(admin, `call-b-${tag}`);
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    vi.restoreAllMocks();
    try {
      for (const f of [A, B]) await dropTenant(admin, f);
    } finally {
      A = undefined;
      B = undefined;
    }
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("takes a segment from audio to a handed-off advance request, and answers a re-send from its row", async () => {
    const f = A!;
    const conversationId = await addConversation(f);
    const d = deps(conversationId);
    const callId = randomUUID();

    const first = await receiveSegment(f.session, segment(f, callId), d);
    expect(first).toMatchObject({ ok: true, callId, seq: 0, status: "done" });
    const turns = first.ok ? first.turns : [];
    expect(turns.map((t) => [t.turnKey, t.startMs, t.updateKind, t.amountCents])).toEqual([
      ["0:0", 0, "none", null],
      ["0:1", 3_000, "advance_request", 30_000],
    ]);
    expect(turns[1].conversationId).toBe(conversationId);
    expect(d.calls).toEqual({ transcribe: 1, complete: 1, open: 1 });

    const [call] = await asAdmin<Record<string, unknown>>(
      f,
      "SELECT status, segments, hand_offs, CAST(driver_id AS text) AS driver_id FROM calls WHERE id = CAST($1 AS uuid)",
      [callId],
    );
    expect(call).toEqual({ status: "open", segments: 1, hand_offs: 1, driver_id: f.driverId });
    const [seg] = await asAdmin<Record<string, unknown>>(
      f,
      "SELECT status, attempts, CAST(input_id AS text) AS input_id FROM call_segments WHERE call_id = CAST($1 AS uuid)",
      [callId],
    );
    expect(seg).toMatchObject({ status: "done", attempts: 1 });
    const [note] = await asAdmin<Record<string, unknown>>(
      f,
      "SELECT CAST(id AS text) AS id, status, CAST(input_id AS text) AS input_id, CAST(conversation_id AS text) AS conversation_id," +
        " triage_category, amount_cents, english_text, language FROM voice_notes",
    );
    expect(note).toEqual({
      id: turns[1].voiceNoteId,
      status: "handed_off",
      input_id: seg.input_id,
      conversation_id: conversationId,
      triage_category: "advance_request",
      amount_cents: 30_000,
      english_text: SAID[1].transcript,
      language: "en",
    });

    // The same segment again: its stored answer, no model call, no second count or note.
    d.at.t = NOW + 60_000;
    expect(await receiveSegment(f.session, segment(f, callId), d)).toEqual(first);
    expect(d.calls).toEqual({ transcribe: 1, complete: 1, open: 1 });
    const [again] = await asAdmin<{ segments: number; notes: number }>(
      f,
      "SELECT (SELECT segments FROM calls) AS segments, CAST((SELECT count(*) FROM voice_notes) AS integer) AS notes",
    );
    expect(again).toEqual({ segments: 1, notes: 1 });

    // The voice notes' daily count leaves the call's note out (owner decision 3); the calls' own
    // count has the call.
    const counts = await app.withTenant(f.tenantId, async (q) => ({
      notes: (await q.query<{ n: number }>(NOTES_TODAY_SQL, [iso(NOW)]))[0].n,
      calls: (await q.query<{ n: number }>(CALLS_TODAY_SQL, [iso(NOW)]))[0].n,
    }));
    expect(counts).toEqual({ notes: 0, calls: 1 });

    expect(await endCall(f.session, callId, d)).toEqual({ ok: true, callId, status: "ended" });
    expect(await receiveSegment(f.session, segment(f, callId, 1), d)).toEqual({ ok: false, category: "not_open", retryable: false });
  });

  it("leaves a hand-off with no time left for its route, which finishes it once", async () => {
    const f = A!;
    const conversationId = await addConversation(f);
    const d = deps(conversationId);
    const complete = d.complete!;
    d.complete = async (model, request, session) => {
      d.at.t += 6_000;
      return complete(model, request, session);
    };
    const callId = randomUUID();
    const first = await receiveSegment(f.session, segment(f, callId), d);
    expect(first.ok && first.turns[1]).toMatchObject({ voiceNoteId: expect.any(String), conversationId: null });
    expect(d.calls.open).toBe(0);
    const [waiting] = await asAdmin<{ status: string }>(f, "SELECT status FROM voice_notes");
    expect(waiting.status).toBe("ready");

    const finished = await finishHandOff(f.session, callId, 0, d);
    expect(finished.ok && finished.turns[1].conversationId).toBe(conversationId);
    expect(await finishHandOff(f.session, callId, 0, d)).toEqual(finished);
    expect(d.calls.open).toBe(1);
  });

  it("takes over a crashed try after the lease and stops after the third", async () => {
    const f = A!;
    const d = deps(null, {
      transcribe: async () => {
        throw new Error("crash");
      },
    });
    const callId = randomUUID();
    await expect(receiveSegment(f.session, segment(f, callId), d)).rejects.toThrow("crash");
    expect(await receiveSegment(f.session, segment(f, callId), d)).toEqual({ ok: false, category: "busy", retryable: true });
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      d.at.t += SEGMENT_LEASE_MS;
      await expect(receiveSegment(f.session, segment(f, callId), d)).rejects.toThrow("crash");
      const [row] = await asAdmin<{ attempts: number }>(f, "SELECT attempts FROM call_segments");
      expect(row.attempts).toBe(attempt);
    }
    d.at.t += SEGMENT_LEASE_MS;
    expect(await receiveSegment(f.session, segment(f, callId), d)).toEqual({ ok: false, category: "unavailable", retryable: false });
    const [row] = await asAdmin<Record<string, unknown>>(f, "SELECT status, fail_category, attempts FROM call_segments");
    expect(row).toEqual({ status: "failed", fail_category: "unavailable", attempts: 3 });
  });

  it("holds one segment per place in a call and one voice note per transcript", async () => {
    const f = A!;
    const d = deps(await addConversation(f));
    const callId = randomUUID();
    await receiveSegment(f.session, segment(f, callId), d);
    const [seg] = await asAdmin<{ input_id: string }>(f, "SELECT CAST(input_id AS text) AS input_id FROM call_segments");

    // The pipeline's own insert does nothing for a taken place; a plain one is refused.
    expect(await asApp(f, INSERT_SEGMENT_SQL, [randomUUID(), callId, 0, 0, 1_000, iso(NOW)])).toBe(0);
    expect(
      await sqlStateOf(
        asApp(
          f,
          "INSERT INTO call_segments (id, tenant_id, call_id, seq, status, offset_ms, duration_ms)" +
            " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 0, 'received', 0, 1000)",
          [randomUUID(), callId],
        ),
      ),
    ).toBe("23505");
    expect(
      await sqlStateOf(
        asApp(
          f,
          "INSERT INTO voice_notes (id, tenant_id, driver_id, input_id, trace_id, created_by, status)" +
            " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5, 'transcribed')",
          [randomUUID(), f.driverId, seg.input_id, randomUUID(), f.session.sub],
        ),
      ),
    ).toBe("23505");
  });

  it("keeps another carrier out of a call, its segments and its turns", async () => {
    const [a, b] = [A!, B!];
    const d = deps(await addConversation(a));
    const callId = randomUUID();
    await receiveSegment(a.session, segment(a, callId), d);
    const [seg] = await asAdmin<{ id: string }>(a, "SELECT CAST(id AS text) AS id FROM call_segments");

    const seen = await app.withTenant(b.tenantId, async (q) => ({
      calls: await q.query("SELECT id FROM calls"),
      segments: await q.query("SELECT id FROM call_segments"),
      turns: await q.query("SELECT id FROM call_turns"),
    }));
    expect(seen).toEqual({ calls: [], segments: [], turns: [] });

    // The other carrier's segment for this call names a call it does not have; its call under the
    // same id is never stored, and the pipeline answers conflict.
    expect(await sqlStateOf(asApp(b, INSERT_SEGMENT_SQL, [randomUUID(), callId, 1, 0, 1_000, iso(NOW)]))).toBe("23503");
    expect(
      await sqlStateOf(
        asApp(
          b,
          "INSERT INTO call_turns (id, tenant_id, segment_id, turn_key, start_ms, end_ms, text)" +
            " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), '0:9', 0, 5, 'x')",
          [randomUUID(), seg.id],
        ),
      ),
    ).toBe("23503");
    expect(await asApp(b, INSERT_CALL_SQL, [callId, b.driverId, randomUUID(), b.session.sub, iso(NOW)])).toBe(0);
    const other = deps(null);
    expect(await receiveSegment(b.session, segment(b, callId), other)).toEqual({ ok: false, category: "conflict", retryable: false });
    expect(other.calls.transcribe).toBe(0);
    expect(await endCall(b.session, callId, other)).toEqual({ ok: false, category: "not_found", retryable: false });
  });

  it("lets the app role neither delete a row nor move a fixed column", async () => {
    const f = A!;
    const { callId, segmentId } = await addCall(f, f.driverId);
    for (const sql of [
      "DELETE FROM call_turns",
      "DELETE FROM call_segments",
      "DELETE FROM calls",
      "UPDATE call_turns SET segment_id = segment_id",
      "UPDATE call_turns SET text = 'changed'",
      "UPDATE call_turns SET turn_key = '0:1'",
      "UPDATE call_segments SET call_id = call_id",
      "UPDATE call_segments SET seq = 5",
      "UPDATE calls SET driver_id = driver_id",
      "UPDATE calls SET trace_id = trace_id",
    ]) {
      expect([sql, await sqlStateOf(asApp(f, sql))]).toEqual([sql, "42501"]);
    }
    // The moving columns do move.
    expect(await asApp(f, "UPDATE call_turns SET summary = 'Ok.' WHERE segment_id = CAST($1 AS uuid)", [segmentId])).toBe(1);
    expect(await asApp(f, "UPDATE calls SET hand_offs = 1 WHERE id = CAST($1 AS uuid)", [callId])).toBe(1);
  });

  it("holds the checks on a call, a segment and a turn", async () => {
    const f = A!;
    const { callId, segmentId } = await addCall(f, f.driverId);
    const tryAdmin = (sql: string, params: Param[] = []) => sqlStateOf(admin.withTenant(f.tenantId, (q) => q.execute(sql, params)));
    const one = [callId];
    expect(await tryAdmin("UPDATE calls SET status = 'ended' WHERE id = CAST($1 AS uuid)", one)).toBe("23514");
    expect(await tryAdmin("UPDATE calls SET status = 'gone', ended_at = now() WHERE id = CAST($1 AS uuid)", one)).toBe("23514");
    const seg = [segmentId];
    expect(await tryAdmin("UPDATE call_segments SET status = 'failed' WHERE id = CAST($1 AS uuid)", seg)).toBe("23514");
    expect(await tryAdmin("UPDATE call_segments SET fail_category = 'timeout' WHERE id = CAST($1 AS uuid)", seg)).toBe("23514");
    expect(await tryAdmin("UPDATE call_segments SET status = 'failed', fail_category = 'Raw text' WHERE id = CAST($1 AS uuid)", seg)).toBe(
      "23514",
    );
    expect(await tryAdmin("UPDATE call_segments SET attempts = 4 WHERE id = CAST($1 AS uuid)", seg)).toBe("23514");
    expect(await tryAdmin("UPDATE call_segments SET duration_ms = 30001 WHERE id = CAST($1 AS uuid)", seg)).toBe("23514");
    expect(await tryAdmin("UPDATE call_turns SET end_ms = start_ms WHERE segment_id = CAST($1 AS uuid)", seg)).toBe("23514");
    expect(await tryAdmin("UPDATE call_turns SET turn_key = 'a:b' WHERE segment_id = CAST($1 AS uuid)", seg)).toBe("23514");
    expect(await tryAdmin("UPDATE call_turns SET text = '' WHERE segment_id = CAST($1 AS uuid)", seg)).toBe("23514");
    expect(await tryAdmin("UPDATE call_turns SET update_kind = 'payout' WHERE segment_id = CAST($1 AS uuid)", seg)).toBe("23514");
    expect(await tryAdmin("UPDATE call_turns SET amount_cents = 0 WHERE segment_id = CAST($1 AS uuid)", seg)).toBe("23514");
    expect(await tryAdmin("UPDATE call_segments SET status = 'failed', fail_category = 'timeout' WHERE id = CAST($1 AS uuid)", seg)).toBe(
      "no error",
    );
  });

  it("counts the calls in the carrier's own day", async () => {
    const f = A!;
    // 23:30 on Nov 1 and 00:30 on Nov 2 in Chicago (UTC-6 after Nov 1's change).
    await addCall(f, f.driverId, Date.UTC(2026, 10, 2, 5, 30));
    await addCall(f, f.driverId, Date.UTC(2026, 10, 2, 6, 30));
    const [{ n }] = await app.withTenant(f.tenantId, (q) => q.query<{ n: number }>(CALLS_TODAY_SQL, [iso(NOW)]));
    expect(n).toBe(1);
  });

  it("takes a driver's calls, their segments and their turns along when the driver is deleted", async () => {
    const f = A!;
    const driverId = randomUUID();
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        "INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis, per_mile_cents, active_from)" +
          " VALUES (CAST($1 AS uuid), current_tenant_id(), 'DRV-9', 'Test', 'Driver', 'drv-9@example.test', 'company'," +
          " 'per_mile', 60, CAST('2026-01-01' AS date))",
        [driverId],
      ),
    );
    await addCall(f, driverId);
    const kept = await addCall(f, f.driverId);
    await admin.withTenant(f.tenantId, (q) => q.execute("DELETE FROM drivers WHERE id = CAST($1 AS uuid)", [driverId]));
    const [left] = await asAdmin<Record<string, unknown>>(
      f,
      "SELECT CAST((SELECT count(*) FROM calls) AS integer) AS calls, CAST((SELECT count(*) FROM call_segments) AS integer) AS segments," +
        " CAST((SELECT count(*) FROM call_turns) AS integer) AS turns, (SELECT CAST(id AS text) FROM calls) AS id",
    );
    expect(left).toEqual({ calls: 1, segments: 1, turns: 1, id: kept.callId });
  });
});
