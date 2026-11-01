import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createFuelCardSimAdapter, loadId } from "../adapters/payment/fuel-card-sim";
import { createMockPaymentAdapter, type MockPaymentAdapter } from "../adapters/payment/mock";
import type { AccountingAdapter, PaymentAdapter } from "../adapters/types";
import { DAILY_CAP_SQL } from "../agent/gateway/daily-cap";
import { readTurnView } from "../agent/gateway/store/views";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, TenantDb } from "../db/types";
import { dbLedgerStore, type LedgerStore } from "../money/execute";
import { reconcileMoneyActions } from "../money/reconcile";
import {
  addAdvance,
  addCard,
  clearLedger,
  closeCard,
  dropTenant,
  makeTenant,
  removeCards,
  setArmed,
  setCardBehavior,
  sqlStateOf,
  type Fixture,
} from "../money/test-db";
import { executeProposal, type Executor, type ExecutorRegistry } from "../proposals/execute";
import {
  checkAdvancePayouts,
  executeAdvanceProposal,
  payoutReconcileHooks,
  precheckAdvanceProposal,
  retryAdvancePayout,
  type AdvanceDeps,
} from "./approve";
import { armDriver } from "./arming";
import { addCard as addDriverCard, closeCard as closeDriverCard } from "./identity";
import { postAdvanceExpense } from "./post-expense";
import { cardLineFor, readAdvanceList, readAdvanceRecord, readDeskLoads, readDeskSuggestion, type DeskSuggestion } from "./read";
import { decisionNoteSentence } from "./reasons";
import { REQUEST_REF } from "./request";
import { takeBackAdvance } from "./takeback";

// The advance flow against a real database, as the app's own role, with the registered executor
// (EXECUTORS) and the mock payment adapter. A person's approval creates the one advances row and
// pays it once, however many times it is pressed; a closed switch, a missing driver or unreadable
// pay rules refuse before the approval and leave the proposal waiting; a failure after the gate
// leaves a state that a retry, a re-approval or Check pending adopts; the pay rules are asked
// again at approval; a flagged proposal needs the second confirm; Check pending reads one
// advance only; another carrier sees nothing. Every tenant made here
// is removed after each test.

const saved = structuredClone(flags);
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let transcriptId: string;
let mock: MockPaymentAdapter;

// A pay rule set and one delivered, unpaid load per driver: 2,000 loaded miles at 60 cents is
// $1,200.00 earned, half of which ($600.00) may be advanced, with a $5.00 fee and a $1,500.00 limit.
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
    let n = 0;
    for (const driverId of [f.driverId, f.otherDriverId]) {
      n += 1;
      const loadId = randomUUID();
      await q.execute(
        `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
           origin_state, dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles,
           linehaul_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid),
           'delivered', 'Springfield', 'IL', 'Dallas', 'TX', CAST('2026-10-28' AS date),
           CAST('2026-10-30' AS date), CAST('2026-10-30T20:00:00Z' AS timestamptz), 2000, 400000)`,
        [loadId, `L-${n}`, f.customerId, driverId],
      );
      // The per-state miles add up to the load's miles (the engine checks it).
      for (const [state, miles] of [["IL", 600], ["MO", 500], ["OK", 400], ["TX", 500]] as const) {
        await q.execute(
          `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4)`,
          [randomUUID(), loadId, state, miles],
        );
      }
    }
  });
}

type Opts = {
  amountCents?: number;
  driverId?: string;
  flagged?: boolean;
  requestRef?: string;
  createdAt?: string;
  tenant?: Fixture;
  // 0027: the load the advance is for, and the card it pays when not the default.
  loadId?: string;
  cardId?: string;
};

// A waiting advance proposal shaped like the gateway's: the driver is the subject, the args
// carry the driver and the amount. The auditor's pass is stored with it, so one click approves
// it unless it is flagged. Written by the admin login so created_at and the verdict can be set.
async function addProposal(o: Opts = {}): Promise<string> {
  const f = o.tenant ?? A;
  const amountCents = o.amountCents ?? 25_000;
  const driverId = o.driverId ?? f.driverId;
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = o.createdAt ?? new Date(NOW - HOUR).toISOString();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
      [conversation, f.session.sub],
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
         amount_cents, direction, title, args, operator_verdict, flagged_input_id, gateway_decision_id,
         dedupe_key, trace_id, created_at, updated_at, auditor_verdict, auditor_agrees, auditor_checked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'advance_payout',
         'drivers', CAST($4 AS uuid), $5, 'out', 'Advance', CAST($6 AS jsonb), 'eligible', CAST($7 AS uuid),
         CAST($8 AS uuid), $9, $10, CAST($11 AS timestamptz), CAST($11 AS timestamptz), 'pass', TRUE,
         CAST($11 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        driverId,
        amountCents,
        JSON.stringify({
          driverId,
          amountCents,
          ...(o.requestRef ? { requestRef: o.requestRef } : {}),
          ...(o.loadId ? { loadId: o.loadId } : {}),
          ...(o.cardId ? { cardId: o.cardId } : {}),
        }),
        o.flagged ? transcriptId : null,
        decision,
        `advance_payout:${driverId}:${randomBytes(32).toString("hex")}`,
        trace,
        created,
      ],
    );
  });
  return id;
}

const deps = (over: Partial<AdvanceDeps["money"]> = {}): AdvanceDeps => ({
  db: app,
  clock,
  money: { payment: mock, timeoutMs: 2_000, waitMs: 2_000, pollMs: 10, log: () => {}, ...over },
});

const approve = (id: string, confirmed = false, d: AdvanceDeps = deps(), session = A.session) =>
  executeProposal(session, id, { confirmed }, d);

const proposalRow = async (id: string) =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ status: string; money_action_id: string | null; decision_note: string | null; decided_by: string | null }>(
        `SELECT status, money_action_id, decision_note, decided_by FROM proposals
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0];

type FlowRow = {
  id: string;
  status: string;
  request_ref: string;
  source: string;
  source_input_id: string | null;
  requested_at: string;
  amount_cents: string;
  fee_cents: string;
  decided_by_membership_id: string | null;
  paid: boolean;
};

const flowAdvances = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<FlowRow>(
      `SELECT id, status, request_ref, source, source_input_id,
              to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
              CAST(amount_cents AS text) AS amount_cents, CAST(fee_cents AS text) AS fee_cents,
              CAST(decided_by_membership_id AS text) AS decided_by_membership_id,
              (paid_at IS NOT NULL) AS paid
         FROM advances WHERE tenant_id = current_tenant_id() AND proposal_id IS NOT NULL`,
    ),
  );

const ledger = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ id: string; kind: string; state: string; attempt: number; amount_cents: string; failure_category: string | null }>(
      `SELECT id, kind, state, attempt, CAST(amount_cents AS text) AS amount_cents, failure_category
         FROM money_actions WHERE tenant_id = current_tenant_id() ORDER BY kind, attempt`,
    ),
  );

// A database that runs close() once its first transaction has committed: stands in for a switch
// turned off between a caller's own checks and the payout.
function closingAfterFirst(db: TenantDb, close: () => void): TenantDb {
  let n = 0;
  return {
    withTenant: async (tenantId, fn) => {
      const result = await db.withTenant(tenantId, fn);
      n += 1;
      if (n === 1) close();
      return result;
    },
  };
}

// A QuickBooks stand-in that confirms every purchase and counts them.
function countingAccounting(): { adapter: AccountingAdapter; created: () => number } {
  let created = 0;
  const adapter = {
    system: "qbo_sandbox",
    ready: async () => ({ ok: true }),
    ensureVendor: async () => ({ outsideId: "V-77" }),
    createExpense: async (_q: unknown, e: { amountCents: number; feeCents: number }) => {
      created += 1;
      return { kind: "confirmed", system: "qbo_sandbox", type: "Purchase", id: `P-${created}`, amountCents: e.amountCents + e.feeCents };
    },
  } as unknown as AccountingAdapter;
  return { adapter, created: () => created };
}

// The fuel-card side of one advance: the card its latest attempt recorded, the driver's active
// card, and each payout row's outside reference and check count.
const advanceCard = async (advanceId: string) =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ card_id: string | null }>(
        "SELECT CAST(card_id AS text) AS card_id FROM advances WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [advanceId],
      ),
    )
  )[0].card_id;

const activeCard = async (driverId: string) =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ id: string; last4: string }>(
        `SELECT CAST(id AS text) AS id, last4 FROM driver_cards
          WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND status = 'active'`,
        [driverId],
      ),
    )
  )[0];

const payouts = () =>
  admin.withTenant(A.tenantId, (q) =>
    q.query<{
      state: string;
      attempt: number;
      request_id: string;
      outside_system: string | null;
      outside_id: string | null;
      failure_category: string | null;
      check_count: number;
    }>(
      `SELECT state, attempt, request_id, outside_system, outside_id, failure_category, check_count
         FROM money_actions WHERE tenant_id = current_tenant_id() AND kind = 'advance_payout' ORDER BY attempt`,
    ),
  );

function openSwitches() {
  flags.advancesEnabled = true;
  flags.payoutsEnabled = true;
  flags.paymentProvider = "mock";
  flags.accountingEnabled = false;
  flags.auditorRequired = false;
  flags.advancePayouts = { armed: true, capCents: 50_000, startDate: "2026-10-27" };
  // The take-back ships on; the tests that take one back turn it on themselves.
  flags.advanceTakeback = { ...flags.advanceTakeback, enabled: false };
}

describe("the advance flow", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    openSwitches();
    mock = createMockPaymentAdapter({ log: () => {} });
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `adv-a-${tag}`);
    B = await makeTenant(admin, `adv-b-${tag}`);
    await addPayRules(A);
    await addPayRules(B);
    transcriptId = randomUUID();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO untrusted_inputs (id, tenant_id, kind, source, body_text, content_hash, received_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'transcript', 'voice', 'Need two fifty for fuel.', $2,
           CAST('2026-11-02T14:00:00Z' AS timestamptz))`,
        [transcriptId, "d".repeat(64)],
      ),
    );
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    for (const f of [A, B]) {
      if (f) await clearLedger(admin, f);
      await dropTenant(admin, f);
    }
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("creates one advance at approval and pays it once, however many times approve is pressed", async () => {
    const id = await addProposal();
    expect(await approve(id)).toMatchObject({ ok: true, proposalId: id, status: "done" });
    expect(await approve(id)).toMatchObject({ ok: false, category: "already_decided" });

    const advances = await flowAdvances();
    expect(advances).toHaveLength(1);
    const [adv] = advances;
    expect(adv).toMatchObject({
      status: "paid",
      source: "ui",
      source_input_id: null,
      requested_at: new Date(NOW - HOUR).toISOString(),
      amount_cents: "25000",
      fee_cents: "500",
      decided_by_membership_id: A.memberId,
      paid: true,
    });
    expect(adv.request_ref).toMatch(REQUEST_REF);
    expect(adv.request_ref).toBe(`ADV-${id.replace(/-/g, "").slice(0, 12).toUpperCase()}`);
    const rows = await ledger();
    expect(rows).toEqual([expect.objectContaining({ kind: "advance_payout", state: "confirmed", attempt: 1, amount_cents: "25000" })]);
    expect(mock.sendCount).toBe(1);
    expect(await proposalRow(id)).toMatchObject({ status: "done", money_action_id: rows[0].id });
  });

  it("pays once when two approvals race", async () => {
    const id = await addProposal();
    const results = await Promise.all([approve(id), approve(id)]);
    expect(results.filter((r) => r.ok)).not.toHaveLength(0);
    expect(await flowAdvances()).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
    expect(mock.sendCount).toBe(1);
    expect((await flowAdvances())[0].status).toBe("paid");
  });

  it("leaves a definite payout failure approved and unpaid, and a retry pays it as attempt 2", async () => {
    const id = await addProposal();
    mock.failNext("rate_limited");
    expect(await approve(id)).toEqual({ ok: false, category: "payout_failed", retryable: true });
    const [adv] = await flowAdvances();
    expect(adv.status).toBe("approved");
    expect(await ledger()).toEqual([expect.objectContaining({ state: "failed", attempt: 1 })]);
    expect((await proposalRow(id)).status).toBe("failed");

    // Approving again is refused (the proposal is decided); the advance's page retries it.
    expect(await approve(id)).toMatchObject({ ok: false, category: "already_decided" });
    const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
    expect(record?.actions).toEqual({ retry: true, check: false, post: false, takeBack: false });

    expect(await retryAdvancePayout(A.session, adv.id, deps())).toMatchObject({ ok: true, status: "paid" });
    expect(await ledger()).toEqual([
      expect.objectContaining({ state: "failed", attempt: 1 }),
      expect.objectContaining({ state: "confirmed", attempt: 2 }),
    ]);
    expect((await flowAdvances())[0].status).toBe("paid");
    expect(mock.sendCount).toBe(2);
    // The advance row is the truth after a retry; a failed proposal never becomes done.
    expect((await proposalRow(id)).status).toBe("failed");
    expect(await retryAdvancePayout(A.session, adv.id, deps())).toMatchObject({ ok: false, category: "not_retryable" });
  });

  it("keeps a payout with no answer unknown, never retries it, and Check pending adopts it", async () => {
    const id = await addProposal();
    mock.hangNext();
    expect(await approve(id, false, deps({ timeoutMs: 50 }))).toMatchObject({ ok: true, status: "executing" });
    const [adv] = await flowAdvances();
    expect(adv.status).toBe("approved");
    const [row] = await ledger();
    expect(["sent", "unknown"]).toContain(row.state);
    expect(await retryAdvancePayout(A.session, adv.id, deps())).toMatchObject({ ok: false, category: "payout_pending" });

    const checked = await checkAdvancePayouts(A.session, adv.id, deps());
    expect(checked).toMatchObject({ ok: true, summary: { confirmed: 1 } });
    expect((await flowAdvances())[0]).toMatchObject({ status: "paid", paid: true });
    expect(await ledger()).toEqual([expect.objectContaining({ state: "confirmed", attempt: 1 })]);
    expect((await proposalRow(id)).status).toBe("done");
  });

  it("resumes an approval that stopped before its advance existed, running the executor once and paying once", async () => {
    const id = await addProposal();
    // The executor stops after the gate moved the proposal to approved, before any work.
    const crashing: ExecutorRegistry = {
      advance_payout: Object.assign(
        async (): Promise<never> => {
          throw new Error("stopped");
        },
        { precheck: precheckAdvanceProposal },
      ),
    };
    await expect(approve(id, false, { ...deps(), executors: crashing })).rejects.toThrow("stopped");
    expect(await proposalRow(id)).toMatchObject({ status: "approved", money_action_id: null });
    expect(await flowAdvances()).toEqual([]);
    expect(await ledger()).toEqual([]);

    // Resume: the same approve call; the approval stands, so no check runs again.
    let runs = 0;
    const counting: ExecutorRegistry = {
      advance_payout: Object.assign(
        (...args: Parameters<Executor>) => {
          runs += 1;
          return executeAdvanceProposal(...args);
        },
        { precheck: precheckAdvanceProposal },
      ),
    };
    expect(await approve(id, false, { ...deps(), executors: counting })).toMatchObject({ ok: true, status: "done" });
    expect(runs).toBe(1);
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "paid", paid: true })]);
    expect(await ledger()).toEqual([expect.objectContaining({ kind: "advance_payout", state: "confirmed", attempt: 1 })]);
    expect(mock.sendCount).toBe(1);
    // A second resume finds it decided and never reaches the executor.
    expect(await approve(id, false, { ...deps(), executors: counting })).toMatchObject({
      ok: false,
      category: "already_decided",
    });
    expect(runs).toBe(1);
    expect(await ledger()).toHaveLength(1);
    expect(mock.sendCount).toBe(1);
  });

  it("lets Check pending read back a payout past the automatic check limit, which the automatic pass skips", async () => {
    const id = await addProposal();
    mock.confirmSilently();
    expect(await approve(id)).toMatchObject({ ok: true, status: "executing" });
    const [adv] = await flowAdvances();
    const [row] = await ledger();
    expect(row.state).toBe("unknown");
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE money_actions SET check_count = 50 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [row.id],
      ),
    );
    // The automatic pass over the whole carrier stops at the limit.
    const sweep = await reconcileMoneyActions(
      app,
      A.session,
      { hooks: { advance_payout: payoutReconcileHooks }, olderThanSeconds: 0 },
      deps().money,
    );
    expect(sweep).toMatchObject({ checked: 0 });
    expect(await ledger()).toEqual([expect.objectContaining({ state: "unknown" })]);

    // A person's check of this advance reads it back and adopts it, sending nothing new.
    expect(await checkAdvancePayouts(A.session, adv.id, deps())).toEqual({
      ok: true,
      summary: expect.objectContaining({ checked: 1, confirmed: 1 }),
      tooNew: 0,
      stillWaiting: 0,
    });
    expect((await flowAdvances())[0]).toMatchObject({ status: "paid", paid: true });
    expect(await ledger()).toEqual([expect.objectContaining({ state: "confirmed", attempt: 1 })]);
    expect(mock.sendCount).toBe(1);
  });

  it("tells Check pending a payout is still waiting when the pass could not read it, and changes nothing", async () => {
    const id = await addProposal();
    mock.confirmSilently();
    expect(await approve(id)).toMatchObject({ ok: true, status: "executing" });
    const [adv] = await flowAdvances();
    expect(await ledger()).toEqual([expect.objectContaining({ state: "unknown" })]);
    const notReady: PaymentAdapter = { ...mock, system: "mock", ready: async () => ({ ok: false, category: "not_configured" }) };
    expect(await checkAdvancePayouts(A.session, adv.id, deps({ payment: notReady }))).toEqual({
      ok: true,
      summary: expect.objectContaining({ checked: 0 }),
      tooNew: 0,
      stillWaiting: 1,
    });
    expect(await ledger()).toEqual([expect.objectContaining({ state: "unknown" })]);
    expect((await flowAdvances())[0]).toMatchObject({ status: "approved", paid: false });
  });

  it("stops before the ledger when the payment service is not ready, and a later approval adopts it", async () => {
    const id = await addProposal();
    const notReady: PaymentAdapter = { ...mock, system: "mock", ready: async () => ({ ok: false, category: "not_configured" }) };
    expect(await approve(id, false, deps({ payment: notReady }))).toEqual({ ok: false, category: "unavailable", retryable: true });
    const [adv] = await flowAdvances();
    expect(adv.status).toBe("requested");
    expect(await ledger()).toEqual([]);
    expect((await proposalRow(id)).status).toBe("executing");
    const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
    expect(record?.actions.retry).toBe(true);

    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ id: adv.id, status: "paid" })]);
    expect(await ledger()).toHaveLength(1);
    expect(mock.sendCount).toBe(1);
  });

  it("asks the pay rules again at approval and never pays a proposal the numbers no longer allow", async () => {
    // With parking off it fails stale; parked.db.test.ts covers the same approval with parking on.
    flags.advanceParking.enabled = false;
    // An approved $400.00 advance already open: $250.00 more would pass the $600.00 earned share.
    await addAdvance(admin, A, 40_000, "approved");
    const id = await addProposal();
    expect(await approve(id)).toEqual({ ok: false, category: "stale_eligibility", retryable: false });
    expect(await proposalRow(id)).toMatchObject({
      status: "failed",
      decision_note: "stale_eligibility: exceeds_earned_share",
      money_action_id: null,
    });
    expect(await flowAdvances()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(mock.sendCount).toBe(0);
  });

  it("refuses every closed switch before approving, leaves the proposal waiting, and pays once they open", async () => {
    const id = await addProposal();
    const stillWaiting = async () => {
      expect(await proposalRow(id)).toMatchObject({ status: "proposed", decided_by: null, money_action_id: null });
      expect(await flowAdvances()).toEqual([]);
      expect(await ledger()).toEqual([]);
    };
    flags.advancesEnabled = false;
    expect(await approve(id)).toMatchObject({ ok: false, category: "disabled" });
    await stillWaiting();
    flags.advancesEnabled = true;
    flags.advancePayouts = { ...flags.advancePayouts, armed: false };
    expect(await approve(id)).toMatchObject({ ok: false, category: "not_armed" });
    await stillWaiting();
    flags.advancePayouts = { ...flags.advancePayouts, armed: true, capCents: 10_000 };
    expect(await approve(id)).toMatchObject({ ok: false, category: "over_cap" });
    await stillWaiting();
    flags.advancePayouts = { ...flags.advancePayouts, capCents: 50_000, startDate: "2026-11-03" };
    expect(await approve(id)).toMatchObject({ ok: false, category: "before_start" });
    await stillWaiting();
    flags.advancePayouts = { ...flags.advancePayouts, startDate: "2026-10-27" };
    flags.payoutsEnabled = false;
    expect(await approve(id)).toMatchObject({ ok: false, category: "payouts_off" });
    await stillWaiting();
    expect(mock.sendCount).toBe(0);
    // Still waiting, so Approve works once the switches open.
    flags.payoutsEnabled = true;
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(await proposalRow(id)).toMatchObject({ status: "done", decided_by: A.session.sub });
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "paid" })]);
    expect(mock.sendCount).toBe(1);
  });

  it("refuses a missing driver and unreadable pay rules before approving, and leaves the proposal waiting", async () => {
    const ghost = await addProposal({ driverId: randomUUID() });
    expect(await approve(ghost)).toEqual({ ok: false, category: "not_found", retryable: false });
    expect(await proposalRow(ghost)).toMatchObject({ status: "proposed", decided_by: null });

    // No pay rule version covers today: the rules cannot run, so nothing is approved.
    const setRulesFrom = (day: string) =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute("UPDATE pay_configs SET effective_from = CAST($1 AS date) WHERE tenant_id = current_tenant_id()", [day]),
      );
    await setRulesFrom("2027-01-04");
    const id = await addProposal();
    expect(await approve(id)).toEqual({ ok: false, category: "eligibility_unavailable", retryable: true });
    expect(await proposalRow(id)).toMatchObject({ status: "proposed", decided_by: null, money_action_id: null });
    expect(await flowAdvances()).toEqual([]);
    expect(await ledger()).toEqual([]);
    await setRulesFrom("2026-01-01");
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(mock.sendCount).toBe(1);
  });

  it("still re-checks the switches itself when one closes after the precheck, and resumes once it opens", async () => {
    const id = await addProposal();
    // Stands in for a switch turned off between the gate's precheck and the executor.
    const racing: ExecutorRegistry = {
      advance_payout: Object.assign((...args: Parameters<Executor>) => executeAdvanceProposal(...args), {
        precheck: async (...args: Parameters<typeof precheckAdvanceProposal>) => {
          const answer = await precheckAdvanceProposal(...args);
          flags.payoutsEnabled = false;
          return answer;
        },
      }),
    };
    expect(await approve(id, false, { ...deps(), executors: racing })).toEqual({
      ok: false,
      category: "payouts_off",
      retryable: false,
    });
    // The known window: the approval stands with nothing paid, and no advance or ledger row.
    expect(await proposalRow(id)).toMatchObject({ status: "approved", decided_by: A.session.sub, money_action_id: null });
    expect(await flowAdvances()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(mock.sendCount).toBe(0);
    // Approving again resumes it: still refused while the switch is off, paid once it opens.
    expect(await approve(id)).toMatchObject({ ok: false, category: "payouts_off" });
    flags.payoutsEnabled = true;
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(await ledger()).toHaveLength(1);
    expect(mock.sendCount).toBe(1);
  });

  it("checks only the advance whose page asked: another advance's unknown payout is left alone", async () => {
    const first = await addProposal();
    const second = await addProposal({ driverId: A.otherDriverId });
    mock.hangNext();
    expect(await approve(first, false, deps({ timeoutMs: 50 }))).toMatchObject({ ok: true, status: "executing" });
    mock.hangNext();
    expect(await approve(second, false, deps({ timeoutMs: 50 }))).toMatchObject({ ok: true, status: "executing" });
    const advances = await flowAdvances();
    expect(advances).toHaveLength(2);
    const byProposal = async (proposalId: string) =>
      (
        await admin.withTenant(A.tenantId, (q) =>
          q.query<{ id: string }>(
            "SELECT id FROM advances WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)",
            [proposalId],
          ),
        )
      )[0].id;
    const [firstAdvance, secondAdvance] = [await byProposal(first), await byProposal(second)];

    const checked = await checkAdvancePayouts(A.session, firstAdvance, deps());
    expect(checked).toMatchObject({ ok: true, summary: { checked: 1, confirmed: 1, failed: 0, stillUnknown: 0 } });
    const status = async (advanceId: string) =>
      (await flowAdvances()).find((a) => a.id === advanceId)?.status;
    expect(await status(firstAdvance)).toBe("paid");
    expect(await status(secondAdvance)).toBe("approved");
    expect((await ledger()).map((r) => r.state).sort()).toEqual(["confirmed", "unknown"]);

    expect(await checkAdvancePayouts(A.session, secondAdvance, deps())).toMatchObject({
      ok: true,
      summary: { checked: 1, confirmed: 1 },
    });
    expect(await status(secondAdvance)).toBe("paid");
    expect(mock.sendCount).toBe(2);
  });

  it("limits the QuickBooks leg's outside call to the request's time left, less a second", async () => {
    flags.accountingEnabled = true;
    const limits: number[] = [];
    const accounting = {
      system: "qbo_sandbox",
      ready: async () => ({ ok: true }),
      ensureVendor: async () => ({ outsideId: "V-77" }),
      createExpense: async (_q: unknown, e: { amountCents: number; feeCents: number }, ctx: { timeoutMs: number }) => {
        limits.push(ctx.timeoutMs);
        return { kind: "confirmed", system: "qbo_sandbox", type: "Purchase", id: `P-${limits.length}`, amountCents: e.amountCents + e.feeCents };
      },
    } as unknown as AccountingAdapter;
    // A steady clock: the request started at 0 and 9,500.5 ms have passed when the payout is
    // confirmed, so 15,499.5 ms are left and the post gets 14,499.
    const steadyAt = (...marks: number[]) => {
      let i = 0;
      return () => marks[Math.min(i++, marks.length - 1)];
    };
    const id = await addProposal();
    const d: AdvanceDeps = { ...deps({ accounting, timeoutMs: undefined }), steady: steadyAt(0, 9_500.5) };
    expect(await approve(id, false, d)).toMatchObject({ ok: true, status: "done" });
    expect(limits).toEqual([14_499]);

    // With the whole budget left, the money executor's own 20 s limit is the cap.
    const other = await addProposal({ driverId: A.otherDriverId });
    const full: AdvanceDeps = { ...deps({ accounting, timeoutMs: undefined }), steady: steadyAt(0, 0) };
    expect(await approve(other, false, full)).toMatchObject({ ok: true, status: "done" });
    expect(limits).toEqual([14_499, 20_000]);
  });

  it("needs the second confirm for a flagged proposal, and names the voice note it came from", async () => {
    const id = await addProposal({ flagged: true, requestRef: transcriptId });
    expect(await approve(id, false)).toMatchObject({ ok: false, category: "needs_confirm" });
    expect(await flowAdvances()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect((await proposalRow(id)).status).toBe("proposed");
    expect(await approve(id, true)).toMatchObject({ ok: true, status: "done" });
    expect(await flowAdvances()).toEqual([
      expect.objectContaining({ status: "paid", source: "voice", source_input_id: transcriptId }),
    ]);
  });

  it("holds a staff member to the admin line, for an approval and for a retry", async () => {
    flags.approverRole = { adminAboveCents: 20_000 };
    const id = await addProposal({ amountCents: 25_000 });
    expect(await approve(id)).toMatchObject({ ok: false, category: "role" });
    expect(await flowAdvances()).toEqual([]);
    await admin.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id()"),
    );
    mock.failNext("rate_limited");
    expect(await approve(id)).toMatchObject({ ok: false, category: "payout_failed" });
    await admin.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE memberships SET role = 'staff' WHERE tenant_id = current_tenant_id()"),
    );
    const [adv] = await flowAdvances();
    expect(await retryAdvancePayout(A.session, adv.id, deps())).toMatchObject({ ok: false, category: "role" });
    expect(await ledger()).toHaveLength(1);
  });

  it("shows another carrier nothing: no approval, no retry, no check and no record", async () => {
    const id = await addProposal();
    expect(await approve(id, false, deps(), B.session)).toMatchObject({ ok: false, category: "not_found" });
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    const [adv] = await flowAdvances();
    expect(await retryAdvancePayout(B.session, adv.id, deps())).toMatchObject({ ok: false, category: "not_found" });
    expect(await checkAdvancePayouts(B.session, adv.id, deps())).toMatchObject({ ok: false, category: "not_found" });
    expect(await postAdvanceExpense(B.session, adv.id, deps())).toMatchObject({ ok: false });
    expect(await app.withTenant(B.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()))).toBeNull();
    expect(await flowAdvances(B)).toEqual([]);
    expect(await ledger(B)).toEqual([]);
  });

  it("posts a paid advance to QuickBooks once, as the advance plus its fee", async () => {
    flags.accountingEnabled = true;
    const sent: { amountCents: number; feeCents: number; docRef: string }[] = [];
    const accounting = {
      system: "qbo_sandbox",
      ready: async () => ({ ok: true }),
      ensureVendor: async () => ({ outsideId: "V-77" }),
      createExpense: async (_q: unknown, e: { amountCents: number; feeCents: number; docRef: string }) => {
        sent.push({ amountCents: e.amountCents, feeCents: e.feeCents, docRef: e.docRef });
        return { kind: "confirmed", system: "qbo_sandbox", type: "Purchase", id: "P-9001", amountCents: e.amountCents + e.feeCents };
      },
    } as unknown as AccountingAdapter;
    const id = await addProposal();
    expect(await approve(id, false, deps({ accounting }))).toMatchObject({ ok: true, status: "done" });
    const [adv] = await flowAdvances();
    expect(sent).toEqual([{ amountCents: 25_000, feeCents: 500, docRef: adv.request_ref }]);
    expect(await ledger()).toEqual([
      expect.objectContaining({ kind: "advance_expense", state: "confirmed", amount_cents: "25500" }),
      expect.objectContaining({ kind: "advance_payout", state: "confirmed", amount_cents: "25000" }),
    ]);
    expect(await postAdvanceExpense(A.session, adv.id, deps({ accounting }))).toMatchObject({
      ok: false,
      category: "already_posted",
    });
    expect(sent).toHaveLength(1);
  });

  it("asks the payout gate again right before a retry pays, so a switch closed after its checks reserves nothing", async () => {
    const id = await addProposal();
    mock.failNext("rate_limited");
    expect(await approve(id)).toMatchObject({ ok: false, category: "payout_failed" });
    const [adv] = await flowAdvances();
    const closes: [() => void, string][] = [
      [() => { flags.advancePayouts = { ...flags.advancePayouts, armed: false }; }, "not_armed"],
      [() => { flags.advancePayouts = { ...flags.advancePayouts, capCents: 10_000 }; }, "over_cap"],
      // Nov 2 in the tenant's zone at the fixed clock, before this start date.
      [() => { flags.advancePayouts = { ...flags.advancePayouts, startDate: "2026-11-03" }; }, "before_start"],
    ];
    for (const [close, category] of closes) {
      expect(await retryAdvancePayout(A.session, adv.id, { ...deps(), db: closingAfterFirst(app, close) })).toEqual({
        ok: false,
        category,
        retryable: false,
      });
      expect(await ledger()).toEqual([expect.objectContaining({ state: "failed", attempt: 1 })]);
      openSwitches();
    }
    expect(mock.sendCount).toBe(1);
    expect(await retryAdvancePayout(A.session, adv.id, deps())).toMatchObject({ ok: true, status: "paid" });
    expect(mock.sendCount).toBe(2);
  });

  it("asks the payout gate again right before an approval pays, and a later approval resumes it", async () => {
    const id = await addProposal();
    const closing: ExecutorRegistry = {
      advance_payout: Object.assign(
        (...[db, ...rest]: Parameters<Executor>) =>
          executeAdvanceProposal(
            closingAfterFirst(db, () => {
              flags.advancePayouts = { ...flags.advancePayouts, armed: false };
            }),
            ...rest,
          ),
        { precheck: precheckAdvanceProposal },
      ),
    };
    expect(await approve(id, false, { ...deps(), executors: closing })).toEqual({
      ok: false,
      category: "not_armed",
      retryable: false,
    });
    // Nothing reserved and nothing sent: the advance waits as requested for a later approval.
    expect(await flowAdvances()).toEqual([expect.objectContaining({ status: "requested" })]);
    expect(await ledger()).toEqual([]);
    expect(mock.sendCount).toBe(0);
    openSwitches();
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    expect(await ledger()).toEqual([expect.objectContaining({ state: "confirmed", attempt: 1 })]);
    expect(mock.sendCount).toBe(1);
  });

  it("tells Check pending a payout sent under a minute ago is waiting, and reads it back once the window passes", async () => {
    const id = await addProposal();
    // The send's settle does not commit, so its row stays sent.
    let lose = true;
    const store: LedgerStore = {
      ...dbLedgerStore,
      settle: async (...args) => {
        if (lose) {
          lose = false;
          throw new Error("settle did not commit");
        }
        return dbLedgerStore.settle(...args);
      },
    };
    expect(await approve(id, false, deps({ store }))).toMatchObject({ ok: true, status: "executing" });
    const [adv] = await flowAdvances();
    expect(await ledger()).toEqual([expect.objectContaining({ kind: "advance_payout", state: "sent" })]);

    expect(await checkAdvancePayouts(A.session, adv.id, deps())).toEqual({
      ok: true,
      summary: expect.objectContaining({ checked: 0 }),
      tooNew: 1,
      stillWaiting: 0,
    });
    expect(await ledger()).toEqual([expect.objectContaining({ state: "sent" })]);

    // Once the window has passed (its length set to zero here), the pass reads it back as paid.
    const later: LedgerStore = {
      ...dbLedgerStore,
      readPending: (q, _olderThan, ...rest) => dbLedgerStore.readPending(q, 0, ...rest),
    };
    expect(await checkAdvancePayouts(A.session, adv.id, deps({ store: later }))).toEqual({
      ok: true,
      summary: expect.objectContaining({ checked: 1, confirmed: 1 }),
      tooNew: 0,
      stillWaiting: 0,
    });
    expect((await flowAdvances())[0]).toMatchObject({ status: "paid", paid: true });
    expect(mock.sendCount).toBe(1);
  });

  it("reports a payout whose row could not be read after the send as pending, and never retries it", async () => {
    const id = await addProposal();
    // After the payout is sent, the settle and the read of its row both fail.
    const lostRead: LedgerStore = {
      ...dbLedgerStore,
      settle: async (...args) => {
        if (mock.sendCount > 0) throw new Error("settle did not commit");
        return dbLedgerStore.settle(...args);
      },
      readAction: async (...args) => {
        if (mock.sendCount > 0) throw new Error("read failed");
        return dbLedgerStore.readAction(...args);
      },
    };
    expect(await approve(id, false, deps({ store: lostRead }))).toEqual({
      ok: false,
      category: "payout_pending",
      retryable: false,
    });
    expect(mock.sendCount).toBe(1);
    expect(await ledger()).toEqual([expect.objectContaining({ kind: "advance_payout", state: "sent" })]);
    const [adv] = await flowAdvances();
    expect(await retryAdvancePayout(A.session, adv.id, deps())).toMatchObject({ ok: false, category: "payout_pending" });
    expect(mock.sendCount).toBe(1);
  });

  it("reports a payout as pending when the read of a row another request is sending fails", async () => {
    const id = await addProposal();
    // Stands in for another request holding the send: the claim is lost, then the wait's read fails.
    const held: LedgerStore = {
      ...dbLedgerStore,
      markSent: async () => false,
      readAction: async () => {
        throw new Error("read failed");
      },
    };
    expect(await approve(id, false, deps({ store: held }))).toEqual({
      ok: false,
      category: "payout_pending",
      retryable: false,
    });
    expect(mock.sendCount).toBe(0);
    expect(await ledger()).toEqual([expect.objectContaining({ kind: "advance_payout", state: "reserved" })]);
  });

  it("reports a QuickBooks post whose row could not be read after the send as pending, never as nothing written", async () => {
    const id = await addProposal();
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    const [adv] = await flowAdvances();
    flags.accountingEnabled = true;
    const qbo = countingAccounting();
    // After the purchase is made, the settle and the read of its row both fail.
    const lostRead: LedgerStore = {
      ...dbLedgerStore,
      settle: async (...args) => {
        if (qbo.created() > 0) throw new Error("settle did not commit");
        return dbLedgerStore.settle(...args);
      },
      readAction: async (...args) => {
        if (qbo.created() > 0) throw new Error("read failed");
        return dbLedgerStore.readAction(...args);
      },
    };
    expect(await postAdvanceExpense(A.session, adv.id, deps({ accounting: qbo.adapter, store: lostRead }))).toEqual({
      ok: false,
      category: "post_pending",
      retryable: false,
    });
    expect(qbo.created()).toBe(1);
    expect(await ledger()).toContainEqual(expect.objectContaining({ kind: "advance_expense", state: "sent" }));
    // Never posted twice: the page's next press finds the post pending.
    expect(await postAdvanceExpense(A.session, adv.id, deps({ accounting: qbo.adapter }))).toMatchObject({
      ok: false,
      category: "post_pending",
    });
    expect(qbo.created()).toBe(1);
  });

  it("reports a QuickBooks post as pending when the read of a row another request is sending fails", async () => {
    const id = await addProposal();
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    const [adv] = await flowAdvances();
    flags.accountingEnabled = true;
    const qbo = countingAccounting();
    // Stands in for another request holding the send: the claim is lost, then the wait's read fails.
    const held: LedgerStore = {
      ...dbLedgerStore,
      markSent: async () => false,
      readAction: async () => {
        throw new Error("read failed");
      },
    };
    expect(await postAdvanceExpense(A.session, adv.id, deps({ accounting: qbo.adapter, store: held }))).toEqual({
      ok: false,
      category: "post_pending",
      retryable: false,
    });
    expect(qbo.created()).toBe(0);
  });

  it("counts a tenant's advance proposals per local day for the gateway's daily ceiling", async () => {
    // 05:30 UTC on Nov 2 is still Nov 1 in Chicago; 06:30 UTC is Nov 2.
    await addProposal({ createdAt: "2026-11-02T05:30:00.000Z" });
    await addProposal({ createdAt: "2026-11-02T06:30:00.000Z", driverId: A.otherDriverId });
    const count = (at: string, f: Fixture = A) =>
      app.withTenant(f.tenantId, async (q) => Number((await q.query<{ n: number }>(DAILY_CAP_SQL, [at]))[0].n));
    expect(await count(new Date(NOW).toISOString())).toBe(1);
    expect(await count("2026-11-02T05:00:00.000Z")).toBe(1);
    expect(await count(new Date(NOW).toISOString(), B)).toBe(0);
  });

  it("holds migration 0011's rules: one advance per proposal, own-tenant references, voice, no seeded flow rows", async () => {
    const id = await addProposal();
    expect(await approve(id)).toMatchObject({ ok: true });
    const insert = (f: Fixture, o: { proposalId?: string | null; source?: string; inputId?: string | null; decided?: boolean }) =>
      admin.withTenant(f.tenantId, (q) =>
        q.execute(
          `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on, amount_cents,
             status, source, proposal_id, source_input_id, decided_at, decided_by_membership_id)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST('2026-11-02T15:00:00Z' AS timestamptz),
             CAST('2026-11-02' AS date), 10000, 'requested', $4, CAST($5 AS uuid), CAST($6 AS uuid),
             CAST($7 AS timestamptz), CAST($8 AS uuid))`,
          [
            randomUUID(),
            f.driverId,
            `T-${randomUUID().slice(0, 8)}`,
            o.source ?? "ui",
            o.proposalId ?? null,
            o.inputId ?? null,
            o.decided === undefined ? null : "2026-11-02T15:00:00Z",
            o.decided === true ? f.memberId : null,
          ],
        ),
      );
    expect(await sqlStateOf(insert(A, { proposalId: id }))).toBe("23505");
    expect(await sqlStateOf(insert(B, { proposalId: id }))).toBe("23503");
    expect(await sqlStateOf(insert(B, { inputId: transcriptId }))).toBe("23503");
    expect(await sqlStateOf(insert(A, { source: "voice", inputId: transcriptId }))).toBe("no error");
    const other = await addProposal({ driverId: A.otherDriverId });
    expect(await sqlStateOf(insert(A, { source: "seed", proposalId: other }))).toBe("23514");
    expect(await sqlStateOf(insert(A, { decided: false }))).toBe("23514");
    // A proposal a flow advance names cannot be deleted.
    await clearLedger(admin, A);
    expect(
      await sqlStateOf(
        admin.withTenant(A.tenantId, (q) =>
          q.execute("DELETE FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]),
        ),
      ),
    ).toBe("23503");
  });
  describe("on the fuel-card rail (simulated provider, test mode)", () => {
    const sim = () => createFuelCardSimAdapter({ log: () => {} });

    it("loads the advance onto the driver's active card, records the card, and the record shows its last four", async () => {
      const id = await addProposal();
      expect(await approve(id, false, deps({ payment: sim() }))).toMatchObject({ ok: true, status: "done" });
      const [adv] = await flowAdvances();
      expect(adv).toMatchObject({ status: "paid", paid: true });
      const card = await activeCard(A.driverId);
      expect(await advanceCard(adv.id)).toBe(card.id);
      const [row] = await payouts();
      expect(row).toMatchObject({ state: "confirmed", attempt: 1, outside_system: "fuel_card_sim" });
      expect(row.outside_id).toBe(loadId(row.request_id));
      const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
      expect(record?.card).toEqual({ last4: card.last4, status: "active", recorded: true });
      expect(record?.ledger).toEqual([expect.objectContaining({ outsideSystem: "fuel_card_sim", state: "confirmed" })]);
    });

    it("marks the driver's active card as not recorded when the advance recorded none, and names none once no card is on file", async () => {
      const id = await addAdvance(admin, A);
      expect(await advanceCard(id)).toBeNull();
      const card = await activeCard(A.driverId);
      const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, id, clock()));
      expect(record?.card).toEqual({ last4: card.last4, status: "active", recorded: false });
      await removeCards(admin, A, A.driverId);
      const none = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, id, clock()));
      expect(none?.card).toBeNull();
    });

    it("lists a paid advance's own card even once closed, no card for a paid one that recorded none, and the card on file for an unpaid one", async () => {
      const id = await addProposal();
      expect(await approve(id, false, deps({ payment: sim() }))).toMatchObject({ ok: true, status: "done" });
      const [paid] = await flowAdvances();
      const paidTo = await activeCard(A.driverId);
      await closeCard(admin, A, A.driverId);
      await addCard(admin, A, A.driverId);
      const onFile = await activeCard(A.driverId);
      // Seeded history: paid, but no card recorded.
      const cardless = await addAdvance(admin, A);
      await admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `UPDATE advances SET status = 'paid', paid_at = CAST('2026-11-02T16:00:00Z' AS timestamptz)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [cardless],
        ),
      );
      const unpaid = await addAdvance(admin, A);
      // Never paid: a rejected one that recorded the active card, and a cancelled one with none.
      const rejected = await addAdvance(admin, A);
      const cancelled = await addAdvance(admin, A);
      await admin.withTenant(A.tenantId, async (q) => {
        await q.execute(
          `UPDATE advances SET status = 'rejected', card_id = CAST($2 AS uuid)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [rejected, onFile.id],
        );
        await q.execute(
          "UPDATE advances SET status = 'cancelled' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
          [cancelled],
        );
      });

      const rows = await app.withTenant(A.tenantId, (q) => readAdvanceList(q, null));
      const lineOf = (advanceId: string) => rows.find((r) => r.id === advanceId)?.cardLine;
      expect(lineOf(paid.id)).toEqual({ label: "Paid to", card: { last4: paidTo.last4, status: "closed" } });
      expect(lineOf(cardless)).toBeNull();
      expect(lineOf(unpaid)).toEqual({ label: "Card on file", card: { last4: onFile.last4, status: "active" } });
      expect(lineOf(rejected)).toBeNull();
      expect(lineOf(cancelled)).toBeNull();
      expect(rows.map((r) => r.id).sort()).toEqual([paid.id, cardless, unpaid, rejected, cancelled].sort());
      // The record page names no card for either one.
      for (const never of [rejected, cancelled]) {
        const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, never, clock()));
        expect(record?.advance.id).toBe(never);
        expect(record?.card).toBeNull();
        expect(cardLineFor(record?.advance.status ?? "", record?.card ?? null)).toBeNull();
      }
    });

    it("names a proposal's card by its state: a done payout's recorded card once replaced, the card on file once approved, none once rejected", async () => {
      const turnOf = async (proposalId: string) =>
        (
          await admin.withTenant(A.tenantId, (q) =>
            q.query<{ turn_id: string }>(
              "SELECT CAST(turn_id AS text) AS turn_id FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
              [proposalId],
            ),
          )
        )[0].turn_id;
      const destinationOf = async (proposalId: string) => {
        const turnId = await turnOf(proposalId);
        const view = await app.withTenant(A.tenantId, (q) => readTurnView(q, A.session.sub, turnId));
        const found = view?.proposals.find((p) => p.id === proposalId);
        expect(found).toBeDefined();
        return found?.destination;
      };
      const decide = (proposalId: string, status: "approved" | "rejected") =>
        admin.withTenant(A.tenantId, (q) =>
          q.execute(
            `UPDATE proposals SET status = $2, decided_by = $3,
                    decided_at = CAST('2026-11-02T16:00:00Z' AS timestamptz)
              WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'proposed'`,
            [proposalId, status, A.session.sub],
          ),
        );

      // Done, then the card it paid is replaced: the proposal still names the card it paid.
      const done = await addProposal();
      expect(await approve(done, false, deps({ payment: sim() }))).toMatchObject({ ok: true, status: "done" });
      const paidTo = await activeCard(A.driverId);
      expect(await destinationOf(done)).toEqual({ label: `fuel card ···· ${paidTo.last4}`, last4: paidTo.last4, testMode: true });
      await closeCard(admin, A, A.driverId);
      await addCard(admin, A, A.driverId);
      const onFile = await activeCard(A.driverId);
      expect(await destinationOf(done)).toEqual({ label: `fuel card ···· ${paidTo.last4}`, last4: paidTo.last4, testMode: true });

      // Rejected: no destination at all.
      const rejected = await addProposal();
      expect(await decide(rejected, "rejected")).toBe(1);
      expect(await destinationOf(rejected)).toBeNull();

      // Approved and not yet paid: the card on file now.
      const approved = await addProposal();
      expect(await destinationOf(approved)).toEqual({ label: `fuel card ···· ${onFile.last4}`, last4: onFile.last4, testMode: true });
      expect(await decide(approved, "approved")).toBe(1);
      expect(await destinationOf(approved)).toEqual({ label: `fuel card ···· ${onFile.last4}`, last4: onFile.last4, testMode: true });
    });

    it("refuses a driver with no card on file before approving, and leaves the proposal waiting", async () => {
      await removeCards(admin, A, A.driverId);
      const id = await addProposal();
      expect(await approve(id, false, deps({ payment: sim() }))).toEqual({ ok: false, category: "no_card", retryable: false });
      expect(await proposalRow(id)).toMatchObject({ status: "proposed", decided_by: null, money_action_id: null });
      expect(await flowAdvances()).toEqual([]);
      expect(await ledger()).toEqual([]);
      await addCard(admin, A, A.driverId);
      expect(await approve(id, false, deps({ payment: sim() }))).toMatchObject({ ok: true, status: "done" });
    });

    it("leaves a declined load failed and the advance approved; Retry pays the new active card as attempt 2", async () => {
      await setCardBehavior(admin, A, A.driverId, "declined");
      const declined = await activeCard(A.driverId);
      const id = await addProposal();
      expect(await approve(id, false, deps({ payment: sim() }))).toEqual({ ok: false, category: "payout_failed", retryable: true });
      const [adv] = await flowAdvances();
      expect(adv.status).toBe("approved");
      expect(await payouts()).toEqual([
        expect.objectContaining({ state: "failed", attempt: 1, failure_category: "declined", outside_id: null }),
      ]);
      expect((await proposalRow(id)).status).toBe("failed");
      expect(await advanceCard(adv.id)).toBe(declined.id);
      const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
      expect(record?.actions).toEqual({ retry: true, check: false, post: false, takeBack: false });

      // With the declined card closed and none active, Retry refuses before the ledger.
      await closeCard(admin, A, A.driverId);
      expect(await retryAdvancePayout(A.session, adv.id, deps({ payment: sim() }))).toMatchObject({
        ok: false,
        category: "no_card",
      });
      expect(await payouts()).toHaveLength(1);
      // The unpaid advance no longer names its closed card: none is on file, then the new one is.
      const closedOut = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
      expect(closedOut?.card).toBeNull();
      const fresh = await addCard(admin, A, A.driverId, "ok");
      const freshCard = await activeCard(A.driverId);
      const onFile = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
      expect(onFile?.card).toEqual({ last4: freshCard.last4, status: "active", recorded: false });
      expect(await retryAdvancePayout(A.session, adv.id, deps({ payment: sim() }))).toMatchObject({ ok: true, status: "paid" });
      expect(await payouts()).toEqual([
        expect.objectContaining({ state: "failed", attempt: 1, failure_category: "declined" }),
        expect.objectContaining({ state: "confirmed", attempt: 2, outside_system: "fuel_card_sim" }),
      ]);
      expect(await advanceCard(adv.id)).toBe(fresh);
      const after = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
      expect(after?.card).toEqual({ last4: freshCard.last4, status: "active", recorded: true });
    });

    it("keeps a slow load unknown, then Check pending reads it back as paid and the QuickBooks post follows", async () => {
      await setCardBehavior(admin, A, A.driverId, "slow");
      const id = await addProposal();
      expect(await approve(id, false, deps({ payment: sim() }))).toMatchObject({ ok: true, status: "executing" });
      const [adv] = await flowAdvances();
      expect(adv.status).toBe("approved");
      expect(await payouts()).toEqual([expect.objectContaining({ state: "unknown", failure_category: "timeout" })]);
      expect(await retryAdvancePayout(A.session, adv.id, deps({ payment: sim() }))).toMatchObject({
        ok: false,
        category: "payout_pending",
      });

      expect(await checkAdvancePayouts(A.session, adv.id, deps({ payment: sim() }))).toMatchObject({
        ok: true,
        summary: { checked: 1, confirmed: 1 },
      });
      expect((await flowAdvances())[0]).toMatchObject({ status: "paid", paid: true });
      const [row] = await payouts();
      expect(row).toMatchObject({ state: "confirmed", outside_system: "fuel_card_sim", check_count: 1 });
      expect(row.outside_id).toBe(loadId(row.request_id));
      expect((await proposalRow(id)).status).toBe("done");

      flags.accountingEnabled = true;
      const qbo = countingAccounting();
      expect(await postAdvanceExpense(A.session, adv.id, deps({ payment: sim(), accounting: qbo.adapter }))).toMatchObject({
        ok: true,
        status: "posted",
      });
      expect(qbo.created()).toBe(1);
    });

    it("keeps an offline load unknown after a check, with one check counted", async () => {
      await setCardBehavior(admin, A, A.driverId, "offline");
      const id = await addProposal();
      expect(await approve(id, false, deps({ payment: sim() }))).toMatchObject({ ok: true, status: "executing" });
      const [adv] = await flowAdvances();
      expect(await checkAdvancePayouts(A.session, adv.id, deps({ payment: sim() }))).toMatchObject({
        ok: true,
        summary: { checked: 1, stillUnknown: 1, confirmed: 0 },
      });
      expect(await payouts()).toEqual([
        expect.objectContaining({ state: "unknown", failure_category: "unavailable", check_count: 1 }),
      ]);
      expect((await flowAdvances())[0].status).toBe("approved");
    });

    it("makes one load and one ledger row when two approvals race", async () => {
      const id = await addProposal();
      const shared = sim();
      const results = await Promise.all([
        approve(id, false, deps({ payment: shared })),
        approve(id, false, deps({ payment: shared })),
      ]);
      expect(results.filter((r) => r.ok)).not.toHaveLength(0);
      const rows = await payouts();
      expect(rows).toEqual([expect.objectContaining({ state: "confirmed", attempt: 1 })]);
      expect(new Set(rows.map((r) => r.outside_id)).size).toBe(1);
      expect((await flowAdvances())[0].status).toBe("paid");
    });

    it("skips a payout in a reconcile pass that has no destination hook, never guessing the card", async () => {
      await setCardBehavior(admin, A, A.driverId, "slow");
      const id = await addProposal();
      expect(await approve(id, false, deps({ payment: sim() }))).toMatchObject({ ok: true, status: "executing" });
      const { destination: _destination, ...noCard } = payoutReconcileHooks;
      void _destination;
      const summary = await reconcileMoneyActions(
        app,
        A.session,
        { hooks: { advance_payout: noCard }, olderThanSeconds: 0 },
        { payment: sim(), log: () => {} },
      );
      expect(summary).toEqual({ checked: 0, confirmed: 0, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 });
      expect(await payouts()).toEqual([expect.objectContaining({ state: "unknown", check_count: 0 })]);
      expect((await flowAdvances())[0].status).toBe("approved");
    });
  });

  describe("with 0027: arming, a named card, a load and a take-back", () => {
    const sim = () => createFuelCardSimAdapter({ log: () => {} });
    // Read at call time: the databases open in beforeAll.
    const services = () => ({ db: app, clock });

    // The fixture's member made an admin (the fixture makes staff).
    const makeAdmin = () =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
          A.memberId,
        ]),
      );
    // addPayRules' loads: L-1 is the driver's, L-2 the other driver's.
    const loadOf = async (number: string) =>
      (
        await admin.withTenant(A.tenantId, (q) =>
          q.query<{ id: string }>(
            "SELECT CAST(id AS text) AS id FROM loads WHERE tenant_id = current_tenant_id() AND load_number = $1",
            [number],
          ),
        )
      )[0].id;
    const setLoadCap = (bps: number | null) =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute("UPDATE pay_configs SET advance_per_load_bps_of_pay = $1 WHERE tenant_id = current_tenant_id()", [bps]),
      );
    const advanceRow = async (id: string) =>
      (
        await admin.withTenant(A.tenantId, (q) =>
          q.query<{
            status: string;
            load_id: string | null;
            taken_back_cents: string;
            taken_back_by: string | null;
            takeback_reason: string | null;
          }>(
            `SELECT status, CAST(load_id AS text) AS load_id, CAST(taken_back_cents AS text) AS taken_back_cents,
                    CAST(taken_back_by_membership_id AS text) AS taken_back_by, takeback_reason
               FROM advances WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
            [id],
          ),
        )
      )[0];
    // A refused proposal stays waiting, and a driver has one live proposal at a time: this one is
    // expired so the next can be made.
    const expire = (id: string) =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `UPDATE proposals SET status = 'expired', decided_by = 'test-expiry',
                  decided_at = CAST('2026-11-02T16:00:00Z' AS timestamptz)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [id],
        ),
      );
    const suggestion = async (driverId: string, loadId: string | null, as: Fixture = A) =>
      app.withTenant(as.tenantId, (q) => readDeskSuggestion(q, driverId, loadId, clock()));

    it("refuses a driver who is not armed before approving, and pays once an admin arms them", async () => {
      await setArmed(admin, A, A.driverId, false);
      const id = await addProposal();
      expect(await approve(id)).toMatchObject({ ok: false, category: "driver_not_armed" });
      expect(await proposalRow(id)).toMatchObject({ status: "proposed", decided_by: null, money_action_id: null });
      expect(await flowAdvances()).toEqual([]);
      expect(await ledger()).toEqual([]);
      // Only an admin arms a driver (D-034).
      expect(await armDriver(A.session, A.driverId, { armed: true }, services())).toEqual({
        ok: false,
        category: "role",
        retryable: false,
      });
      await makeAdmin();
      expect(await armDriver(A.session, A.driverId, { armed: true }, services())).toMatchObject({ ok: true, changed: true });
      expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
      expect(mock.sendCount).toBe(1);
    });

    it("asks again at a retry: a driver disarmed after a failed payout is paid only once armed again", async () => {
      await makeAdmin();
      const id = await addProposal();
      mock.failNext("rate_limited");
      expect(await approve(id)).toMatchObject({ ok: false, category: "payout_failed" });
      const [adv] = await flowAdvances();
      await armDriver(A.session, A.driverId, { armed: false }, services());
      expect(await retryAdvancePayout(A.session, adv.id, deps())).toMatchObject({ ok: false, category: "driver_not_armed" });
      expect(await ledger()).toEqual([expect.objectContaining({ state: "failed", attempt: 1 })]);
      await armDriver(A.session, A.driverId, { armed: true }, services());
      expect(await retryAdvancePayout(A.session, adv.id, deps())).toMatchObject({ ok: true, status: "paid" });
      expect(mock.sendCount).toBe(2);
    });

    it("pays the card the proposal names, never the default in its place, and refuses one that is not the driver's", async () => {
      await makeAdmin();
      const added = await addDriverCard(
        A.session,
        A.driverId,
        { last4: "7788", holderKind: "generic", portalName: "pool card 3", makeDefault: false },
        services(),
      );
      expect(added).toMatchObject({ ok: true, changed: true });
      const generic = (added as { id: string }).id;
      const theirs = (await activeCard(A.otherDriverId)).id;
      const wrong = await addProposal({ cardId: theirs });
      expect(await approve(wrong, false, deps({ payment: sim() }))).toMatchObject({ ok: false, category: "card_not_drivers" });
      expect(await proposalRow(wrong)).toMatchObject({ status: "proposed", money_action_id: null });
      await expire(wrong);

      const id = await addProposal({ cardId: generic, amountCents: 20_000 });
      expect(await approve(id, false, deps({ payment: sim() }))).toMatchObject({ ok: true, status: "done" });
      const [adv] = await flowAdvances();
      expect(await advanceCard(adv.id)).toBe(generic);
      const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
      expect(record?.card).toEqual({ last4: "7788", status: "active", recorded: true });

      // Once that card is closed, a proposal naming it is refused rather than paid to the default.
      expect(await closeDriverCard(A.session, A.driverId, generic, services())).toMatchObject({ ok: true, changed: true });
      const closed = await addProposal({ cardId: generic, amountCents: 10_000 });
      expect(await approve(closed, false, deps({ payment: sim() }))).toMatchObject({ ok: false, category: "card_not_drivers" });
      expect(await payouts()).toHaveLength(1);
    });

    it("records the load an advance is for, and never pays past what is left under the load's cap", async () => {
      // With parking off it fails stale; parked.db.test.ts covers the same approval with parking on.
      flags.advanceParking.enabled = false;
      // A quarter of the load's $1,200.00 pay: a $300.00 cap.
      await setLoadCap(2_500);
      const [mine, theirs] = [await loadOf("L-1"), await loadOf("L-2")];
      const notHis = await addProposal({ loadId: theirs, amountCents: 10_000 });
      expect(await approve(notHis)).toMatchObject({ ok: false, category: "load_not_drivers" });
      expect(await proposalRow(notHis)).toMatchObject({ status: "proposed" });
      await expire(notHis);

      const first = await addProposal({ loadId: mine, amountCents: 15_000 });
      expect(await approve(first)).toMatchObject({ ok: true, status: "done" });
      const [adv] = await flowAdvances();
      expect(await advanceRow(adv.id)).toMatchObject({ status: "paid", load_id: mine });

      // $155.00 is open on the load, so $145.00 is left: $160.00 and its $5.00 fee do not fit.
      const second = await addProposal({ loadId: mine, amountCents: 16_000 });
      expect(await approve(second)).toEqual({ ok: false, category: "stale_eligibility", retryable: false });
      expect(await proposalRow(second)).toMatchObject({ status: "failed", decision_note: "stale_eligibility: over_load_cap" });
      expect(await flowAdvances()).toHaveLength(1);
      expect(mock.sendCount).toBe(1);
    });

    it("refuses as stale an advance on a load cancelled since, before the approval and after it, paying nothing", async () => {
      const mine = await loadOf("L-1");
      const cancelLoad = () =>
        admin.withTenant(A.tenantId, (q) =>
          q.execute("UPDATE loads SET status = 'cancelled' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [mine]),
        );
      // Cancelled between the approval and the payout: the executor asks again and pays nothing.
      const before = await addProposal({ loadId: mine, amountCents: 10_000 });
      const cancelling: ExecutorRegistry = {
        advance_payout: Object.assign(
          async (...args: Parameters<Executor>) => {
            await cancelLoad();
            return executeAdvanceProposal(...args);
          },
          { precheck: precheckAdvanceProposal },
        ),
      };
      expect(await approve(before, false, { ...deps(), executors: cancelling })).toEqual({
        ok: false,
        category: "stale",
        retryable: false,
      });
      expect(await proposalRow(before)).toMatchObject({ status: "approved" });
      expect(await flowAdvances()).toEqual([]);
      // Pressed again, the gate's precheck is not asked on a resume; the executor still refuses.
      expect(await approve(before)).toEqual({ ok: false, category: "stale", retryable: false });
      await admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `UPDATE proposals SET status = 'failed', decision_note = 'test'
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [before],
        ),
      );

      // Already cancelled: the precheck refuses, and the card stays proposed.
      const after = await addProposal({ loadId: mine, amountCents: 10_000 });
      expect(await approve(after)).toEqual({ ok: false, category: "stale", retryable: false });
      expect(await proposalRow(after)).toMatchObject({ status: "proposed", decided_by: null });
      expect(await flowAdvances()).toEqual([]);
      expect(mock.sendCount).toBe(0);
    });

    it("gives the desk the driver's loads of the last 45 days in the carrier's zone, and the engine's suggestion", async () => {
      const mine = await loadOf("L-1");
      const loads = (at: string, as: Fixture = A) => app.withTenant(as.tenantId, (q) => readDeskLoads(q, A.driverId, new Date(at)));
      expect(await loads("2026-11-02T16:00:00Z")).toEqual([{ id: mine, number: "L-1", deliveredOn: "2026-10-30" }]);
      // 03:00 UTC on the 30th is still the 29th in Chicago: not delivered there yet.
      expect(await loads("2026-10-30T03:00:00Z")).toEqual([]);
      // 45 days: the 13th of December still shows it, the 14th does not.
      expect(await loads("2026-12-13T16:00:00Z")).toHaveLength(1);
      expect(await loads("2026-12-14T16:00:00Z")).toEqual([]);
      expect(await loads("2026-11-02T16:00:00Z", B)).toEqual([]);

      expect(await suggestion(A.driverId, null)).toEqual({
        armed: true,
        maxCents: 60_000,
        suggestedCents: 60_000,
        feeCents: 500,
        load: null,
      });
      await setLoadCap(2_500);
      expect(await suggestion(A.driverId, mine)).toEqual({
        armed: true,
        maxCents: 29_500,
        suggestedCents: 29_500,
        feeCents: 500,
        load: { capCents: 30_000, openOnLoadCents: 0, headroomCents: 30_000 },
      });
      expect(await suggestion(A.driverId, await loadOf("L-2"))).toBe("load_not_drivers");
      expect(await suggestion(A.driverId, null, B)).toBe("not_found");
      await setArmed(admin, A, A.driverId, false);
      expect(await suggestion(A.driverId, null)).toMatchObject({ armed: false, maxCents: 0, suggestedCents: 0 });

      // A newer load whose number the desk's sentence would refuse (lower case, a dot) is never
      // offered, so the form cannot pick a load the request then turns away.
      await admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
             origin_state, dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles,
             linehaul_cents)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'l-9.b', CAST($2 AS uuid), CAST($3 AS uuid),
             'delivered', 'Springfield', 'IL', 'Dallas', 'TX', CAST('2026-10-30' AS date),
             CAST('2026-10-31' AS date), CAST('2026-10-31T20:00:00Z' AS timestamptz), 0, 0)`,
          [randomUUID(), A.customerId, A.driverId],
        ),
      );
      expect(await loads("2026-11-02T16:00:00Z")).toEqual([{ id: mine, number: "L-1", deliveredOn: "2026-10-30" }]);
    });

    it("records a take-back on a paid advance once, lowers what is owed, and sends nothing to the card", async () => {
      flags.advanceTakeback = { enabled: true, maxCents: 100_000 };
      const id = await addProposal();
      expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
      const [adv] = await flowAdvances();
      const before = (await suggestion(A.driverId, null)) as DeskSuggestion;
      const take = (amountCents: number) => takeBackAdvance(A.session, adv.id, { amountCents, reason: "duplicate" }, services());

      // $250.00 plus the $5.00 fee is owed.
      expect(await take(25_501)).toEqual({ ok: false, category: "over_bound", retryable: false });
      expect(await take(20_000)).toEqual({ ok: true, changed: true, status: "paid", takenBackCents: 20_000 });
      expect(await take(20_000)).toEqual({ ok: true, changed: false, status: "paid", takenBackCents: 20_000 });
      expect(await take(5_000)).toEqual({ ok: false, category: "already_taken_back", retryable: false });

      expect(await advanceRow(adv.id)).toEqual({
        status: "paid",
        load_id: null,
        taken_back_cents: "20000",
        taken_back_by: A.memberId,
        takeback_reason: "duplicate",
      });
      const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
      expect(record?.takeback).toEqual({ cents: 20_000, at: new Date(NOW).toISOString(), reason: "duplicate" });
      expect(record?.actions.takeBack).toBe(false);
      const after = (await suggestion(A.driverId, null)) as DeskSuggestion;
      expect(after.maxCents - before.maxCents).toBe(20_000);
      expect(await ledger()).toEqual([expect.objectContaining({ kind: "advance_payout", state: "confirmed", attempt: 1 })]);
      expect(mock.sendCount).toBe(1);
    });

    it("refuses in the database a recovery and a take-back that together pass what was lent, by one cent", async () => {
      const id = await addProposal();
      expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
      const [adv] = await flowAdvances();
      const [{ lent }] = await admin.withTenant(A.tenantId, (q) =>
        q.query<{ lent: string }>(
          `SELECT CAST(amount_cents + fee_cents AS text) AS lent FROM advances
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [adv.id],
        ),
      );
      // $250.00 plus the $5.00 fee.
      expect(Number(lent)).toBe(25_500);
      const takenBack = 20_000;
      // Each amount alone stays within what was lent, so only the combined bound can refuse it.
      const set = (recoveredCents: number) =>
        admin.withTenant(A.tenantId, (q) =>
          q.execute(
            `UPDATE advances
                SET recovered_cents = $2, taken_back_cents = $3,
                    taken_back_at = CAST('2026-11-02T16:00:00Z' AS timestamptz),
                    taken_back_by_membership_id = CAST($4 AS uuid), takeback_reason = 'duplicate'
              WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
            [adv.id, recoveredCents, takenBack, A.memberId],
          ),
        );
      expect(await sqlStateOf(set(Number(lent) - takenBack + 1))).toBe("23514");
      expect(await advanceRow(adv.id)).toMatchObject({ taken_back_cents: "0", taken_back_by: null });
      expect(await sqlStateOf(set(Number(lent) - takenBack))).toBe("no error");
      expect(await advanceRow(adv.id)).toMatchObject({ taken_back_cents: "20000", taken_back_by: A.memberId });
    });

    it("cancels an advance nothing was paid on, and refuses one whose payout may have moved money", async () => {
      flags.advanceTakeback = { enabled: true, maxCents: 100_000 };
      const unpaid = await addAdvance(admin, A, 25_000, "approved");
      const cancel = (advanceId: string) =>
        takeBackAdvance(A.session, advanceId, { amountCents: 0, reason: "wrong_driver" }, services());
      expect(await cancel(unpaid)).toEqual({ ok: true, changed: true, status: "cancelled", takenBackCents: 0 });
      expect(await cancel(unpaid)).toEqual({ ok: true, changed: false, status: "cancelled", takenBackCents: 0 });
      expect(await advanceRow(unpaid)).toMatchObject({ status: "cancelled", taken_back_cents: "0", taken_back_by: A.memberId });

      const id = await addProposal();
      mock.hangNext();
      expect(await approve(id, false, deps({ timeoutMs: 50 }))).toMatchObject({ ok: true, status: "executing" });
      const [adv] = await flowAdvances();
      expect(await cancel(adv.id)).toEqual({ ok: false, category: "not_takeable", retryable: false });
      expect(await advanceRow(adv.id)).toMatchObject({ status: "approved", taken_back_by: null });
    });

    it("ends the approval when a take-back cancels a flow advance its payout never reached, and nothing is paid after", async () => {
      flags.advanceTakeback = { enabled: true, maxCents: 100_000 };
      const id = await addProposal();
      const notReady: PaymentAdapter = { ...mock, system: "mock", ready: async () => ({ ok: false, category: "not_configured" }) };
      expect(await approve(id, false, deps({ payment: notReady }))).toEqual({ ok: false, category: "unavailable", retryable: true });
      const [adv] = await flowAdvances();
      expect(adv.status).toBe("requested");
      expect(await proposalRow(id)).toMatchObject({ status: "executing", money_action_id: null });
      expect(await ledger()).toEqual([]);

      expect(await takeBackAdvance(A.session, adv.id, { amountCents: 0, reason: "wrong_driver" }, services())).toEqual({
        ok: true,
        changed: true,
        status: "cancelled",
        takenBackCents: 0,
      });
      expect(await proposalRow(id)).toMatchObject({ status: "failed", decision_note: "advance_cancelled", money_action_id: null });

      // Resume and retry both refuse it cleanly; nothing is reserved or sent.
      expect(await approve(id)).toMatchObject({ ok: false, category: "already_decided" });
      expect(await retryAdvancePayout(A.session, adv.id, deps())).toEqual({
        ok: false,
        category: "not_retryable",
        retryable: false,
      });
      expect(await flowAdvances()).toEqual([expect.objectContaining({ id: adv.id, status: "cancelled", paid: false })]);
      expect(await ledger()).toEqual([]);
      expect(mock.sendCount).toBe(0);

      // The record and the agent's card both show it ended, unpaid, with nothing left to press.
      const record = await app.withTenant(A.tenantId, (q) => readAdvanceRecord(q, adv.id, clock()));
      expect(record?.proposal).toMatchObject({ status: "failed", decisionNote: "advance_cancelled" });
      expect(decisionNoteSentence(record?.proposal?.decisionNote ?? null)).toBe(
        "The advance was taken back before any money moved, so nothing was paid.",
      );
      expect(record?.actions).toEqual({ retry: false, check: false, post: false, takeBack: false });
      const turnId = (
        await admin.withTenant(A.tenantId, (q) =>
          q.query<{ turn_id: string }>(
            "SELECT CAST(turn_id AS text) AS turn_id FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
            [id],
          ),
        )
      )[0].turn_id;
      const view = await app.withTenant(A.tenantId, (q) => readTurnView(q, A.session.sub, turnId));
      expect(view?.proposals.find((p) => p.id === id)?.status).toBe("failed");
    });

    it("asks its own switch, the admin line, the reason and the carrier before recording anything", async () => {
      const id = await addProposal();
      expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
      const [adv] = await flowAdvances();
      const take = (session = A.session, reason = "duplicate") =>
        takeBackAdvance(session, adv.id, { amountCents: 20_000, reason }, services());

      expect(await take()).toEqual({ ok: false, category: "disabled", retryable: false });
      flags.advanceTakeback = { enabled: true, maxCents: 100_000 };
      flags.advancesEnabled = false;
      expect(await take()).toEqual({ ok: false, category: "disabled", retryable: false });
      flags.advancesEnabled = true;
      expect(await take(A.session, "because")).toEqual({ ok: false, category: "bad_request", retryable: false });
      expect(await take(B.session)).toEqual({ ok: false, category: "not_found", retryable: false });
      flags.approverRole = { adminAboveCents: 10_000 };
      expect(await take()).toEqual({ ok: false, category: "role", retryable: false });
      expect(await advanceRow(adv.id)).toMatchObject({ taken_back_cents: "0", taken_back_by: null });
      await makeAdmin();
      expect(await take()).toMatchObject({ ok: true, changed: true });
    });
  });
});
