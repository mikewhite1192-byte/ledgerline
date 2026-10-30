import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter, type MockPaymentAdapter } from "../adapters/payment/mock";
import type { PaymentAdapter } from "../adapters/types";
import { escrowReleaseLimit } from "../agent/gateway/limits";
import { dedupeKey } from "../agent/gateway/store/proposals";
import type { GatewayContext } from "../agent/gateway/types";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { readTenantZone } from "../money/read";
import { clearLedger, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal, type ProposalRow } from "../proposals/execute";
import { localDateOf } from "../time/local-date";
import { listReleasesDue } from "./due";
import { executeEscrowRelease, precheckEscrowRelease, type EscrowDeps } from "./execute";
import { readRelease } from "./read";
import { checkPendingEscrowRelease } from "./reconcile";
import { readEscrowStatement } from "./statement";

// The escrow release against a real database, as the app's own role, with the registered executor
// (EXECUTORS) and the mock payment adapter (never a live payout). A terminated driver is listed
// ninety days after the last active day on the carrier's own date; the statement adds up the paid
// weeks and the releases and reports a difference without correcting it. A person's approval
// writes the one release row, reserves the one ledger row before the send and pays the balance
// once, however many times it is pressed; a payout with no answer stays unknown until Check
// pending reads it back, then settles once; a balance that moved before the payout settled is
// never written below zero; a release over the cap or the balance, or with any switch closed, is
// refused at every path before anything is written. Another carrier sees nothing. Every tenant
// made here is removed after each test, in a finally.

const saved = structuredClone(flags);
// Monday November 2, 2026, 10:00 in Chicago (the fixture carrier's zone).
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);
const ZONE = "America/Chicago";
const TODAY = "2026-11-02";

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let mock: MockPaymentAdapter;

function switchesOn() {
  flags.payoutsEnabled = true;
  flags.escrowRelease.enabled = true;
  flags.escrowRelease.armed = true;
}

// A driver's last active day and escrow balance, set by the admin login (the fixture's drivers are
// active with nothing held).
async function terminate(f: Fixture, driverId: string, activeTo: string | null, balanceCents: number) {
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE drivers SET active_to = CAST($2 AS date), escrow_balance_cents = $3
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [driverId, activeTo, balanceCents],
    ),
  );
}

async function addDriver(f: Fixture, code: string, activeTo: string | null, balanceCents: number): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
         per_mile_cents, active_from, active_to, escrow_balance_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, 'Test', 'Driver', $3, 'company', 'per_mile', 60,
         CAST('2026-01-01' AS date), CAST($4 AS date), $5)`,
      [id, code, `${code.toLowerCase()}@escrow.example`, activeTo, balanceCents],
    ),
  );
  return id;
}

// Paid weeks for one driver: [period start, period end, status, withheld, charged]. One pay rule
// set holds them all.
async function addWeeks(f: Fixture, driverId: string, weeks: [string, string, "paid" | "approved", number, number][]) {
  await admin.withTenant(f.tenantId, async (q) => {
    const config = randomUUID();
    await q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'ui', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 250000, 10000, 0, NULL, 500, 150000, 5000, 5000)`,
      [config],
    );
    let opening = 0;
    for (const [start, end, status, withheld, charged] of weeks) {
      const period = randomUUID();
      await q.execute(
        `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($3 AS date), $4)`,
        [period, start, end, status],
      );
      const closing = opening - charged + withheld;
      await q.execute(
        `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
           deductions_cents, net_cents, paid_at, escrow_opening_cents, escrow_charges_cents,
           escrow_withheld_cents, escrow_closing_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5,
           200000, $6, $7, CASE WHEN $5 = 'paid' THEN CAST('2026-07-10T15:00:00Z' AS timestamptz) END, $8, $9, $10, $11)`,
        [randomUUID(), period, driverId, config, status, withheld, 200000 - withheld, opening, charged, withheld, closing],
      );
      opening = closing;
    }
  });
}

type Opts = { driverId?: string; amountCents?: number; balanceAsOf?: string; dedupe?: string; tenant?: Fixture };

// A waiting escrow_release proposal shaped like the gateway's: the driver is the subject, the args
// carry the driver, the amount and the balance's date, and the dedupe key is the gateway's own.
// The auditor's pass is stored with it, so one click approves it. Written by the admin login so
// created_at and the verdict can be set.
async function addProposal(o: Opts = {}): Promise<string> {
  const f = o.tenant ?? A;
  const driverId = o.driverId ?? f.driverId;
  const amountCents = o.amountCents ?? 120_000;
  const args = { driverId, amountCents, balanceAsOf: o.balanceAsOf ?? TODAY };
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - HOUR).toISOString();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
      [conversation, f.session.sub],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Release escrow for DRV-1?', 'done', $3,
         CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
      [turn, conversation, trace, created],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark', 'propose_escrow_release',
         'propose', 'allowed', 'ok', 1)`,
      [decision, turn, trace],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
         created_at, updated_at, auditor_verdict, auditor_agrees, auditor_checked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'escrow_release',
         'drivers', CAST($4 AS uuid), $5, 'out', 'Release driver escrow', CAST($6 AS jsonb), 'not_given',
         CAST($7 AS uuid), $8, $9, CAST($10 AS timestamptz), CAST($10 AS timestamptz), 'pass', TRUE,
         CAST($10 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        driverId,
        amountCents,
        JSON.stringify(args),
        decision,
        o.dedupe ?? dedupeKey("escrow_release", driverId, args),
        trace,
        created,
      ],
    );
  });
  return id;
}

const deps = (over: Partial<NonNullable<EscrowDeps["money"]>> = {}): EscrowDeps => ({
  db: app,
  clock,
  money: { payment: mock, timeoutMs: 2_000, waitMs: 2_000, pollMs: 10, log: () => {}, ...over },
});

const approve = (id: string, d: EscrowDeps = deps(), session = A.session) => executeProposal(session, id, { confirmed: false }, d);

type ReleaseDb = {
  id: string;
  driver_id: string;
  proposal_id: string;
  money_action_id: string | null;
  opening_balance_cents: string;
  amount_cents: string;
  status: string;
  released_at: string | null;
};

const releases = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<ReleaseDb>(
      `SELECT CAST(id AS text) AS id, CAST(driver_id AS text) AS driver_id, CAST(proposal_id AS text) AS proposal_id,
              CAST(money_action_id AS text) AS money_action_id, CAST(opening_balance_cents AS text) AS opening_balance_cents,
              CAST(amount_cents AS text) AS amount_cents, status,
              to_char(released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS released_at
         FROM escrow_releases WHERE tenant_id = current_tenant_id() ORDER BY created_at, id`,
    ),
  );

type LedgerDb = {
  id: string;
  kind: string;
  state: string;
  attempt: number;
  amount_cents: string;
  idempotency_key: string;
  subject_table: string;
  subject_id: string;
  counterparty_table: string;
  counterparty_id: string;
  channel: string;
  proposed_by: string;
  failure_category: string | null;
};

const ledger = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<LedgerDb>(
      `SELECT CAST(id AS text) AS id, kind, state, attempt, CAST(amount_cents AS text) AS amount_cents, idempotency_key,
              subject_table, CAST(subject_id AS text) AS subject_id, counterparty_table,
              CAST(counterparty_id AS text) AS counterparty_id, channel, proposed_by, failure_category
         FROM money_actions WHERE tenant_id = current_tenant_id() ORDER BY created_at, attempt`,
    ),
  );

const balanceOf = async (driverId: string, f: Fixture = A) =>
  Number(
    (
      await admin.withTenant(f.tenantId, (q) =>
        q.query<{ b: string }>(
          "SELECT CAST(escrow_balance_cents AS text) AS b FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
          [driverId],
        ),
      )
    )[0].b,
  );

const proposalRow = async (id: string, f: Fixture = A) =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<{ status: string; money_action_id: string | null; decision_note: string | null }>(
        `SELECT status, CAST(money_action_id AS text) AS money_action_id, decision_note FROM proposals
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0];

// The drivers due as the app reads them, at an instant, on the carrier's own date.
const dueAt = (at: string, f: Fixture = A) =>
  app.withTenant(f.tenantId, async (q) => (await listReleasesDue(q, localDateOf(at, await readTenantZone(q)))).drivers.map((d) => d.driverId));

// The gate's view of a proposal, for calling the precheck and the executor directly.
function rowFor(id: string, driverId: string, amountCents: number, status = "proposed"): ProposalRow {
  return {
    id,
    conversationId: null,
    turnId: null,
    kind: "escrow_release",
    subjectTable: "drivers",
    subjectId: driverId,
    amountCents,
    direction: "out",
    args: { driverId, amountCents, balanceAsOf: TODAY },
    status,
    flaggedInputId: null,
    auditorVerdict: "pass",
    auditorAgrees: true,
    moneyActionId: null,
    traceId: null,
  };
}

const gatewayCtx = (f: Fixture = A): GatewayContext => ({
  session: f.session,
  role: "operator",
  model: "spark",
  turnId: null,
  traceId: "trace-escrow",
  now: new Date(NOW),
  deadlineAt: NOW + 60_000,
  timeZone: ZONE,
});

const limitOf = (driverId: string, amountCents: number, balanceAsOf = TODAY) =>
  app.withTenant(A.tenantId, (q) => escrowReleaseLimit(q, gatewayCtx(), { driverId, amountCents, balanceAsOf }));

describe("escrow release", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    switchesOn();
    mock = createMockPaymentAdapter({ log: () => {} });
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `esc-a-${tag}`);
    B = await makeTenant(admin, `esc-b-${tag}`);
    // DRV-1 last worked on July 31 and holds $1,200.00 of escrow.
    await terminate(A, A.driverId, "2026-07-31", 120_000);
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    vi.restoreAllMocks();
    for (const f of [A, B]) {
      try {
        // The releases first: they name ledger rows, and the app role has no DELETE.
        if (f) {
          await admin.withTenant(f.tenantId, (q) => q.execute("DELETE FROM escrow_releases WHERE tenant_id = current_tenant_id()"));
          await clearLedger(admin, f);
        }
      } finally {
        await dropTenant(admin, f);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("lists a driver ninety days after the last active day on the carrier's own date, never an active, empty or live one", async () => {
    await terminate(A, A.driverId, "2026-08-04", 120_000);
    await terminate(A, A.otherDriverId, "2026-08-05", 50_000);
    await addDriver(A, "DRV-3", null, 70_000);
    await addDriver(A, "DRV-4", "2026-03-01", 0);
    // 03:30 UTC on November 3 is still November 2 in Chicago: DRV-2 is due a day later there.
    expect(await dueAt("2026-11-03T03:30:00.000Z")).toEqual([A.driverId]);
    expect(await dueAt("2026-11-03T06:00:00.000Z")).toEqual([A.driverId, A.otherDriverId]);
    expect(await dueAt("2026-11-03T06:00:00.000Z", B)).toEqual([]);

    // A release being sent holds the balance: the driver leaves the list until it settles.
    const id = await addProposal({ amountCents: 120_000 });
    mock.confirmSilently();
    expect(await approve(id)).toMatchObject({ ok: true, status: "executing" });
    expect(await dueAt("2026-11-03T06:00:00.000Z")).toEqual([A.otherDriverId]);
  });

  it("states the balance from the paid weeks and the releases, and reports a planted difference without changing it", async () => {
    await addWeeks(A, A.driverId, [
      ["2026-06-29", "2026-07-05", "paid", 70_000, 0],
      ["2026-07-06", "2026-07-12", "paid", 60_000, 10_000],
      ["2026-07-13", "2026-07-19", "approved", 5_000, 0],
    ]);
    const read = (driverId: string) =>
      app.withTenant(A.tenantId, (q) => readEscrowStatement(q, driverId, new Date(NOW).toISOString(), ZONE));
    expect(await read(A.driverId)).toMatchObject({
      terminated: true,
      asOf: TODAY,
      openingCents: 0,
      withheldCents: 130_000,
      chargesCents: 10_000,
      releasedCents: 0,
      closingCents: 120_000,
      balanceCents: 120_000,
      matches: true,
      openRelease: null,
      lines: [
        { kind: "withheld", periodStart: "2026-06-29", withheldCents: 70_000, chargesCents: 0 },
        { kind: "withheld", periodStart: "2026-07-06", withheldCents: 60_000, chargesCents: 10_000 },
      ],
    });

    const id = await addProposal();
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    const [rel] = await releases();
    const after = await read(A.driverId);
    expect(after).toMatchObject({ releasedCents: 120_000, closingCents: 0, balanceCents: 0, matches: true });
    expect(after?.lines.at(-1)).toEqual({ kind: "released", releaseId: rel.id, releasedOn: TODAY, amountCents: 120_000 });

    // DRV-2 holds $100.00 that no paid week withheld: reported, never corrected.
    await terminate(A, A.otherDriverId, "2026-07-31", 10_000);
    expect(await read(A.otherDriverId)).toMatchObject({ closingCents: 0, balanceCents: 10_000, matches: false });
    expect(await balanceOf(A.otherDriverId)).toBe(10_000);
    expect(await read(randomUUID())).toBeNull();
  });

  it("limits a proposal to exactly the balance on today's date, the cap included, and refuses every other", async () => {
    expect(await limitOf(A.driverId, 120_000)).toMatchObject({ ok: true, limitCents: 120_000, requestedCents: 120_000 });
    expect(await limitOf(A.driverId, 120_001)).toMatchObject({ ok: false, reason: "engine_refused", category: "amount_mismatch" });
    expect(await limitOf(A.driverId, 120_000, "2026-11-01")).toMatchObject({ ok: false, category: "balance_date_mismatch" });
    expect(await limitOf(A.otherDriverId, 10_000)).toMatchObject({ ok: false, category: "driver_active" });
    expect(await limitOf(randomUUID(), 10_000)).toMatchObject({ ok: false, category: "driver_not_found" });
    await terminate(A, A.driverId, "2026-07-31", 500_000);
    expect(await limitOf(A.driverId, 500_000)).toMatchObject({ ok: true, limitCents: 500_000 });
    await terminate(A, A.driverId, "2026-07-31", 500_001);
    expect(await limitOf(A.driverId, 500_001)).toMatchObject({ ok: false, reason: "amount_over_limit", limitCents: 500_000 });
  });

  it("reserves the ledger row before the one payout and pays the balance once, however many times approve is pressed", async () => {
    const id = await addProposal();
    let seenAtSend: { ledger: LedgerDb[]; release: ReleaseDb[] } | null = null;
    const watching: PaymentAdapter = {
      ...mock,
      sendPayout: async (p, ctx) => {
        seenAtSend = { ledger: await ledger(), release: await releases() };
        return mock.sendPayout(p, ctx);
      },
    };
    const out = await approve(id, deps({ payment: watching }));
    expect(out).toMatchObject({ ok: true, proposalId: id, status: "done" });

    const [rel] = await releases();
    const [row] = await ledger();
    // At the send the row was already reserved and claimed, and the release already named it.
    expect(seenAtSend).toEqual({
      ledger: [expect.objectContaining({ id: row.id, state: "sent" })],
      release: [expect.objectContaining({ id: rel.id, status: "issuing", money_action_id: row.id })],
    });
    expect(row).toMatchObject({
      kind: "escrow_release",
      state: "confirmed",
      attempt: 1,
      amount_cents: "120000",
      idempotency_key: `escrow_release:${rel.id}:1`,
      subject_table: "escrow_releases",
      subject_id: rel.id,
      counterparty_table: "drivers",
      counterparty_id: A.driverId,
      channel: "payment",
      proposed_by: "agent",
    });
    expect(rel).toMatchObject({
      driver_id: A.driverId,
      proposal_id: id,
      money_action_id: row.id,
      opening_balance_cents: "120000",
      amount_cents: "120000",
      status: "released",
      released_at: expect.stringMatching(/^2026-11-02T/),
    });
    expect(await balanceOf(A.driverId)).toBe(0);
    expect(await proposalRow(id)).toMatchObject({ status: "done", money_action_id: row.id });
    expect(out).toMatchObject({ moneyActionId: row.id });

    expect(await approve(id)).toMatchObject({ ok: false, category: "already_decided" });
    // The executor run again on the finished proposal sends nothing.
    expect(await executeEscrowRelease(app, A.session, rowFor(id, A.driverId, 120_000, "done"), { confirmed: false }, deps())).toMatchObject({
      ok: false,
      category: "already_decided",
    });
    expect(mock.sendCount).toBe(1);
    expect(mock.createdCount).toBe(1);
    expect(await ledger()).toHaveLength(1);
    expect(await releases()).toHaveLength(1);
  });

  it("makes one transfer when two approvals race", async () => {
    const id = await addProposal();
    const results = await Promise.all([approve(id), approve(id)]);
    expect(results.filter((r) => r.ok)).not.toHaveLength(0);
    expect(await releases()).toEqual([expect.objectContaining({ status: "released" })]);
    expect(await ledger()).toEqual([expect.objectContaining({ state: "confirmed", attempt: 1 })]);
    expect(mock.createdCount).toBe(1);
    expect(mock.sendCount).toBe(1);
    expect(await balanceOf(A.driverId)).toBe(0);
  });

  it("keeps a payout with no answer unknown until Check pending reads it back, then settles it once", async () => {
    const id = await addProposal();
    mock.hangNext();
    expect(await approve(id, deps({ timeoutMs: 50 }))).toMatchObject({ ok: true, status: "executing" });
    const [rel] = await releases();
    expect(rel.status).toBe("issuing");
    expect(await ledger()).toEqual([expect.objectContaining({ state: "unknown", attempt: 1 })]);
    expect(await balanceOf(A.driverId)).toBe(120_000);
    expect((await proposalRow(id)).status).toBe("executing");

    // Approving it again resumes: the same row, replayed by its key, never a second payout.
    expect(await approve(id)).toMatchObject({ ok: true, status: "executing" });
    expect(mock.sendCount).toBe(1);
    expect(await ledger()).toHaveLength(1);

    const checked = await checkPendingEscrowRelease(A.session, rel.id, deps());
    expect(checked).toMatchObject({ ok: true, summary: { confirmed: 1 } });
    expect(await releases()).toEqual([expect.objectContaining({ id: rel.id, status: "released" })]);
    expect(await ledger()).toEqual([expect.objectContaining({ state: "confirmed", attempt: 1 })]);
    expect(await balanceOf(A.driverId)).toBe(0);
    expect((await proposalRow(id)).status).toBe("done");

    // Checking again reads nothing and changes nothing.
    expect(await checkPendingEscrowRelease(A.session, rel.id, deps())).toMatchObject({ ok: true, summary: { checked: 0 } });
    expect(await balanceOf(A.driverId)).toBe(0);
    expect(mock.createdCount).toBe(1);
    expect(mock.sendCount).toBe(1);
  });

  it("marks the release unknown, never a negative balance, when the balance moved before the payout settled", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await addProposal();
    mock.confirmSilently();
    expect(await approve(id)).toMatchObject({ ok: true, status: "executing" });
    const [rel] = await releases();
    // A deposit lands on the balance while the payout's answer is lost.
    await terminate(A, A.driverId, "2026-07-31", 130_000);

    expect(await checkPendingEscrowRelease(A.session, rel.id, deps())).toMatchObject({ ok: true, summary: { confirmed: 1 } });
    expect(await releases()).toEqual([expect.objectContaining({ id: rel.id, status: "unknown", released_at: null })]);
    expect(await balanceOf(A.driverId)).toBe(130_000);
    expect((await proposalRow(id)).status).toBe("executing");
    const logged = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(rel.id));
    expect(logged).toEqual([`escrow release ${rel.id}: the balance moved before the payout settled; marked unknown`]);

    // Nothing is sent again, and the driver stays off the due list until a person settles it.
    expect(await approve(id)).toMatchObject({ ok: false, category: "release_unknown" });
    expect(await dueAt(new Date(NOW).toISOString())).toEqual([]);
    expect(mock.createdCount).toBe(1);
    expect(mock.sendCount).toBe(1);
  });

  it("ends a definite payout failure failed with the balance kept, and a new proposal releases it", async () => {
    const id = await addProposal();
    mock.failNext("rate_limited");
    expect(await approve(id)).toMatchObject({ ok: false, category: "release_failed" });
    expect(await releases()).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(await ledger()).toEqual([expect.objectContaining({ state: "failed", failure_category: "rate_limited" })]);
    expect(await proposalRow(id)).toMatchObject({ status: "failed", decision_note: "release_failed: rate_limited" });
    expect(await balanceOf(A.driverId)).toBe(120_000);

    // The failed row holds nothing: the next card (another key) writes a new release and pays it.
    const next = await addProposal({ dedupe: `escrow_release:${A.driverId}:${randomBytes(32).toString("hex")}` });
    expect(await approve(next)).toMatchObject({ ok: true, status: "done" });
    const statusOf = Object.fromEntries((await releases()).map((r) => [r.proposal_id, r.status]));
    expect(statusOf).toEqual({ [id]: "failed", [next]: "released" });
    expect(await balanceOf(A.driverId)).toBe(0);
    expect(mock.createdCount).toBe(1);
  });

  it("refuses a release above the cap or the balance, or a balance that moved, before anything is written", async () => {
    // Above the cap: an admin may approve over $2,000.00, so the cap is what refuses it.
    await admin.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [A.memberId]),
    );
    await terminate(A, A.otherDriverId, "2026-07-31", 600_000);
    const overCap = await addProposal({ driverId: A.otherDriverId, amountCents: 600_000 });
    expect(await approve(overCap)).toMatchObject({ ok: false, category: "over_escrow_cap" });

    // More than the balance.
    const overBalance = await addProposal({ amountCents: 130_000 });
    expect(await approve(overBalance)).toMatchObject({ ok: false, category: "stale" });

    // The balance moved after the card was made (another driver: one live card per driver).
    const third = await addDriver(A, "DRV-3", "2026-07-31", 50_000);
    const moved = await addProposal({ driverId: third, amountCents: 50_000 });
    await terminate(A, third, "2026-07-31", 55_000);
    expect(await approve(moved)).toMatchObject({ ok: false, category: "stale" });

    for (const id of [overCap, overBalance, moved]) expect((await proposalRow(id)).status).toBe("proposed");
    expect(await releases()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(mock.sendCount).toBe(0);
  });

  it("refuses at every path while the switch is off or not armed", async () => {
    const id = await addProposal();
    const row = rowFor(id, A.driverId, 120_000);

    flags.escrowRelease.enabled = false;
    // The registry offers no executor, so the gate refuses before its precheck.
    expect(await approve(id)).toMatchObject({ ok: false, category: "not_executable" });
    expect(await app.withTenant(A.tenantId, (q) => precheckEscrowRelease(q, row, new Date(NOW)))).toMatchObject({ category: "escrow_off" });
    expect(await executeEscrowRelease(app, A.session, { ...row, status: "approved" }, { confirmed: false }, deps())).toMatchObject({
      category: "escrow_off",
    });
    expect(await limitOf(A.driverId, 120_000)).toMatchObject({ ok: false, reason: "limit_unavailable" });
    expect(await checkPendingEscrowRelease(A.session, randomUUID(), deps())).toMatchObject({ ok: false, category: "escrow_off" });

    flags.escrowRelease.enabled = true;
    flags.escrowRelease.armed = false;
    expect(await approve(id)).toMatchObject({ ok: false, category: "escrow_not_armed" });
    expect(await limitOf(A.driverId, 120_000)).toMatchObject({ ok: false, category: "escrow_not_armed" });
    flags.payoutsEnabled = false;
    flags.escrowRelease.armed = true;
    expect(await approve(id)).toMatchObject({ ok: false, category: "escrow_payouts_off" });

    expect((await proposalRow(id)).status).toBe("proposed");
    expect(await releases()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(mock.sendCount).toBe(0);
  });

  it("refuses a resume once the switch is disarmed, and rolls the reservation back when it closes at the reserve", async () => {
    // Disarmed after the approval: the resume refuses and sends nothing more.
    const first = await addProposal();
    mock.hangNext();
    expect(await approve(first, deps({ timeoutMs: 50 }))).toMatchObject({ ok: true, status: "executing" });
    flags.escrowRelease.armed = false;
    expect(await approve(first)).toMatchObject({ ok: false, category: "escrow_not_armed" });
    expect(mock.sendCount).toBe(1);

    // Closed between the approval and the reserve (here, while the adapter is asked if it is
    // ready): the reserve's own check rolls the ledger row back, and the release and its card end
    // failed with nothing sent.
    flags.escrowRelease.armed = true;
    const second = await addProposal({ driverId: A.otherDriverId, amountCents: 40_000 });
    await terminate(A, A.otherDriverId, "2026-07-31", 40_000);
    const closing: PaymentAdapter = {
      ...mock,
      ready: async () => {
        flags.escrowRelease.armed = false;
        return mock.ready();
      },
    };
    expect(await approve(second, deps({ payment: closing }))).toMatchObject({ ok: false, category: "escrow_off" });
    const rel = (await releases()).find((r) => r.proposal_id === second);
    expect(rel).toMatchObject({ driver_id: A.otherDriverId, status: "failed", money_action_id: null });
    expect((await ledger()).filter((r) => r.counterparty_id === A.otherDriverId)).toEqual([]);
    expect(await proposalRow(second)).toMatchObject({ status: "failed", decision_note: "not_sent: disabled" });
    expect(await balanceOf(A.otherDriverId)).toBe(40_000);
    expect(mock.sendCount).toBe(1);
  });

  it("keeps another carrier's releases invisible and its approvals out of reach", async () => {
    const id = await addProposal();
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    const [rel] = await releases();

    const seen = await app.withTenant(B.tenantId, async (q) => ({
      rows: await q.query<{ n: string }>("SELECT CAST(count(*) AS text) AS n FROM escrow_releases"),
      byId: await readRelease(q, "id", rel.id),
      byProposal: await readRelease(q, "proposal_id", id),
    }));
    expect(seen).toEqual({ rows: [{ n: "0" }], byId: null, byProposal: null });
    expect(await checkPendingEscrowRelease(B.session, rel.id, deps())).toMatchObject({ ok: false, category: "not_found" });
    expect(await approve(id, deps(), B.session)).toMatchObject({ ok: false, category: "not_found" });
    // B's own app role cannot reach A's row to change it either.
    const changed = await app.withTenant(B.tenantId, (q) =>
      q.execute("UPDATE escrow_releases SET status = 'failed' WHERE id = CAST($1 AS uuid)", [rel.id]),
    );
    expect(changed).toBe(0);
    expect(await releases()).toEqual([expect.objectContaining({ status: "released" })]);
  });

  it("lets the app role move a release's status but never delete one or change what was approved", async () => {
    const id = await addProposal();
    expect(await approve(id)).toMatchObject({ ok: true, status: "done" });
    const [rel] = await releases();
    const asApp = (sql: string) => sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute(sql, [rel.id])));
    expect(await asApp("DELETE FROM escrow_releases WHERE id = CAST($1 AS uuid)")).toBe("42501");
    expect(await asApp("UPDATE escrow_releases SET amount_cents = 1 WHERE id = CAST($1 AS uuid)")).toBe("42501");
    expect(await asApp("UPDATE escrow_releases SET driver_id = proposal_id WHERE id = CAST($1 AS uuid)")).toBe("42501");
    expect(await releases()).toEqual([expect.objectContaining({ amount_cents: "120000", status: "released" })]);
  });
});
