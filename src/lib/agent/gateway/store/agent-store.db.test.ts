import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "../../../auth/claims";
import { createPgDb } from "../../../db/pg";
import { adminUrl, appUrl } from "../../../db/test-urls";
import type { Db } from "../../../db/types";
import type { ProposalDraft } from "../types";
import { dbTurnStore, openAgentTurn, readAgentTurn, readRecentAgentTurns } from "./index";

// The agent's own tables against a real database, as the app's role: each carrier sees only its
// own turns and proposals, a person sees only their own conversations, one proposal per subject
// waits at a time, the same proposal again returns the first while it is live and is reported as
// already decided once a person rejected it, and the app role can add and move rows forward but
// never delete them or rewrite what was proposed. Only this file's two tenants are made, and they
// are removed after (their rows go by cascade).

const A = randomUUID();
const B = randomUUID();
const DRIVER = { [A]: randomUUID(), [B]: randomUUID() };
const DECISION = { [A]: randomUUID(), [B]: randomUUID() };
const INPUT = randomUUID();
const T0 = Date.UTC(2026, 10, 2, 15, 0, 0);

let admin: Db;
let app: Db;

const session = (tenantId: string, sub = `sub-${tenantId}`): Session => ({ sub, email: "", tenantId });
const clockAt = (ms: number) => () => new Date(ms);

async function seed(tenantId: string, slug: string) {
  await admin.withTenant(tenantId, async (q) => {
    await q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
      [slug, `Carrier ${slug}`],
    );
    for (const [sub, role] of [
      [`sub-${tenantId}`, "admin"],
      [`other-${tenantId}`, "staff"],
    ]) {
      await q.execute(
        "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, $3)",
        [sub, `${sub.slice(0, 12)}@${slug}.example`, role],
      );
    }
    await q.execute(
      `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
         per_mile_cents, active_from)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'AG-1', 'Sam', 'Rivera', $2, 'company', 'per_mile', 60,
         CAST('2026-01-05' AS date))`,
      [DRIVER[tenantId], `sam@${slug}.example`],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'trace-store', 'operator', 'spark', 'propose_advance',
         'propose', 'allowed', 'ok', 1)`,
      [DECISION[tenantId]],
    );
  });
}

const draftFor = (tenantId: string, amountCents: number): ProposalDraft =>
  ({
    kind: "advance_payout",
    subjectTable: "drivers",
    subjectId: DRIVER[tenantId],
    amountCents,
    args: { driverId: DRIVER[tenantId], amountCents, reasonCategories: ["driver_asked"] },
    limitCents: amountCents,
    exceptions: [],
    reasons: [],
    sources: [{ table: "drivers", id: DRIVER[tenantId] }],
  }) as unknown as ProposalDraft;

async function open(tenantId: string, conversationId: string | null = null, at = T0, sub?: string) {
  const turnId = randomUUID();
  const opened = await openAgentTurn(
    session(tenantId, sub),
    { conversationId, turnId, text: "Can AG-1 get an advance?", now: new Date(at), summaryChars: 10_000 },
    { db: app, clock: clockAt(at) },
  );
  if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
  return opened;
}

async function sqlStateOf(work: Promise<unknown>): Promise<string | undefined> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return (err as { sqlState?: string }).sqlState;
}

describe("the agent's store", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await seed(A, `agent-a-${A.slice(0, 8)}`);
    await seed(B, `agent-b-${B.slice(0, 8)}`);
    await admin.withTenant(A, (q) =>
      q.execute(
        `INSERT INTO untrusted_inputs (id, tenant_id, kind, source, body_text, content_hash, received_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'email', 'inbound', 'Pay me now.', $2,
           CAST('2026-11-02T12:00:00Z' AS timestamptz))`,
        [INPUT, "a".repeat(64)],
      ),
    );
  });

  afterAll(async () => {
    for (const id of [A, B]) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("opens a turn with a summary from the database, records its steps and reads it back", async () => {
    const turn = await open(A);
    expect(turn.seq).toBe(1);
    expect(turn.summary).toContain(`Carrier agent-a-${A.slice(0, 8)}`);
    expect(turn.summary).not.toContain("Pay me now.");
    expect(turn.summaryChars).toBe(turn.summary.length);
    const store = dbTurnStore(session(A), { db: app, clock: clockAt(T0 + 1_000) });
    const step = await store.startStep(turn.turnId, { kind: "tool", label: "Reading the driver" });
    expect(step).toMatchObject({ seq: 1, state: "running", label: "Reading the driver" });
    await store.finishStep(turn.turnId, step.id, { state: "done", detail: { tool: "get_driver", decision: "allowed" } });
    await store.finishTurn(turn.turnId, {
      status: "done",
      endedReason: null,
      text: "Yes.",
      summary: "Yes.",
      stepCount: 1,
      modelCallCount: 1,
      costNanocents: 2_000_000_000,
    });
    const view = await readAgentTurn(session(A), turn.turnId, { db: app });
    expect(view).toMatchObject({ status: "done", text: "Yes.", steps: [{ label: "Reading the driver", state: "done" }] });
    // A finished turn finishes once.
    await expect(
      store.finishTurn(turn.turnId, { status: "failed", endedReason: "store", text: "x", summary: "x", stepCount: 0, modelCallCount: 0, costNanocents: 0 }),
    ).rejects.toThrow();
  });

  it("keeps each carrier's and each person's turns to themselves", async () => {
    const turn = await open(A);
    expect(await readAgentTurn(session(B), turn.turnId, { db: app })).toBeNull();
    expect(await readAgentTurn(session(A, `other-${A}`), turn.turnId, { db: app })).toBeNull();
    // Another person cannot add a turn to this person's conversation.
    const refused = await openAgentTurn(
      session(A, `other-${A}`),
      { conversationId: turn.conversationId, turnId: randomUUID(), text: "hi", now: new Date(T0), summaryChars: 10_000 },
      { db: app },
    );
    expect(refused).toEqual({ refused: "not_found" });
    const recent = await readRecentAgentTurns(session(A, `other-${A}`), { db: app });
    expect(recent).toEqual([]);
    const counts = await app.withTenant(B, (q) =>
      q.query<{ n: number }>("SELECT count(*) AS n FROM turns WHERE tenant_id = CAST($1 AS uuid)", [A]),
    );
    expect(Number(counts[0].n)).toBe(0);
  });

  it("refuses a second turn while one runs, and a repeated turn id", async () => {
    const first = await open(A);
    const busy = await openAgentTurn(
      session(A),
      { conversationId: first.conversationId, turnId: randomUUID(), text: "again", now: new Date(T0 + 5_000), summaryChars: 10_000 },
      { db: app },
    );
    expect(busy).toEqual({ refused: "busy" });
    const again = await openAgentTurn(
      session(A),
      { conversationId: null, turnId: first.turnId, text: "again", now: new Date(T0), summaryChars: 10_000 },
      { db: app },
    );
    expect(again).toEqual({ refused: "duplicate" });
    // Two minutes on, the running turn counts as abandoned and the next one starts.
    const later = await open(A, first.conversationId, T0 + 121_000);
    expect(later.seq).toBe(2);
    const stale = await readAgentTurn(session(A), first.turnId, { db: app });
    expect(stale).toMatchObject({ status: "failed", endedReason: "abandoned" });
  });

  it("keeps one waiting proposal per subject and returns the first for the same proposal again", async () => {
    const turn = await open(B);
    const store = dbTurnStore(session(B), { db: app, clock: clockAt(T0) });
    const input = (amount: number) => ({
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      traceId: turn.traceId,
      draft: draftFor(B, amount),
      gatewayDecisionId: DECISION[B],
      flaggedInputId: null,
    });
    const first = await store.persistProposal(input(20_000));
    expect(first).toMatchObject({ kind: "created", flagged: false });
    const same = await store.persistProposal(input(20_000));
    expect(same).toEqual({ kind: "duplicate", proposalId: first.proposalId, flagged: false });
    const other = await store.persistProposal(input(15_000));
    expect(other).toEqual({ kind: "live_exists", proposalId: first.proposalId });
    const view = await readAgentTurn(session(B), turn.turnId, { db: app });
    expect(view?.proposals).toHaveLength(1);
    expect(view?.proposals[0]).toMatchObject({ amountCents: 20_000, direction: "out", status: "proposed", subjectLabel: "AG-1" });
    // The partial unique index holds even for a write that skips the store's own check.
    expect(
      await sqlStateOf(
        app.withTenant(B, (q) =>
          q.execute(
            `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
               amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'advance_payout',
               'drivers', CAST($4 AS uuid), 1, 'out', 'Pay advance', CAST('{}' AS jsonb), 'eligible',
               CAST($5 AS uuid), $6, 'trace')`,
            [randomUUID(), turn.conversationId, turn.turnId, DRIVER[B], DECISION[B], `advance_payout:${DRIVER[B]}:${"b".repeat(64)}`],
          ),
        ),
      ),
    ).toBe("23505");
  });

  it("reports the same proposal asked again after a person rejected it as already decided, with no card", async () => {
    const at = T0 + 400_000;
    const driver = randomUUID();
    await admin.withTenant(A, (q) =>
      q.execute(
        `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
           per_mile_cents, active_from)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'AG-2', 'Pat', 'Lee', $2, 'company', 'per_mile', 60,
           CAST('2026-01-05' AS date))`,
        [driver, `pat-${A.slice(0, 8)}@example.test`],
      ),
    );
    const draft = {
      ...draftFor(A, 12_000),
      subjectId: driver,
      args: { driverId: driver, amountCents: 12_000, reasonCategories: ["driver_asked"] },
      sources: [{ table: "drivers", id: driver }],
    } as unknown as ProposalDraft;
    const store = dbTurnStore(session(A), { db: app, clock: clockAt(at) });
    const inputFor = (turn: Awaited<ReturnType<typeof open>>, flaggedInputId: string | null = null) => ({
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      traceId: turn.traceId,
      draft,
      gatewayDecisionId: DECISION[A],
      flaggedInputId,
    });
    const firstTurn = await open(A, null, at);
    const first = await store.persistProposal(inputFor(firstTurn));
    expect(first).toMatchObject({ kind: "created", flagged: false });

    // A person rejects it: the reject route's own write, as the app role.
    const rejected = await app.withTenant(A, (q) =>
      q.execute(
        `UPDATE proposals SET status = 'rejected', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                decision_note = 'not_needed', updated_at = CAST($3 AS timestamptz)
          WHERE id = CAST($1 AS uuid) AND status = 'proposed'`,
        [first.proposalId, `sub-${A}`, new Date(at).toISOString()],
      ),
    );
    expect(rejected).toBe(1);

    // Asked again in a new turn, even one that read a flagged message: no new card, no duplicate.
    const again = await open(A, null, at + 1_000);
    expect(await store.persistProposal(inputFor(again))).toEqual({
      kind: "already_decided",
      proposalId: first.proposalId,
      status: "rejected",
    });
    expect(await store.persistProposal(inputFor(again, INPUT))).toEqual({
      kind: "already_decided",
      proposalId: first.proposalId,
      status: "rejected",
    });
    expect((await readAgentTurn(session(A), again.turnId, { db: app }))?.proposals).toEqual([]);
    const original = await readAgentTurn(session(A), firstTurn.turnId, { db: app });
    expect(original?.proposals).toHaveLength(1);
    expect(original?.proposals[0]).toMatchObject({ id: first.proposalId, status: "rejected", flagged: false });
  });

  it("flags a proposal once and never unflags it", async () => {
    const turn = await open(A, null, T0 + 200_000);
    const store = dbTurnStore(session(A), { db: app, clock: clockAt(T0 + 200_000) });
    const saved = await store.persistProposal({
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      traceId: turn.traceId,
      draft: draftFor(A, 10_000),
      gatewayDecisionId: DECISION[A],
      flaggedInputId: INPUT,
    });
    expect(saved).toMatchObject({ kind: "created", flagged: true });
    expect(
      await sqlStateOf(
        app.withTenant(A, (q) =>
          q.execute("UPDATE proposals SET flagged_input_id = NULL WHERE id = CAST($1 AS uuid)", [saved.proposalId]),
        ),
      ),
    ).toBe("23514");
    // Status moves forward only.
    expect(
      await sqlStateOf(
        app.withTenant(A, (q) =>
          q.execute(
            "UPDATE proposals SET status = 'done', decided_by = 'x', decided_at = now() WHERE id = CAST($1 AS uuid)",
            [saved.proposalId],
          ),
        ),
      ),
    ).toBe("23514");
    const view = await readAgentTurn(session(A), turn.turnId, { db: app });
    expect(view?.proposals[0]).toMatchObject({ flagged: true });
  });

  it("lets the app role add and move rows forward, never delete them or rewrite what was proposed", async () => {
    for (const table of ["conversations", "turns", "turn_steps", "proposals"]) {
      expect(
        await sqlStateOf(app.withTenant(A, (q) => q.execute(`DELETE FROM ${table} WHERE tenant_id = current_tenant_id()`))),
        table,
      ).toBe("42501");
    }
    for (const sql of [
      "UPDATE proposals SET amount_cents = 1 WHERE tenant_id = current_tenant_id()",
      "UPDATE proposals SET args = CAST('{}' AS jsonb) WHERE tenant_id = current_tenant_id()",
      "UPDATE turns SET user_text = 'x' WHERE tenant_id = current_tenant_id()",
      "UPDATE turn_steps SET label = 'x' WHERE tenant_id = current_tenant_id()",
      "UPDATE conversations SET created_by = 'x' WHERE tenant_id = current_tenant_id()",
    ]) {
      expect(await sqlStateOf(app.withTenant(A, (q) => q.execute(sql))), sql).toBe("42501");
    }
  });
});
