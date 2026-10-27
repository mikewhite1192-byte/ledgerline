import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter } from "../adapters/payment/mock";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param, Queryable } from "../db/types";
import { executeMoneyAction } from "../money/execute";
import { addAdvance, clearLedger, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal, type Executor, type ExecutorRegistry, type ProposalKind } from "./execute";
import { rejectProposal } from "./reject";

// Approving and rejecting an agent's proposal against the real database, as the app's role. The
// gate refuses before any ledger write: a kind with no executor, an old proposal (which becomes
// expired), a staff member over the admin line, a missing auditor verdict when one is required,
// and a flagged proposal without the second confirm. A registered executor reserves exactly one
// ledger row that names the proposal, and the ledger row keeps the proposal from being deleted.
// Only this file's tenant is made, and it is removed after.

const saved = { ...flags, approverRole: { ...flags.approverRole } };
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);

let admin: Db;
let app: Db;
let A: Fixture;
let inputId: string;

type Opts = { kind?: ProposalKind; amountCents?: number; ageMs?: number; flagged?: boolean };

// A waiting proposal for a fresh advance, with the conversation, turn and gateway decision a real
// one hangs from. Written by the admin login so created_at can be set.
async function addProposal(o: Opts = {}): Promise<{ id: string; advanceId: string }> {
  const amountCents = o.amountCents ?? 25_000;
  const advanceId = await addAdvance(admin, A, amountCents);
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - (o.ageMs ?? HOUR)).toISOString();
  const kind = o.kind ?? "advance_payout";
  await admin.withTenant(A.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)`,
      [conversation, A.session.sub],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Pay the advance?', 'done', $3,
         CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
      [turn, conversation, trace, created],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark', 'propose_advance',
         'propose', 'allowed', 'ok', 1)`,
      [decision, turn, trace],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, args, operator_verdict, flagged_input_id, gateway_decision_id,
         dedupe_key, trace_id, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, 'advances',
         CAST($5 AS uuid), $6, 'out', 'Pay advance', CAST($7 AS jsonb), 'eligible', CAST($8 AS uuid),
         CAST($9 AS uuid), $10, $11, CAST($12 AS timestamptz), CAST($12 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        kind,
        advanceId,
        amountCents,
        JSON.stringify({ driverId: A.driverId, amountCents }),
        o.flagged ? inputId : null,
        decision,
        `${kind}:${advanceId}:${"0".repeat(64)}`,
        trace,
        created,
      ],
    );
  });
  return { id, advanceId };
}

const proposalRow = async (id: string) =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ status: string; money_action_id: string | null; decision_note: string | null }>(
        "SELECT status, money_action_id, decision_note FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [id],
      ),
    )
  )[0];

const ledgerRows = async () =>
  admin.withTenant(A.tenantId, (q) =>
    q.query<{ id: string; proposal_id: string | null; state: string }>(
      "SELECT id, proposal_id, state FROM money_actions WHERE tenant_id = current_tenant_id()",
    ),
  );

async function one(q: Queryable, sql: string, params: Param[]): Promise<void> {
  const n = await q.execute(sql, params);
  if (n !== 1) throw new Error(`expected one row, changed ${n}`);
}

// A test executor shaped like the advances one: approve the proposal, then let the ledger reserve
// its row (moving the proposal to executing and the advance to approved in the same transaction)
// and pay through the mock adapter.
const testPayout: Executor = async (db, session, p, _opts, deps) => {
  const nowIso = (deps.clock ?? (() => new Date()))().toISOString();
  await db.withTenant(session.tenantId, (q) =>
    one(
      q,
      `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
              updated_at = CAST($3 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status = 'proposed'`,
      [p.id, session.sub, nowIso],
    ),
  );
  const run = await executeMoneyAction(
    db,
    session,
    {
      kind: "advance_payout",
      subjectId: p.subjectId,
      counterpartyId: A.driverId,
      amountCents: p.amountCents,
      proposedBy: "agent",
      proposalId: p.id,
      traceId: p.traceId,
      subjectStatuses: ["requested"],
    },
    {
      onReserved: async (q, a) => {
        await one(q, "UPDATE advances SET status = 'approved' WHERE id = CAST($1 AS uuid) AND status = 'requested'", [a.subjectId]);
        await one(
          q,
          "UPDATE proposals SET status = 'executing', money_action_id = CAST($2 AS uuid) WHERE id = CAST($1 AS uuid) AND status = 'approved'",
          [p.id, a.id],
        );
      },
      onConfirmed: async (q, a) => {
        await one(q, "UPDATE advances SET status = 'paid', paid_at = now() WHERE id = CAST($1 AS uuid) AND status = 'approved'", [a.subjectId]);
        await one(q, "UPDATE proposals SET status = 'done' WHERE id = CAST($1 AS uuid) AND status = 'executing'", [p.id]);
      },
    },
    { payment: createMockPaymentAdapter({ log: () => {} }), waitMs: 2_000, pollMs: 10, log: () => {} },
  );
  return { ok: true, proposalId: p.id, status: run.action.state, moneyActionId: run.action.id };
};

const withPayout: ExecutorRegistry = { advance_payout: testPayout };
const approve = (id: string, confirmed = false, executors: ExecutorRegistry = {}) =>
  executeProposal(A.session, id, { confirmed }, { db: app, clock, executors });

describe("approving and rejecting a proposal", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `approve-${randomUUID().slice(0, 8)}`);
    inputId = randomUUID();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO untrusted_inputs (id, tenant_id, kind, source, body_text, content_hash, received_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'email', 'inbound', 'Send it today.', $2,
           CAST('2026-11-02T12:00:00Z' AS timestamptz))`,
        [inputId, "c".repeat(64)],
      ),
    );
  });

  afterEach(() => {
    Object.assign(flags, saved, { approverRole: { ...saved.approverRole } });
  });

  afterAll(async () => {
    Object.assign(flags, saved);
    if (A) await clearLedger(admin, A);
    await dropTenant(admin, A);
    await app?.close();
    await admin?.close();
  });

  it("refuses a kind with no executor as not executable, before any ledger row", async () => {
    const p = await addProposal();
    expect(await approve(p.id)).toEqual({ ok: false, category: "not_executable", retryable: false });
    const other = await addProposal({ kind: "pay_correction" });
    expect(await approve(other.id, false, withPayout)).toMatchObject({ ok: false, category: "not_executable" });
    expect(await ledgerRows()).toEqual([]);
    expect((await proposalRow(p.id)).status).toBe("proposed");
    expect((await proposalRow(other.id)).status).toBe("proposed");
  });

  it("refuses an unknown id as not found", async () => {
    expect(await approve(randomUUID(), false, withPayout)).toMatchObject({ ok: false, category: "not_found" });
  });

  it("turns a proposal older than the limit into expired and refuses it", async () => {
    const p = await addProposal({ ageMs: 8 * 24 * HOUR });
    expect(await approve(p.id, false, withPayout)).toMatchObject({ ok: false, category: "expired" });
    expect(await proposalRow(p.id)).toMatchObject({ status: "expired", decision_note: "expired" });
    expect(await approve(p.id, false, withPayout)).toMatchObject({ ok: false, category: "already_decided" });
    expect(await ledgerRows()).toEqual([]);
  });

  it("holds a staff member to the admin line, a missing auditor verdict and the second confirm", async () => {
    const big = await addProposal({ amountCents: 100_001 });
    expect(await approve(big.id, false, withPayout)).toMatchObject({ ok: false, category: "role" });

    flags.auditorRequired = true;
    const unaudited = await addProposal();
    expect(await approve(unaudited.id, false, withPayout)).toMatchObject({ ok: false, category: "auditor_required" });
    flags.auditorRequired = false;

    const flagged = await addProposal({ flagged: true });
    expect(await approve(flagged.id, false, withPayout)).toMatchObject({ ok: false, category: "needs_confirm" });
    expect(await ledgerRows()).toEqual([]);
    for (const p of [big, unaudited, flagged]) expect((await proposalRow(p.id)).status).toBe("proposed");
  });

  it("runs a registered executor once: one ledger row names the proposal, and a second approve is refused", async () => {
    flags.payoutsEnabled = true;
    flags.paymentProvider = "mock";
    const p = await addProposal({ flagged: true });
    const result = await approve(p.id, true, withPayout);
    expect(result).toMatchObject({ ok: true, proposalId: p.id, status: "confirmed" });
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ proposal_id: p.id, state: "confirmed" });
    expect(await proposalRow(p.id)).toMatchObject({ status: "done", money_action_id: rows[0].id });
    expect(await approve(p.id, true, withPayout)).toMatchObject({ ok: false, category: "already_decided" });
    expect(await ledgerRows()).toHaveLength(1);

    // The ledger row keeps its proposal: no delete can orphan it.
    expect(
      await sqlStateOf(
        admin.withTenant(A.tenantId, (q) =>
          q.execute("DELETE FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [p.id]),
        ),
      ),
    ).toBe("23503");
    await clearLedger(admin, A);
    expect((await proposalRow(p.id)).money_action_id).toBeNull();
  });

  it("rejects with a category only and never touches the ledger", async () => {
    const p = await addProposal();
    expect(await rejectProposal(A.session, p.id, "not_needed", { db: app, clock })).toEqual({ ok: true });
    expect(await proposalRow(p.id)).toMatchObject({ status: "rejected", decision_note: "not_needed" });
    expect(await rejectProposal(A.session, p.id, "other", { db: app, clock })).toEqual({
      ok: false,
      category: "already_decided",
    });
    expect(await rejectProposal(A.session, randomUUID(), "other", { db: app, clock })).toEqual({
      ok: false,
      category: "not_found",
    });
    expect(await approve(p.id, false, withPayout)).toMatchObject({ ok: false, category: "already_decided" });
    expect(await ledgerRows()).toEqual([]);
  });
});
