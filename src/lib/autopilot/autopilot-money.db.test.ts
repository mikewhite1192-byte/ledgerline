import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createMoneyCodeIssuer } from "../adapters/payment/fuel-card-sim";
import { createMockPaymentAdapter, type MockPaymentAdapter } from "../adapters/payment/mock";
import { executeAdvanceProposal, precheckAdvanceProposal, type AdvanceDeps } from "../advances/approve";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { addAdvance, clearLedger, dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { executeMoneyCodeProposal, precheckMoneyCode, type MoneyCodeDeps } from "../money-codes/execute";
import { requestMoneyCode } from "../money-codes/request";
import { executeProposal, type Executor, type ExecutorRegistry } from "../proposals/execute";
import { runAutopilot } from "./run";
import { autopilotSub } from "./session";

// The autopilot on the two kinds that pay a driver, against the real database, as the app's role,
// with the advance and money code executors on the test-mode mock and the simulated issuer. Inside
// every limit it pays an advance and issues a code by itself, once, under the ledger's own key;
// one driver's day holds that driver while another is still paid; the carrier's day holds them
// all; a person's approval never counts in its totals; an advance whose numbers went stale since
// the audit waits for a person with nothing written; another carrier's approvals never count. A
// fixed clock; two tenants made for each test and removed after.

const saved = structuredClone(flags);
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);
const CHECKED_AT = new Date(NOW - HOUR / 2).toISOString();

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let mock: MockPaymentAdapter;

const money = () => ({ timeoutMs: 2_000, waitMs: 2_000, pollMs: 10, log: () => {} });
const advanceDeps = (): AdvanceDeps => ({ db: app, clock, money: { payment: mock, ...money() } });
const codeDeps = (): MoneyCodeDeps => ({ db: app, clock, issuer: createMoneyCodeIssuer({ log: () => {} }), money: money() });

// The registered executors with this file's adapters, prechecks included.
const REGISTRY: ExecutorRegistry = {
  advance_payout: Object.assign(((db, s, p, o) => executeAdvanceProposal(db, s, p, o, advanceDeps())) as Executor, {
    precheck: precheckAdvanceProposal,
  }),
  money_code: Object.assign(((db, s, p, o) => executeMoneyCodeProposal(db, s, p, o, codeDeps())) as Executor, {
    precheck: precheckMoneyCode,
  }),
};
const run = (f: Fixture, id: string) => runAutopilot(f.tenantId, id, { db: app, clock, executors: REGISTRY });

// One carrier: pay rules with one delivered load per driver (2,000 miles at 60 cents is $1,200.00
// earned, half of which may be advanced), a load on the road for the first driver, the autopilot
// login, and the starting money rules. Returns the load on the road.
async function setUp(f: Fixture): Promise<string> {
  const road = randomUUID();
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
      for (const [state, miles] of [["IL", 600], ["MO", 500], ["OK", 400], ["TX", 500]] as const) {
        await q.execute(
          `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4)`,
          [randomUUID(), loadId, state, miles],
        );
      }
    }
    await q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
         origin_state, dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'L-ROAD', CAST($2 AS uuid), CAST($3 AS uuid),
         'in_transit', 'Springfield', 'IL', 'Dallas', 'TX', CAST('2026-11-01' AS date), 2000, 400000)`,
      [road, f.customerId, f.driverId],
    );
    await q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), $1, 'autopilot@money.invalid', 'staff')`,
      [autopilotSub(f.tenantId)],
    );
    await q.execute(
      `INSERT INTO autopilot_rules
         (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, driver_day_max_cents, updated_by)
       VALUES (current_tenant_id(), 'advance_payout', 'auto', 30000, 150000, 10, 30000, 'setup'),
              (current_tenant_id(), 'money_code', 'auto', 15000, 60000, 4, 30000, 'setup')`,
    );
  });
  return road;
}

// A waiting advance shaped like the gateway's (the driver is the subject, the args carry the
// driver and the amount), passed by the auditor and matched by the engine at its audit.
async function addAdvanceProposal(f: Fixture, driverId: string, amountCents: number): Promise<string> {
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - HOUR).toISOString();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
      [conversation, f.session.sub],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Advance?', 'done', $3,
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
         CAST($11 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        driverId,
        amountCents,
        JSON.stringify({ driverId, amountCents }),
        decision,
        `advance_payout:${driverId}:${randomUUID().replace(/-/g, "")}${"0".repeat(32)}`,
        trace,
        created,
        CHECKED_AT,
      ],
    );
  });
  await matched(f, id, amountCents);
  return id;
}

// The engine's match as the audit stores it (set once, from null).
const matched = (f: Fixture, id: string, amountCents: number) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE proposals SET engine_check = 'matched', engine_cents = $2, engine_checked_at = CAST($3 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id, amountCents, CHECKED_AT],
    ),
  );

type Row = { status: string; decided_by: string | null; decision: Record<string, unknown> | null };
const rowOf = async (f: Fixture, id: string): Promise<Row> =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<Row>(
        `SELECT status, decided_by, autopilot_decision AS decision FROM proposals
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0];

const advancesOf = (f: Fixture, proposalId: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ id: string; status: string; amount_cents: string }>(
      `SELECT CAST(id AS text) AS id, status, CAST(amount_cents AS text) AS amount_cents
         FROM advances WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)`,
      [proposalId],
    ),
  );

const ledgerOf = (f: Fixture, kind: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ subject_id: string; idempotency_key: string; state: string }>(
      `SELECT CAST(subject_id AS text) AS subject_id, idempotency_key, state FROM money_actions
        WHERE tenant_id = current_tenant_id() AND kind = $1 ORDER BY created_at`,
      [kind],
    ),
  );

const setAdvanceRule = (f: Fixture, maxCents: number, dayMaxCents: number, driverDayMaxCents: number) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE autopilot_rules SET max_cents = $1, day_max_cents = $2, driver_day_max_cents = $3, version = version + 1
        WHERE tenant_id = current_tenant_id() AND kind = 'advance_payout'`,
      [maxCents, dayMaxCents, driverDayMaxCents],
    ),
  );

// Turns one kind's own arming on or off for a test (restored after each).
function arm(kind: "advance_payout" | "money_code", on: boolean) {
  const ceiling = flags.autopilot.kinds[kind];
  if (!ceiling) throw new Error(`no ceiling for ${kind}`);
  ceiling.armed = on;
}

describe("the autopilot on the kinds that pay a driver", () => {
  let roadA: string;

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
    flags.moneyCodes = { ...flags.moneyCodes, enabled: true, armed: true, capCents: 50_000, perDriverPerDay: 2, startDate: "2026-10-28" };
    flags.autopilot.enabled = true;
    flags.autopilot.armed = true;
    arm("advance_payout", true);
    arm("money_code", true);
    mock = createMockPaymentAdapter({ log: () => {} });
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `apm-a-${tag}`);
    B = await makeTenant(admin, `apm-b-${tag}`);
    roadA = await setUp(A);
    await setUp(B);
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    for (const f of [A, B]) {
      if (f) await clearLedger(admin, f);
      await dropTenant(admin, f);
    }
  });

  afterAll(async () => {
    Object.assign(flags, structuredClone(saved));
    await app?.close();
    await admin?.close();
  });

  it("pays an advance inside every limit by itself, once, through the test-mode adapter under the ledger's key", async () => {
    const id = await addAdvanceProposal(A, A.driverId, 20_000);
    expect(await run(A, id)).toMatchObject({ ok: true, result: { outcome: "approved", status: "done" } });
    const row = await rowOf(A, id);
    expect(row.status).toBe("done");
    expect(row.decided_by).toBe(autopilotSub(A.tenantId));
    expect(row.decision).toMatchObject({
      mode: "auto",
      reason: "within_limits",
      maxCents: 30_000,
      dayCents: 0,
      dayCount: 0,
      driverId: A.driverId,
      driverDayMaxCents: 30_000,
      driverDayCents: 0,
    });
    const [advance, ...others] = await advancesOf(A, id);
    expect(others).toEqual([]);
    expect(advance).toMatchObject({ status: "paid", amount_cents: "20000" });
    expect(await ledgerOf(A, "advance_payout")).toEqual([
      { subject_id: advance.id, idempotency_key: `advance_payout:${advance.id}:1`, state: "confirmed" },
    ]);
    expect(mock.sendCount).toBe(1);
    // Again: decided before, never paid twice.
    expect(await run(A, id)).toMatchObject({ ok: true, result: { outcome: "earlier" } });
    expect(mock.sendCount).toBe(1);
  });

  it("holds one driver to the driver's day while another is still paid, and a person's approval never counts", async () => {
    const first = await addAdvanceProposal(A, A.driverId, 20_000);
    expect(await run(A, first)).toMatchObject({ ok: true, result: { outcome: "approved" } });
    // 20,000 already today plus 15,000 is past the driver's 30,000.
    const second = await addAdvanceProposal(A, A.driverId, 15_000);
    expect(await run(A, second)).toEqual({ ok: true, result: { outcome: "decided", mode: "ask", reason: "over_driver_day_cents" } });
    expect(await rowOf(A, second)).toMatchObject({ status: "proposed", decided_by: null, decision: { driverDayCents: 20_000 } });
    expect(await advancesOf(A, second)).toEqual([]);
    // The other driver's day is still empty.
    const other = await addAdvanceProposal(A, A.otherDriverId, 15_000);
    expect(await run(A, other)).toMatchObject({ ok: true, result: { outcome: "approved" } });
    expect((await rowOf(A, other)).decision).toMatchObject({ driverId: A.otherDriverId, driverDayCents: 0, dayCents: 20_000, dayCount: 1 });
    // A person approves the asked one; the autopilot's totals still count only its own.
    expect(await executeProposal(A.session, second, { confirmed: false }, { db: app, clock, executors: REGISTRY })).toMatchObject({
      ok: true,
      status: "done",
    });
    const third = await addAdvanceProposal(A, A.driverId, 5_000);
    expect(await run(A, third)).toMatchObject({ ok: true, result: { outcome: "approved" } });
    expect((await rowOf(A, third)).decision).toMatchObject({ driverDayCents: 20_000, dayCents: 35_000, dayCount: 2 });
    expect(mock.sendCount).toBe(4);
  });

  it("holds every driver to the carrier's day", async () => {
    await setAdvanceRule(A, 20_000, 30_000, 30_000);
    const first = await addAdvanceProposal(A, A.driverId, 20_000);
    expect(await run(A, first)).toMatchObject({ ok: true, result: { outcome: "approved" } });
    const other = await addAdvanceProposal(A, A.otherDriverId, 15_000);
    expect(await run(A, other)).toEqual({ ok: true, result: { outcome: "decided", mode: "ask", reason: "over_day_cents" } });
    expect((await rowOf(A, other)).decision).toMatchObject({ dayCents: 20_000, driverDayCents: 0, dayMaxCents: 30_000 });
    expect(mock.sendCount).toBe(1);
  });

  it("leaves an advance whose numbers went stale since its audit for a person, with nothing written", async () => {
    // An approved advance not yet paid leaves the driver $100.00 of the $600.00.
    await addAdvance(admin, A, 50_000, "approved");
    const id = await addAdvanceProposal(A, A.driverId, 20_000);
    expect(await run(A, id)).toEqual({ ok: true, result: { outcome: "decided", mode: "ask", reason: "stale_eligibility" } });
    expect(await rowOf(A, id)).toMatchObject({
      status: "proposed",
      decided_by: null,
      decision: { mode: "ask", reason: "gate_refused", gate: "stale_eligibility" },
    });
    expect(await advancesOf(A, id)).toEqual([]);
    expect(await ledgerOf(A, "advance_payout")).toEqual([]);
    expect(mock.sendCount).toBe(0);
  });

  it("issues a money code inside every limit by itself, once, under the ledger's key", async () => {
    const asked = await requestMoneyCode(A.session, { loadId: roadA, amountCents: 12_000, purpose: "repair", documentId: null }, { db: app, clock });
    if (!asked.ok) throw new Error(`request refused: ${asked.category}`);
    const id = asked.proposalId;
    // The audit's pass and the engine's match, as the desk's audit stores them.
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = TRUE, auditor_concerns = CAST('[]' AS jsonb),
                auditor_checked_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id, CHECKED_AT],
      ),
    );
    await matched(A, id, 12_000);
    expect(await run(A, id)).toMatchObject({ ok: true, result: { outcome: "approved", status: "done" } });
    const row = await rowOf(A, id);
    expect(row.decided_by).toBe(autopilotSub(A.tenantId));
    expect(row.decision).toMatchObject({ mode: "auto", driverId: A.driverId, driverDayMaxCents: 30_000, driverDayCents: 0 });
    const codes = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ id: string; status: string }>(
        "SELECT CAST(id AS text) AS id, status FROM money_codes WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)",
        [id],
      ),
    );
    expect(codes).toEqual([{ id: expect.any(String), status: "issued" }]);
    expect(await ledgerOf(A, "money_code_issue")).toEqual([
      { subject_id: codes[0].id, idempotency_key: `money_code_issue:${codes[0].id}:1`, state: "confirmed" },
    ]);
  });

  it("never counts another carrier's approvals in this carrier's day", async () => {
    const theirs = await addAdvanceProposal(B, B.driverId, 20_000);
    expect(await run(B, theirs)).toMatchObject({ ok: true, result: { outcome: "approved" } });
    // Another carrier's autopilot approval whose args name this carrier's driver (args carry no
    // foreign key): counted, its 20,000 would put this driver past the 30,000 driver day.
    const named = await addAdvanceProposal(B, A.driverId, 20_000);
    await admin.withTenant(B.tenantId, (q) =>
      q.execute(
        `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                autopilot_decision = CAST($4 AS jsonb)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [named, autopilotSub(B.tenantId), new Date(NOW - HOUR / 4).toISOString(), JSON.stringify({ mode: "auto", reason: "within_limits" })],
      ),
    );
    const ours = await addAdvanceProposal(A, A.driverId, 20_000);
    expect(await run(A, ours)).toMatchObject({ ok: true, result: { outcome: "approved" } });
    expect((await rowOf(A, ours)).decision).toMatchObject({ dayCents: 0, dayCount: 0, driverDayCents: 0 });
  });

  it("approves neither kind while its own ceiling is unarmed, and writes nothing", async () => {
    arm("advance_payout", false);
    const id = await addAdvanceProposal(A, A.driverId, 20_000);
    expect(await run(A, id)).toEqual({ ok: true, result: { outcome: "held", reason: "kind_unarmed" } });
    expect(await rowOf(A, id)).toEqual({ status: "proposed", decided_by: null, decision: null });
    expect(mock.sendCount).toBe(0);
  });
});
