import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter, type MockPaymentAdapter } from "../adapters/payment/mock";
import { readTurnView } from "../agent/gateway/store/views";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param, Queryable, TenantDb } from "../db/types";
import { addAdvance, addCard, addJudge, clearLedger, dropTenant, makeTenant, removeCards, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal, type Executor, type ExecutorRegistry } from "../proposals/execute";
import { rejectProposal } from "../proposals/reject";
import { executeAdvanceProposal, precheckAdvanceProposal, retryAdvancePayout, type AdvanceDeps } from "./approve";
import { readAdvanceRecord } from "./read";
import { decisionNoteSentence } from "./reasons";
import { takeBackAdvance } from "./takeback";

// Parked advances (0079, flags.advanceParking) against a real database, as the app's own role: a
// person's approval whose numbers no longer hold parks the advance with its reason and pays
// nothing; approving it again re-checks everything and pays it once, as attempt 1, or parks it
// again with today's reason; an override needs an admin to release; a reject ends it with no
// money; the autopilot never parks or releases; with the switch off a parked advance stays
// parked and can only be rejected. Every tenant made here is removed after each test.

const saved = structuredClone(flags);
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);

let admin: Db;
let app: Db;
let A: Fixture;
let mock: MockPaymentAdapter;

// One pay rule set and one delivered, unpaid load for the first driver: $1,200.00 earned, half of
// which ($600.00) may be advanced, with a $5.00 fee.
async function addPayRules(f: Fixture) {
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'ui', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 500, 150000, 5000, 5000)`,
      [randomUUID()],
    );
    const loadId = randomUUID();
    await q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
         origin_state, dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles,
         linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'L-1', CAST($2 AS uuid), CAST($3 AS uuid),
         'delivered', 'Springfield', 'IL', 'Dallas', 'TX', CAST('2026-10-28' AS date),
         CAST('2026-10-30' AS date), CAST('2026-10-30T20:00:00Z' AS timestamptz), 2000, 400000)`,
      [loadId, f.customerId, f.driverId],
    );
    for (const [state, miles] of [["IL", 600], ["MO", 500], ["OK", 400], ["TX", 500]] as const) {
      await q.execute(
        `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4)`,
        [randomUUID(), loadId, state, miles],
      );
    }
  });
}

// A waiting $250.00 advance proposal shaped like the gateway's, passed by the auditor. Returns its
// id and its turn.
async function addProposal(amountCents = 25_000): Promise<{ id: string; turnId: string }> {
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - HOUR).toISOString();
  await admin.withTenant(A.tenantId, async (q) => {
    await q.execute(
      "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
      [conversation, A.session.sub],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Advance for DRV-1?', 'done', $3,
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
         amount_cents, direction, title, args, operator_verdict, gateway_decision_id,
         dedupe_key, trace_id, created_at, updated_at, auditor_verdict, auditor_agrees, auditor_checked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'advance_payout',
         'drivers', CAST($4 AS uuid), $5, 'out', 'Advance', CAST($6 AS jsonb), 'eligible',
         CAST($7 AS uuid), $8, $9, CAST($10 AS timestamptz), CAST($10 AS timestamptz), 'pass', TRUE,
         CAST($10 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        A.driverId,
        amountCents,
        JSON.stringify({ driverId: A.driverId, amountCents }),
        decision,
        `advance_payout:${A.driverId}:${randomBytes(32).toString("hex")}`,
        trace,
        created,
      ],
    );
  });
  return { id, turnId: turn };
}

const deps = (): AdvanceDeps => ({
  db: app,
  clock,
  money: { payment: mock, timeoutMs: 2_000, waitMs: 2_000, pollMs: 10, log: () => {} },
});

const approve = (id: string, opts: { confirmed?: boolean; overrideReason?: string } = {}, executors?: ExecutorRegistry) =>
  executeProposal(A.session, id, { confirmed: false, ...opts }, executors ? { ...deps(), executors } : deps());

const reject = (id: string) => rejectProposal(A.session, id, "wrong_amount", { db: app, clock });

const sql = <T>(text: string, params: Param[] = []) => admin.withTenant(A.tenantId, (q) => q.query<T>(text, params));

const proposalRow = async (id: string) =>
  (
    await sql<{ status: string; decision_note: string | null; money_action_id: string | null }>(
      "SELECT status, decision_note, CAST(money_action_id AS text) AS money_action_id FROM proposals WHERE id = CAST($1 AS uuid)",
      [id],
    )
  )[0];

type Flow = {
  id: string;
  status: string;
  park_reason: string | null;
  parked: boolean;
  reason_category: string | null;
  fee_cents: string;
  decided_by_membership_id: string | null;
};
const flowAdvances = () =>
  sql<Flow>(
    `SELECT CAST(id AS text) AS id, status, park_reason, (parked_at IS NOT NULL) AS parked, reason_category,
            CAST(fee_cents AS text) AS fee_cents, CAST(decided_by_membership_id AS text) AS decided_by_membership_id
       FROM advances WHERE tenant_id = current_tenant_id() AND proposal_id IS NOT NULL`,
  );

const ledger = () =>
  sql<{ state: string; attempt: number; idempotency_key: string; subject_id: string }>(
    `SELECT state, attempt, idempotency_key, CAST(subject_id AS text) AS subject_id
       FROM money_actions WHERE tenant_id = current_tenant_id() ORDER BY attempt`,
  );

// An approved $400.00 advance already open: $250.00 more would pass the $600.00 earned share.
// Removing it makes room again.
const block = () => addAdvance(admin, A, 40_000, "approved");
const unblock = (id: string) => sql("DELETE FROM advances WHERE id = CAST($1 AS uuid)", [id]);

const makeAdmin = () =>
  sql("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [A.memberId]);

// A card statement line for the driver's active card, naming whoever is given.
async function addStatementLine(portalName: string, postedAt: string) {
  const [card] = await sql<{ provider_token: string; last4: string }>(
    `SELECT provider_token, last4 FROM driver_cards
      WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND status = 'active'`,
    [A.driverId],
  );
  await sql(
    `INSERT INTO card_transactions (id, tenant_id, provider, provider_ref, kind, card_token, card_last4, portal_name,
       posted_at, posted_on, amount_cents, source, created_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'fuel_card_sim', $2, 'load', $3, $4, $5,
       CAST($6 AS timestamptz), CAST('2026-11-02' AS date), 5000, 'seed', CAST($6 AS timestamptz))`,
    [randomUUID(), `fcs_load_${randomBytes(12).toString("hex")}`, card.provider_token, card.last4, portalName, postedAt],
  );
}

// The executor as the autopilot runs it: opts.autopilot named, so it is never a person's approval.
const asAutopilot: ExecutorRegistry = {
  advance_payout: Object.assign(
    (...[db, session, proposal, opts, d]: Parameters<Executor>) =>
      executeAdvanceProposal(db, session, proposal, { ...opts, autopilot: { ruleId: randomUUID(), version: 1 } }, d),
    { precheck: precheckAdvanceProposal },
  ),
};

describe("parked advances", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    flags.advancesEnabled = true;
    flags.payoutsEnabled = true;
    flags.paymentProvider = "mock";
    flags.accountingEnabled = false;
    flags.auditorRequired = false;
    flags.advancePayouts = { armed: true, capCents: 50_000, startDate: "2026-10-27" };
    flags.advanceParking = { enabled: true, startDate: "2026-11-02" };
    mock = createMockPaymentAdapter({ log: () => {} });
    A = await makeTenant(admin, `park-${randomUUID().slice(0, 8)}`);
    await addPayRules(A);
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    if (A) await clearLedger(admin, A);
    await dropTenant(admin, A);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("parks a person's approval the pay rules no longer allow, then pays it once as attempt 1 when they do", async () => {
    const blocking = await block();
    const { id, turnId } = await addProposal();
    expect(await approve(id)).toEqual({ ok: false, category: "parked_no_room", retryable: false });
    const [adv] = await flowAdvances();
    expect(adv).toMatchObject({ status: "parked", park_reason: "no_room", parked: true, fee_cents: "500" });
    expect(await proposalRow(id)).toMatchObject({ status: "approved", money_action_id: null });
    expect(await ledger()).toEqual([]);
    expect(mock.sendCount).toBe(0);

    // The card reads it parked, releasable, and the record page says why.
    const view = await app.withTenant(A.tenantId, (q) => readTurnView(q, A.session.sub, turnId));
    expect(view?.proposals[0]).toMatchObject({ parked: { reason: "no_room", on: true, adminOnly: false } });
    const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
    expect(record?.advance).toMatchObject({ status: "parked", parkReason: "no_room", parkedAt: new Date(NOW).toISOString() });
    expect(record?.actions).toEqual({ retry: false, check: false, post: false, takeBack: false });

    // Approving again with nothing changed parks it again and pays nothing.
    expect(await approve(id)).toEqual({ ok: false, category: "parked_no_room", retryable: false });
    expect(await ledger()).toEqual([]);

    await unblock(blocking);
    expect(await approve(id)).toMatchObject({ ok: true, proposalId: id, status: "done" });
    const rows = await ledger();
    expect(rows).toEqual([expect.objectContaining({ state: "confirmed", attempt: 1, idempotency_key: `advance_payout:${adv.id}:1` })]);
    // The last park stays on the row as history.
    expect(await flowAdvances()).toEqual([
      expect.objectContaining({ id: adv.id, status: "paid", park_reason: "no_room", parked: true, reason_category: null }),
    ]);
    expect(await proposalRow(id)).toMatchObject({ status: "done", money_action_id: expect.any(String) });
    expect(mock.sendCount).toBe(1);
    // Paid: nothing parked is left to approve or reject.
    expect(await approve(id)).toMatchObject({ ok: false, category: "already_decided" });
    expect(await reject(id)).toEqual({ ok: false, category: "already_decided" });
    expect(mock.sendCount).toBe(1);
  });

  it("pays a parked advance once when two releases race", async () => {
    const blocking = await block();
    const { id } = await addProposal();
    expect(await approve(id)).toMatchObject({ category: "parked_no_room" });
    await unblock(blocking);
    const results = await Promise.all([approve(id), approve(id)]);
    expect(results.filter((r) => r.ok)).not.toHaveLength(0);
    expect(await ledger()).toHaveLength(1);
    expect(mock.sendCount).toBe(1);
    expect((await flowAdvances())[0].status).toBe("paid");
  });

  it("parks again with today's reason when the card went, and releases once a card is back", async () => {
    const blocking = await block();
    const { id } = await addProposal();
    expect(await approve(id)).toMatchObject({ category: "parked_no_room" });
    await unblock(blocking);
    await removeCards(admin, A, A.driverId);
    expect(await approve(id)).toEqual({ ok: false, category: "parked_card_removed", retryable: false });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "parked", park_reason: "card_removed", parked: true })]);
    expect(await ledger()).toEqual([]);

    await addCard(admin, A, A.driverId);
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(await ledger()).toEqual([expect.objectContaining({ state: "confirmed", attempt: 1 })]);
  });

  it("parks a card that went between the gate's check and the payout", async () => {
    const { id } = await addProposal();
    const racing: ExecutorRegistry = {
      advance_payout: Object.assign((...args: Parameters<Executor>) => executeAdvanceProposal(...args), {
        precheck: async (...args: Parameters<typeof precheckAdvanceProposal>) => {
          const answer = await precheckAdvanceProposal(...args);
          await removeCards(admin, A, A.driverId);
          return answer;
        },
      }),
    };
    expect(await approve(id, {}, racing)).toEqual({ ok: false, category: "parked_card_removed", retryable: false });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "parked", park_reason: "card_removed" })]);
    expect(await ledger()).toEqual([]);
    expect(mock.sendCount).toBe(0);
  });

  it("parks a released advance whose card went before its payout reserved, and rejects it from executing", async () => {
    const blocking = await block();
    const { id, turnId } = await addProposal();
    expect(await approve(id)).toMatchObject({ category: "parked_no_room" });
    await unblock(blocking);
    // The cards go once the release has committed (the proposal executing, the advance requested)
    // and before the payout reserves: the reserve finds the card no longer on file and rolls back.
    let removed = false;
    const racing: TenantDb = {
      async withTenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
        if (!removed) {
          const [adv] = await flowAdvances();
          if ((await proposalRow(id)).status === "executing" && adv?.status === "requested") {
            await removeCards(admin, A, A.driverId);
            removed = true;
          }
        }
        return app.withTenant(tenantId, fn);
      },
    };
    expect(await executeProposal(A.session, id, { confirmed: false }, { ...deps(), db: racing })).toMatchObject({
      ok: false,
      category: "unavailable",
    });
    expect(removed).toBe(true);
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "requested" })]);
    expect(await proposalRow(id)).toMatchObject({ status: "executing", money_action_id: null });
    expect(await ledger()).toEqual([]);

    // The next press parks it as card_removed; the proposal stays executing and the view reads it parked.
    expect(await approve(id)).toEqual({ ok: false, category: "parked_card_removed", retryable: false });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "parked", park_reason: "card_removed" })]);
    expect(await proposalRow(id)).toMatchObject({ status: "executing" });
    const view = await app.withTenant(A.tenantId, (q) => readTurnView(q, A.session.sub, turnId));
    expect(view?.proposals[0]).toMatchObject({ status: "approved", parked: { reason: "card_removed", on: true } });

    expect(await reject(id)).toEqual({ ok: true });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "rejected", reason_category: "wrong_amount" })]);
    expect(await proposalRow(id)).toMatchObject({ status: "failed", decision_note: "rejected_parked:wrong_amount" });
    expect(await ledger()).toEqual([]);
    expect(mock.sendCount).toBe(0);
  });

  it("parks when the card statement names someone else, reordered included, and pays once it matches", async () => {
    await addStatementLine("DRIVER TEST", "2026-11-01T12:00:00Z");
    const { id } = await addProposal();
    expect(await approve(id)).toEqual({ ok: false, category: "parked_name_mismatch", retryable: false });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "parked", park_reason: "name_mismatch" })]);
    expect(await ledger()).toEqual([]);

    // The latest statement line is the one compared.
    await addStatementLine("TEST DRIVER", "2026-11-02T12:00:00Z");
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(mock.sendCount).toBe(1);
  });

  it("parks an approval made over a mismatch, and only an admin releases it", async () => {
    flags.verifyEngineMismatchBlocks = true;
    const { id, turnId } = await addProposal();
    await sql(
      `UPDATE proposals SET engine_check = 'mismatch', engine_cents = 24999,
              engine_checked_at = CAST('2026-11-02T15:00:00Z' AS timestamptz)
        WHERE id = CAST($1 AS uuid)`,
      [id],
    );
    expect(await approve(id, { overrideReason: "The driver showed the receipt" })).toEqual({
      ok: false,
      category: "parked_override",
      retryable: false,
    });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "parked", park_reason: "override" })]);
    const view = await app.withTenant(A.tenantId, (q) => readTurnView(q, A.session.sub, turnId));
    expect(view?.proposals[0]).toMatchObject({ parked: { reason: "override", on: true, adminOnly: true } });

    // Staff may not release it, however often they press.
    expect(await approve(id)).toEqual({ ok: false, category: "parked_needs_admin", retryable: false });
    expect(await ledger()).toEqual([]);

    await makeAdmin();
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(await ledger()).toEqual([expect.objectContaining({ state: "confirmed", attempt: 1 })]);
    expect(mock.sendCount).toBe(1);
  });

  it("rejects a parked advance with no money, and says so", async () => {
    await block();
    const { id } = await addProposal();
    expect(await approve(id)).toMatchObject({ category: "parked_no_room" });
    // A demo visitor may not end it.
    const judge = await addJudge(admin, A);
    await expect(rejectProposal(judge, id, "wrong_amount", { db: app, clock })).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "parked" })]);

    expect(await reject(id)).toEqual({ ok: true });
    expect(await flowAdvances()).toEqual([
      expect.objectContaining({
        status: "rejected",
        park_reason: "no_room",
        reason_category: "wrong_amount",
        decided_by_membership_id: A.memberId,
      }),
    ]);
    const p = await proposalRow(id);
    expect(p).toMatchObject({ status: "failed", decision_note: "rejected_parked:wrong_amount" });
    expect(decisionNoteSentence(p.decision_note!)).toBe("Rejected while parked (wrong amount), so nothing was paid.");
    expect(await reject(id)).toEqual({ ok: false, category: "already_decided" });
    expect(await approve(id)).toMatchObject({ ok: false, category: "already_decided" });
    expect(await ledger()).toEqual([]);
    expect(mock.sendCount).toBe(0);
  });

  it("never parks for the autopilot: numbers that no longer hold fail the proposal as before", async () => {
    await block();
    const { id } = await addProposal();
    expect(await approve(id, {}, asAutopilot)).toEqual({ ok: false, category: "stale_eligibility", retryable: false });
    expect(await proposalRow(id)).toMatchObject({ status: "failed", decision_note: "stale_eligibility: exceeds_earned_share" });
    expect(await flowAdvances()).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  it("never releases a parked advance for the autopilot", async () => {
    const blocking = await block();
    const { id } = await addProposal();
    expect(await approve(id)).toMatchObject({ category: "parked_no_room" });
    await unblock(blocking);
    const proposal = await app.withTenant(A.tenantId, async (q) => {
      const [r] = await q.query<{ amount_cents: string; args: Record<string, unknown>; trace_id: string }>(
        "SELECT CAST(amount_cents AS text) AS amount_cents, args, trace_id FROM proposals WHERE id = CAST($1 AS uuid)",
        [id],
      );
      return r;
    });
    const result = await executeAdvanceProposal(
      app,
      A.session,
      {
        id,
        conversationId: null,
        turnId: null,
        kind: "advance_payout",
        subjectTable: "drivers",
        subjectId: A.driverId,
        amountCents: Number(proposal.amount_cents),
        direction: "out",
        args: proposal.args,
        status: "approved",
        flaggedInputId: null,
        auditorVerdict: "pass",
        auditorAgrees: true,
        moneyActionId: null,
        traceId: proposal.trace_id,
      },
      { confirmed: false, autopilot: { ruleId: randomUUID(), version: 1 } },
      deps(),
    );
    expect(result).toEqual({ ok: false, category: "autopilot_only", retryable: false });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "parked" })]);
    expect(await ledger()).toEqual([]);
  });

  it("with the switch off, fails as before and leaves a parked advance parked, to reject only", async () => {
    flags.advanceParking = { ...flags.advanceParking, enabled: false };
    await block();
    const stale = await addProposal();
    expect(await approve(stale.id)).toEqual({ ok: false, category: "stale_eligibility", retryable: false });
    expect(await flowAdvances()).toEqual([]);

    flags.advanceParking = { ...flags.advanceParking, enabled: true };
    const { id, turnId } = await addProposal();
    expect(await approve(id)).toMatchObject({ category: "parked_no_room" });
    flags.advanceParking = { ...flags.advanceParking, enabled: false };
    expect(await approve(id)).toEqual({ ok: false, category: "parking_off", retryable: false });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "parked" })]);
    const view = await app.withTenant(A.tenantId, (q) => readTurnView(q, A.session.sub, turnId));
    expect(view?.proposals.find((p) => p.id === id)).toMatchObject({ parked: { reason: "no_room", on: false } });
    expect(await reject(id)).toEqual({ ok: true });
    expect(await ledger()).toEqual([]);
  });

  it("parks nothing for a proposal made before the start date", async () => {
    flags.advanceParking = { enabled: true, startDate: "2026-11-03" };
    await block();
    const { id } = await addProposal();
    expect(await approve(id)).toEqual({ ok: false, category: "stale_eligibility", retryable: false });
    expect(await flowAdvances()).toEqual([]);
  });

  it("refuses a retry or a take-back of a parked advance", async () => {
    flags.advanceTakeback = { ...flags.advanceTakeback, enabled: true };
    await block();
    const { id } = await addProposal();
    expect(await approve(id)).toMatchObject({ category: "parked_no_room" });
    const [adv] = await flowAdvances();
    expect(await retryAdvancePayout(A.session, adv.id, deps())).toMatchObject({ ok: false });
    expect(await takeBackAdvance(A.session, adv.id, { amountCents: 0, reason: "wrong_driver" }, { db: app, clock })).toMatchObject({
      ok: false,
    });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "parked" })]);
    expect(await ledger()).toEqual([]);
  });

  it("refuses a parked row the 0079 checks do not allow", async () => {
    const plain = await addAdvance(admin, A, 10_000, "requested");
    const state = (text: string) => sqlStateOf(sql(text, [plain]));
    // A ui row with no proposal never parks; nor does a reason come without its time.
    expect(
      await state(
        "UPDATE advances SET status = 'parked', park_reason = 'no_room', parked_at = now() WHERE id = CAST($1 AS uuid)",
      ),
    ).toBe("23514");
    expect(await state("UPDATE advances SET park_reason = 'no_room' WHERE id = CAST($1 AS uuid)")).toBe("23514");
    expect(await state("UPDATE advances SET park_reason = 'later', parked_at = now() WHERE id = CAST($1 AS uuid)")).toBe("23514");
  });
});
