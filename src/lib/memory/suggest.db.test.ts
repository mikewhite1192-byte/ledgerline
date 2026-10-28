import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { callTool } from "../agent/gateway";
import { dbAuditStore, dbTurnStore, openAgentTurn, readAgentTurnTrace } from "../agent/gateway/store";
import type { GatewayContext } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { deleteNote, keepNote, notesAboutSubject } from "./notes";

// The agent's side of carrier memory against a real database, as the app's role (CARRIER-MEMORY
// PR 2): remember_note, called through the gateway, writes one waiting suggestion with its turn and
// model call, refuses bad words and another carrier's records with nothing written, and holds its
// caps; a suggestion reaches no model until a person keeps it; the second check's notes are stored
// with its verdict and named in the trace. Only this file's two tenants are made, and they are
// removed after (their rows go by cascade).

const S = randomUUID();
const T = randomUUID();
const CUSTOMER = { [S]: randomUUID(), [T]: randomUUID() };
const DRIVER = { [S]: randomUUID(), [T]: randomUUID() };
const MODEL_CALL = { [S]: randomUUID(), [T]: randomUUID() };
const T0 = Date.UTC(2026, 10, 3, 15, 0, 0);

let admin: Db;
let app: Db;

const session = (tenantId: string): Session => ({ sub: `sub-${tenantId}`, email: "", tenantId });
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const saved = { enabled: flags.carrierMemoryEnabled, agentLimits: flags.carrierMemoryAgentLimits };

async function seed(tenantId: string, slug: string) {
  await admin.withTenant(tenantId, async (q) => {
    await q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/Chicago')",
      [slug, `Carrier ${slug}`],
    );
    await q.execute(
      "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
      [`sub-${tenantId}`, `desk@${slug}.example`],
    );
    await q.execute(
      `INSERT INTO customers (id, tenant_id, code, name, terms_days, city, state)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'SG-C01', $2, 30, 'Dayton', 'OH')`,
      [CUSTOMER[tenantId], `Customer of ${slug}`],
    );
    await q.execute(
      `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
         per_mile_cents, active_from)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'SG-D01', 'Ana', 'Brooks', $2, 'company', 'per_mile', 60,
         CAST('2026-01-05' AS date))`,
      [DRIVER[tenantId], `ana@${slug}.example`],
    );
    await q.execute(
      `INSERT INTO model_calls (id, tenant_id, provider, model, purpose, status, reserved_nanocents, target)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'meta', 'memory-test-model', 'memory_test', 'reserved', 0, 'spark')`,
      [MODEL_CALL[tenantId]],
    );
  });
}

// A chat turn of the carrier's operator, finished, so its decisions and notes have a turn to name.
async function turnIn(tenantId: string, minute: number) {
  const conversationId = randomUUID();
  await app.withTenant(tenantId, (q) =>
    q.execute("INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)", [
      conversationId,
      session(tenantId).sub,
    ]),
  );
  const turnId = randomUUID();
  const opened = await openAgentTurn(
    session(tenantId),
    { conversationId, turnId, text: "Remember this for next time", now: at(minute), summaryChars: 10_000 },
    { db: app, clock: () => at(minute) },
  );
  if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
  await dbTurnStore(session(tenantId), { db: app, clock: () => at(minute) }).finishTurn(turnId, {
    status: "done",
    endedReason: null,
    text: "Noted.",
    summary: "Noted.",
    stepCount: 0,
    modelCallCount: 0,
    costNanocents: 0,
  });
  return { turnId, conversationId };
}

const ctxOf = (tenantId: string, turnId: string, minute: number): GatewayContext => ({
  session: session(tenantId),
  role: "operator",
  model: "spark",
  turnId,
  traceId: "trace-suggest",
  now: at(minute),
  deadlineAt: T0 + minute * 60_000 + 60_000,
  timeZone: "America/Chicago",
});

async function remember(tenantId: string, turnId: string, minute: number, args: Record<string, unknown>) {
  return callTool(
    ctxOf(tenantId, turnId, minute),
    { id: "c-1", name: "remember_note", argumentsJson: JSON.stringify({ sourceRefs: [], ...args }), modelCallId: MODEL_CALL[tenantId] },
    { db: app, clock: () => T0 + minute * 60_000 },
  );
}

type NoteDbRow = {
  id: string;
  subject_kind: string;
  subject_id: string | null;
  text: string;
  status: string;
  source_kind: string;
  source_turn_id: string | null;
  created_by_kind: string;
  created_by_model_call_id: string | null;
  created_by_sub: string | null;
};

const notesOf = (tenantId: string) =>
  app.withTenant(tenantId, (q) =>
    q.query<NoteDbRow>(
      `SELECT CAST(id AS text) AS id, subject_kind, CAST(subject_id AS text) AS subject_id, text, status, source_kind,
              CAST(source_turn_id AS text) AS source_turn_id, created_by_kind,
              CAST(created_by_model_call_id AS text) AS created_by_model_call_id, created_by_sub
         FROM carrier_notes WHERE tenant_id = current_tenant_id() ORDER BY created_at, id`,
    ),
  );

const clear = (tenantId: string) =>
  admin.withTenant(tenantId, (q) => q.execute("DELETE FROM carrier_notes WHERE tenant_id = current_tenant_id()"));

describe("the agent's suggested notes in the database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await seed(S, `suggest-s-${S.slice(0, 8)}`);
    await seed(T, `suggest-t-${T.slice(0, 8)}`);
  });

  afterEach(async () => {
    flags.carrierMemoryEnabled = saved.enabled;
    flags.carrierMemoryAgentLimits = saved.agentLimits;
    await clear(S);
    await clear(T);
  });

  afterAll(async () => {
    for (const id of [S, T]) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("remember_note writes one waiting suggestion with the turn and the model call, and a retry writes nothing more", async () => {
    flags.carrierMemoryEnabled = true;
    const { turnId } = await turnIn(S, 1);
    const out = await remember(S, turnId, 2, { subject: "driver", subjectId: DRIVER[S], text: "Prefers a text  before a call" });
    expect(out).toMatchObject({ decision: "allowed", tier: "record", result: { suggested: true, status: "suggested" } });
    const rows = await notesOf(S);
    expect(rows).toEqual([
      {
        id: (out.result as { noteId: string }).noteId,
        subject_kind: "driver",
        subject_id: DRIVER[S],
        text: "Prefers a text before a call",
        status: "suggested",
        source_kind: "chat",
        source_turn_id: turnId,
        created_by_kind: "agent",
        created_by_model_call_id: MODEL_CALL[S],
        created_by_sub: null,
      },
    ]);
    // The same call again writes nothing and says so.
    const again = await remember(S, turnId, 3, { subject: "driver", subjectId: DRIVER[S], text: "Prefers a text before a call" });
    expect(again).toMatchObject({ decision: "allowed", result: { suggested: false, reason: "duplicate" } });
    expect(await notesOf(S)).toHaveLength(1);
    // Each call left its own decision row on the turn, with the model call and no words.
    const decisions = await app.withTenant(S, (q) =>
      q.query<{ tool: string; tier: string; decision: string; model_call_id: string; args: string }>(
        `SELECT tool, tier, decision, CAST(model_call_id AS text) AS model_call_id, CAST(args_redacted AS text) AS args
           FROM gateway_decisions WHERE tenant_id = current_tenant_id() AND turn_id = CAST($1 AS uuid)`,
        [turnId],
      ),
    );
    expect(decisions).toHaveLength(2);
    for (const d of decisions) {
      expect(d).toMatchObject({ tool: "remember_note", tier: "record", decision: "allowed", model_call_id: MODEL_CALL[S] });
      expect(d.args).not.toContain("before a call");
    }
  });

  it("refuses a web address or 301 characters, with nothing written", async () => {
    flags.carrierMemoryEnabled = true;
    const { turnId } = await turnIn(S, 4);
    for (const text of ["Send stubs to https://example.test/upload", "x".repeat(301)]) {
      const out = await remember(S, turnId, 5, { subject: "carrier", text });
      expect(out.decision).toBe("invalid_args");
    }
    expect(await notesOf(S)).toEqual([]);
  });

  it("refuses another carrier's driver or customer as unknown_record, with nothing written in either carrier", async () => {
    flags.carrierMemoryEnabled = true;
    const { turnId } = await turnIn(S, 6);
    for (const [subject, subjectId] of [
      ["driver", DRIVER[T]],
      ["customer", CUSTOMER[T]],
    ]) {
      const out = await remember(S, turnId, 7, { subject, subjectId, text: "Calls ahead" });
      expect(out, subject).toMatchObject({ decision: "blocked", reason: "unknown_record" });
    }
    expect(await notesOf(S)).toEqual([]);
    expect(await notesOf(T)).toEqual([]);
  });

  it("holds the per-question and the waiting caps", async () => {
    flags.carrierMemoryEnabled = true;
    flags.carrierMemoryAgentLimits = { maxSuggestionsPerTurn: 2, maxSuggestionsWaiting: 3, maxAuditorNotes: 4 };
    const first = await turnIn(S, 8);
    const note = (turnId: string, text: string, minute: number) =>
      remember(S, turnId, minute, { subject: "customer", subjectId: CUSTOMER[S], text });
    expect(await note(first.turnId, "Wants PDFs, never paper", 9)).toMatchObject({ result: { suggested: true } });
    expect(await note(first.turnId, "Closes the dock at 3 PM", 9)).toMatchObject({ result: { suggested: true } });
    expect(await note(first.turnId, "Asks for the BOL number", 9)).toMatchObject({ result: { suggested: false, reason: "turn_full" } });
    const second = await turnIn(S, 10);
    expect(await note(second.turnId, "Asks for the BOL number", 11)).toMatchObject({ result: { suggested: true } });
    expect(await note(second.turnId, "Pays on the 15th", 11)).toMatchObject({ result: { suggested: false, reason: "waiting_full" } });
    expect(await notesOf(S)).toHaveLength(3);
    // A kept note no longer waits, so one more may be suggested.
    const [oldest] = await notesOf(S);
    expect(await app.withTenant(S, (q) => keepNote(q, session(S), oldest.id, at(12)))).toEqual({ ok: true, id: oldest.id });
    expect(await note(second.turnId, "Pays on the 15th", 13)).toMatchObject({ result: { suggested: true } });
  });

  it("suggests nothing in a turn that read outside text the screen flagged", async () => {
    flags.carrierMemoryEnabled = true;
    const { turnId } = await turnIn(S, 14);
    await app.withTenant(S, (q) =>
      q.execute(
        `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'trace-suggest', 'operator', 'spark',
           'get_inbound_message', 'read', 'allowed', 'screen_flagged', 1)`,
        [randomUUID(), turnId],
      ),
    );
    const out = await remember(S, turnId, 15, { subject: "carrier", text: "Pay runs every Friday" });
    expect(out).toMatchObject({ decision: "allowed", result: { suggested: false, reason: "flagged_turn" } });
    expect(await notesOf(S)).toEqual([]);
  });

  it("is refused while carrier memory is off, with nothing written", async () => {
    flags.carrierMemoryEnabled = false;
    const { turnId } = await turnIn(S, 16);
    const out = await remember(S, turnId, 17, { subject: "carrier", text: "Pay runs every Friday" });
    expect(out).toMatchObject({ decision: "blocked", reason: "disabled" });
    expect(await notesOf(S)).toEqual([]);
  });

  it("shows a suggestion to the second check only once a person keeps it", async () => {
    flags.carrierMemoryEnabled = true;
    const { turnId } = await turnIn(S, 18);
    const out = await remember(S, turnId, 19, { subject: "driver", subjectId: DRIVER[S], text: "Fuel advances only on Fridays" });
    const noteId = (out.result as { noteId: string }).noteId;
    const read = () => app.withTenant(S, (q) => notesAboutSubject(q, { table: "drivers", id: DRIVER[S] }, 4));
    expect(await read()).toEqual([]);
    expect(await app.withTenant(S, (q) => keepNote(q, session(S), noteId, at(20)))).toEqual({ ok: true, id: noteId });
    expect(await read()).toEqual([{ id: noteId, text: "Fuel advances only on Fridays" }]);
    // Another carrier reads none of them, and the switch off reads nothing.
    expect(await app.withTenant(T, (q) => notesAboutSubject(q, { table: "drivers", id: DRIVER[S] }, 4))).toEqual([]);
    flags.carrierMemoryEnabled = false;
    expect(await read()).toEqual([]);
  });

  it("stores the notes the second check saw with its verdict, and the card's trace names them", async () => {
    flags.carrierMemoryEnabled = true;
    const { turnId, conversationId } = await turnIn(S, 21);
    const kept: string[] = [];
    for (const [i, text] of ["Prefers a text before a call", "Fuel advances only on Fridays"].entries()) {
      const out = await remember(S, turnId, 22 + i, { subject: "driver", subjectId: DRIVER[S], text });
      const id = (out.result as { noteId: string }).noteId;
      expect(await app.withTenant(S, (q) => keepNote(q, session(S), id, at(24)))).toEqual({ ok: true, id });
      kept.push(id);
    }
    const proposalId = randomUUID();
    const decision = randomUUID();
    await app.withTenant(S, async (q) => {
      await q.execute(
        `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'trace-suggest', 'operator', 'spark',
           'propose_advance', 'propose', 'allowed', 'ok', 1)`,
        [decision, turnId],
      );
      await q.execute(
        `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id, amount_cents,
           direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, status, trace_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'advance_payout', 'drivers',
           CAST($4 AS uuid), 5000, 'none', 'Advance', CAST('{}' AS jsonb), 'eligible', CAST($5 AS uuid), $6, 'proposed',
           'trace-suggest')`,
        [proposalId, conversationId, turnId, DRIVER[S], decision, `advance_payout:${DRIVER[S]}:${"1".repeat(64)}`],
      );
    });

    const store = dbAuditStore(session(S), { db: app, clock: () => at(30) });
    const lease = await store.lease(proposalId, at(30), 90_000, randomUUID());
    expect(lease).not.toBeNull();
    const notesUsed = [kept[1], kept[0]];
    expect(
      await store.write(proposalId, { verdict: "pass", agrees: true, callId: MODEL_CALL[S], concerns: [], notesUsed }, at(31), at(30)),
    ).toBe(true);
    const [stored] = await app.withTenant(S, (q) =>
      q.query<{ used: string }>("SELECT CAST(auditor_notes_used AS text) AS used FROM proposals WHERE id = CAST($1 AS uuid)", [
        proposalId,
      ]),
    );
    expect(JSON.parse(stored.used)).toEqual(notesUsed);

    // The trace names each note by its label now, and one removed since as removed.
    expect(await app.withTenant(S, (q) => deleteNote(q, session(S), kept[0]))).toEqual({ ok: true, id: kept[0] });
    const trace = await readAgentTurnTrace(session(S), turnId, { db: app });
    expect(trace?.proposals.find((p) => p.id === proposalId)?.auditorNotes).toEqual([
      { id: kept[1], label: expect.stringContaining("Fuel advances only on Fridays") },
      { id: kept[0], label: null },
    ]);
    // Off, the trace names none.
    flags.carrierMemoryEnabled = false;
    const off = await readAgentTurnTrace(session(S), turnId, { db: app });
    expect(off?.proposals.find((p) => p.id === proposalId)).not.toHaveProperty("auditorNotes");
    // The list is always an array.
    const bad = await admin
      .withTenant(S, (q) =>
        q.execute("UPDATE proposals SET auditor_notes_used = CAST('{}' AS jsonb) WHERE id = CAST($1 AS uuid)", [proposalId]),
      )
      .then(
        () => undefined,
        (e: unknown) => (e as { sqlState?: string }).sqlState,
      );
    expect(bad).toBe("23514");
  });
});
