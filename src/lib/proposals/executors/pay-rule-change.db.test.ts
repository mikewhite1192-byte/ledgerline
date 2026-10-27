import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../../config/flags";
import { callTool } from "../../agent/gateway";
import { readWaitingRuleChangeViews } from "../../agent/gateway/store";
import type { GatewayContext } from "../../agent/gateway/types";
import { readPayConfigFor } from "../../data/read";
import { createPgDb } from "../../db/pg";
import { adminUrl, appUrl } from "../../db/test-urls";
import type { Db, Param } from "../../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../../money/test-db";
import { changeArgsOf, readRuleChangeRows, ruleChangeOf, type RuleChange, type RuleChangeArgs } from "../../pay-rules/change";
import { EXECUTORS, executeProposal, type ProposalRow } from "../execute";
import { executePayRuleChange } from "./pay-rule-change";

// A person's approval of a pay_rule_change against the real database, as the app's role. The
// engine sizes the change from a paid week's rows; the card and the auditor's evidence carry the
// same figures; one approval writes one dated version, every other column copied from the version
// in force, and one pay_rule_changes row, once, even with two approvals at once; a change that
// starts the week a version already starts edits that version in place; anything that moved since
// the proposal (the old value, a later version, a paid week, the week began) fails it as stale
// and writes nothing else; above the admin threshold only an admin may approve; the switch off
// refuses before anything is written; another carrier reads and approves nothing. Only this file's
// three tenants are made, and they are removed after.

const saved = { ...flags, approverRole: { ...flags.approverRole }, gatewayLimits: { ...flags.gatewayLimits } };
// Tuesday Oct 27, 2026, 10:00 in Chicago: the week of Oct 26 has begun, so the next week start is
// Monday Nov 2.
const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);
const NEXT_WEEK = "2026-11-02";

let admin: Db;
let app: Db;
// A: a paid week of Oct 19 to 25 with one load for DRV-1 on two days, insurance charged to all.
let A: Fixture;
// B: another carrier, with no pay rules of its own.
let B: Fixture;
// C: pay rules with no paid week, insurance charged to owner-operators only.
let C: Fixture;
const V1: Record<string, string> = {};

type Insurance = "all" | "owner_operator";

async function addPayRules(f: Fixture, appliesTo: Insurance): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-10-05' AS date), 'seed', 1, 'linehaul',
         0, 10000, $2, 1100, 0, 0, 0, NULL, 500, 150000, 5000, 5000)`,
      [id, appliesTo],
    ),
  );
  return id;
}

// The week of Oct 19 paid: DRV-1 drove one 2,000-mile load on Oct 20 and 21 (two insured days),
// DRV-2 drove nothing. Both settlements name the version in force.
async function addPaidWeek(f: Fixture, versionId: string): Promise<{ periodId: string; settlementIds: string[] }> {
  const periodId = randomUUID();
  const loadId = randomUUID();
  const settlementIds = [randomUUID(), randomUUID()];
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
         origin_state, dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles,
         linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'L-1', CAST($2 AS uuid), CAST($3 AS uuid),
         'delivered', 'Springfield', 'IL', 'Dallas', 'TX', CAST('2026-10-20' AS date),
         CAST('2026-10-21' AS date), CAST('2026-10-21T20:00:00Z' AS timestamptz), 2000, 400000)`,
      [loadId, f.customerId, f.driverId],
    );
    for (const [state, miles] of [["IL", 600], ["MO", 500], ["OK", 400], ["TX", 500]] as const) {
      await q.execute(
        `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4)`,
        [randomUUID(), loadId, state, miles],
      );
    }
    for (const day of ["2026-10-20", "2026-10-21"]) {
      await q.execute(
        `INSERT INTO driver_days (id, tenant_id, driver_id, day, source, load_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS date), 'load', CAST($4 AS uuid))`,
        [randomUUID(), f.driverId, day, loadId],
      );
    }
    await q.execute(
      `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-10-19' AS date), CAST('2026-10-25' AS date), 'paid')`,
      [periodId],
    );
    for (const [i, driverId] of [f.driverId, f.otherDriverId].entries()) {
      await q.execute(
        `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
           deductions_cents, net_cents, paid_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
           'paid', 0, 0, 0, CAST('2026-10-26T15:00:00Z' AS timestamptz))`,
        [settlementIds[i], periodId, driverId, versionId],
      );
    }
  });
  return { periodId, settlementIds };
}

// The engine's change for the ask, read through the app role as the tools read it. The sentence
// was checked when it was proposed, so grounding is skipped here as the executor skips it.
async function changeFor(f: Fixture, ask: RuleChangeArgs, at = new Date(NOW)): Promise<RuleChange> {
  const check = await app.withTenant(f.tenantId, async (q) => ruleChangeOf(await readRuleChangeRows(q), ask, "skip", at));
  if (!check.ok) throw new Error(`the engine refused the test change: ${check.reason}`);
  return check.change;
}

// A waiting pay_rule_change shaped like the propose tool's: the version in force is the subject,
// the args are the engine's figures, the stored amount is the size of the weekly impact, and the
// auditor's pass is stored with it. Written by the admin login so created_at and the verdict can
// be set, with the conversation, turn and gateway decision a real one hangs from.
async function addProposal(f: Fixture, c: RuleChange, amountCents = Math.abs(c.impact.netDeltaCents)): Promise<string> {
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - HOUR).toISOString();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)`,
      [conversation, f.session.sub],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Change a pay rule', 'done',
         $3, CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
      [turn, conversation, trace, created],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark',
         'propose_rule_change', 'propose', 'allowed', 'ok', 1)`,
      [decision, turn, trace],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, sources, args, operator_verdict, gateway_decision_id, dedupe_key,
         trace_id, created_at, updated_at, auditor_verdict, auditor_agrees, auditor_concerns, auditor_checked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'pay_rule_change',
         'pay_configs', CAST($4 AS uuid), $5, 'none', 'Change a pay rule', CAST($6 AS jsonb), CAST($7 AS jsonb),
         'not_given', CAST($8 AS uuid), $9, $10, CAST($11 AS timestamptz), CAST($11 AS timestamptz), 'pass',
         true, '[]', CAST($11 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        c.baseVersionId,
        amountCents,
        JSON.stringify(c.sources),
        JSON.stringify(changeArgsOf(c)),
        decision,
        `pay_rule_change:${c.baseVersionId}:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
        trace,
        created,
      ],
    );
  });
  return id;
}

const approve = (f: Fixture, id: string, at = clock) =>
  executeProposal(f.session, id, { confirmed: false }, { db: app, clock: at, executors: EXECUTORS });

async function adminRows<T>(f: Fixture, sql: string, params: Param[] = []): Promise<T[]> {
  return admin.withTenant(f.tenantId, (q) => q.query<T>(sql, params));
}

const versionsOf = (f: Fixture) =>
  adminRows<Record<string, unknown>>(
    f,
    "SELECT * FROM pay_configs WHERE tenant_id = current_tenant_id() ORDER BY effective_from",
  );

const changesOf = (f: Fixture) =>
  adminRows<Record<string, unknown>>(
    f,
    `SELECT CAST(pay_config_id AS text) AS pay_config_id, CAST(proposal_id AS text) AS proposal_id, rule_key,
       old_value, new_value, CAST(asked_from AS text) AS asked_from, CAST(effective_from AS text) AS effective_from,
       applied, decided_by
       FROM pay_rule_changes WHERE tenant_id = current_tenant_id() ORDER BY created_at, id`,
  );

async function proposalOf(f: Fixture, id: string): Promise<{ status: string; decision_note: string | null }> {
  const [p] = await adminRows<{ status: string; decision_note: string | null }>(
    f,
    "SELECT status, decision_note FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [id],
  );
  return p;
}

const setRole = (f: Fixture, role: "admin" | "staff") =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute("UPDATE memberships SET role = $1 WHERE tenant_id = current_tenant_id() AND cognito_sub = $2", [
      role,
      f.session.sub,
    ]),
  );

// The auditor's evidence pack for a proposal, through the gateway as the double-check reads it.
async function evidenceOf(f: Fixture, proposalId: string): Promise<Record<string, unknown>> {
  const ctx: GatewayContext = {
    session: f.session,
    role: "auditor",
    model: "wonder",
    turnId: null,
    traceId: randomUUID(),
    now: clock(),
    deadlineAt: NOW + 60_000,
    timeZone: "America/Chicago",
  };
  const out = await callTool(
    ctx,
    { id: "c", name: "get_proposal", argumentsJson: JSON.stringify({ proposalId }) },
    { db: app, clock: () => NOW },
  );
  if (out.decision !== "allowed") throw new Error(`get_proposal was not allowed: ${out.reason}`);
  return out.result;
}

function without(row: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => !keys.includes(k)));
}

const INSURANCE: RuleChangeArgs = { ruleKey: "insurance_per_day_cents", newValue: 1_200, askedFrom: NEXT_WEEK };

describe("approving a pay rule change", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `rules-a-${randomUUID().slice(0, 8)}`);
    B = await makeTenant(admin, `rules-b-${randomUUID().slice(0, 8)}`);
    C = await makeTenant(admin, `rules-c-${randomUUID().slice(0, 8)}`);
    V1.A = await addPayRules(A, "all");
    V1.C = await addPayRules(C, "owner_operator");
  });

  beforeAll(() => {
    flags.rulesByTalkingEnabled = true;
  });

  afterEach(() => {
    Object.assign(flags, saved, {
      approverRole: { ...saved.approverRole },
      gatewayLimits: { ...saved.gatewayLimits },
      rulesByTalkingEnabled: true,
    });
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    Object.assign(flags, saved);
    await dropTenant(admin, A);
    await dropTenant(admin, B);
    await dropTenant(admin, C);
    await app?.close();
    await admin?.close();
  });

  it("sizes the change from the paid week, shows it waiting with the same figures, and writes one version once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const week = await addPaidWeek(A, V1.A);
    const c = await changeFor(A, INSURANCE);
    // DRV-1's two insured days at $1.00 more each; DRV-2 drove nothing.
    expect(c).toMatchObject({
      baseVersionId: V1.A,
      oldValue: 1_100,
      newValue: 1_200,
      effectiveFrom: NEXT_WEEK,
      snapped: false,
      applied: "new_version",
      impact: {
        basis: "settled_week",
        periodId: week.periodId,
        driversCompared: 2,
        driversChanged: 1,
        netDeltaCents: -200,
        ownerOperatorsOnly: false,
        top: [{ driverId: A.driverId, code: "DRV-1", deltaCents: -200, settlementId: week.settlementIds[0] }],
      },
    });
    const id = await addProposal(A, c);

    // The Pay rules page's waiting card reads its figures from the stored args.
    const waiting = await app.withTenant(A.tenantId, (q) => readWaitingRuleChangeViews(q));
    expect(waiting.map((p) => p.id)).toEqual([id]);
    expect(waiting[0]).toMatchObject({
      kind: "pay_rule_change",
      amountCents: 200,
      ruleChange: {
        ruleKey: "insurance_per_day_cents",
        oldValue: 1_100,
        newValue: 1_200,
        effectiveFrom: NEXT_WEEK,
        applied: "new_version",
        impact: { basis: "settled_week", driversChanged: 1, netDeltaCents: -200 },
      },
    });

    // The double-check's evidence: the engine's figures now, equal to the stored ones.
    expect((await evidenceOf(A, id)).engine).toMatchObject({
      ok: true,
      check: "pay_rule_change",
      proposedCents: 200,
      engine: {
        ok: true,
        amountCents: 200,
        figures: { oldValue: 1_100, newValue: 1_200, effectiveFrom: NEXT_WEEK, driversChanged: 1, netDeltaCents: -200 },
        matchesProposal: true,
      },
    });

    // Above the admin threshold a staff member is refused and nothing is written; an admin approves.
    flags.approverRole.adminAboveCents = 199;
    expect(await approve(A, id)).toEqual({ ok: false, category: "role", retryable: false });
    expect(await proposalOf(A, id)).toEqual({ status: "proposed", decision_note: null });
    expect(await versionsOf(A)).toHaveLength(1);
    await setRole(A, "admin");
    try {
      expect(await approve(A, id)).toEqual({ ok: true, proposalId: id, status: "done", moneyActionId: null });
    } finally {
      await setRole(A, "staff");
    }
    expect(await proposalOf(A, id)).toEqual({ status: "done", decision_note: null });

    // One new version from Nov 2: the one rule replaced, every other column the base's.
    const versions = await versionsOf(A);
    expect(versions).toHaveLength(2);
    const [base, written] = versions;
    expect(written).toMatchObject({
      source: "proposal",
      note: "Insurance per day to $12.00 per insured day (from $11.00 per insured day)",
    });
    expect(String(written.insurance_per_day_cents)).toBe("1200");
    const columns = await adminRows<{ column_name: string }>(
      A,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'pay_configs' ORDER BY ordinal_position`,
    );
    const own = new Set(["id", "effective_from", "note", "source", "created_at", "insurance_per_day_cents"]);
    const copied = columns.map((x) => x.column_name).filter((x) => !own.has(x));
    expect(copied.length).toBeGreaterThanOrEqual(13);
    for (const column of copied) expect(written[column], column).toEqual(base[column]);

    // One diff row, naming the version and the proposal.
    expect(await changesOf(A)).toEqual([
      {
        pay_config_id: written.id,
        proposal_id: id,
        rule_key: "insurance_per_day_cents",
        old_value: "1100",
        new_value: "1200",
        asked_from: NEXT_WEEK,
        effective_from: NEXT_WEEK,
        applied: "new_version",
        decided_by: A.session.sub,
      },
    ]);

    // The pay engine's reader picks the version by week: the old one this week, the new one after.
    await app.withTenant(A.tenantId, async (q) => {
      expect((await readPayConfigFor(q, "2026-10-26")).id).toBe(V1.A);
      const next = await readPayConfigFor(q, NEXT_WEEK);
      expect(next.id).toBe(written.id);
      expect(next.insurance_per_day_cents).toBe(1_200);
      expect((await readPayConfigFor(q, "2026-12-07")).id).toBe(written.id);
    });
    expect(await app.withTenant(A.tenantId, (q) => readWaitingRuleChangeViews(q))).toEqual([]);

    // The same approval again is already decided, and the executor run again finds it done.
    expect(await approve(A, id)).toMatchObject({ ok: false, category: "already_decided" });
    const row: ProposalRow = {
      id,
      conversationId: randomUUID(),
      turnId: null,
      kind: "pay_rule_change",
      subjectTable: "pay_configs",
      subjectId: V1.A,
      amountCents: 200,
      direction: "none",
      args: {},
      status: "approved",
      flaggedInputId: null,
      auditorVerdict: "pass",
      auditorAgrees: true,
      moneyActionId: null,
      traceId: "t",
    };
    expect(await executePayRuleChange(app, A.session, row, { confirmed: false }, { clock })).toEqual({
      ok: true,
      proposalId: id,
      status: "done",
      moneyActionId: null,
    });
    expect(await versionsOf(A)).toEqual(versions);
    expect(await changesOf(A)).toHaveLength(1);

    // One diff row per proposal, even for a direct write.
    const again = app.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO pay_rule_changes (id, tenant_id, pay_config_id, proposal_id, rule_key, old_value, new_value,
           asked_from, effective_from, applied, decided_by)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'insurance_per_day_cents',
           '1100', '1200', CAST($4 AS date), CAST($4 AS date), 'new_version', 'x')`,
        [randomUUID(), String(written.id), id, NEXT_WEEK],
      ),
    );
    expect(await sqlStateOf(again)).toBe("23505");

    // The app login adds saved changes but never erases one (0030 grants no DELETE).
    const erase = app.withTenant(A.tenantId, (q) =>
      q.execute("DELETE FROM pay_rule_changes WHERE tenant_id = current_tenant_id()"),
    );
    expect(await sqlStateOf(erase)).toBe("42501");
    expect(await changesOf(A)).toHaveLength(1);
  });

  it("edits a version that starts that same week in place, keeping its note", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const later = randomUUID();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO pay_configs (id, tenant_id, effective_from, note, source, week_start_dow, percent_base,
           empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
           escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
           advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-11-09' AS date), 'Set in settings', 'ui', 1,
           'linehaul', 0, 10000, 'all', 1200, 0, 0, 0, NULL, 500, 150000, 5000, 5000)`,
        [later],
      ),
    );
    const c = await changeFor(A, { ruleKey: "advance_fee_cents", newValue: 750, askedFrom: "2026-11-09" });
    expect(c).toMatchObject({
      baseVersionId: later,
      applied: "edited_version",
      impact: { basis: "advances_only", netDeltaCents: 0 },
    });
    const before = await versionsOf(A);
    const id = await addProposal(A, c);
    expect(await approve(A, id)).toEqual({ ok: true, proposalId: id, status: "done", moneyActionId: null });

    const after = await versionsOf(A);
    expect(after).toHaveLength(before.length);
    const edited = after.find((v) => v.id === later);
    expect(edited).toMatchObject({ source: "ui", note: "Set in settings; Advance fee to $7.50 (from $5.00)" });
    expect(String(edited?.advance_fee_cents)).toBe("750");
    // Every other version, and every other column of this one, is as it was.
    for (const v of after.filter((x) => x.id !== later)) expect(v).toEqual(before.find((x) => x.id === v.id));
    expect(without(edited, ["note", "advance_fee_cents"])).toEqual(
      without(before.find((v) => v.id === later), ["note", "advance_fee_cents"]),
    );
    expect((await changesOf(A)).filter((r) => r.proposal_id === id)).toEqual([
      {
        pay_config_id: later,
        proposal_id: id,
        rule_key: "advance_fee_cents",
        old_value: "500",
        new_value: "750",
        asked_from: "2026-11-09",
        effective_from: "2026-11-09",
        applied: "edited_version",
        decided_by: A.session.sub,
      },
    ]);
  });

  it("writes once when two approvals of the same change run at once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const c = await changeFor(A, { ruleKey: "advance_min_cents", newValue: 2_500, askedFrom: "2026-11-16" });
    expect(c.applied).toBe("new_version");
    const id = await addProposal(A, c);
    const results = await Promise.all([approve(A, id), approve(A, id)]);
    expect(results.filter((r) => r.ok)).not.toHaveLength(0);
    for (const r of results) {
      if (r.ok) expect(r).toMatchObject({ status: "done" });
      else expect(r).toMatchObject({ category: "already_decided" });
    }
    const written = await adminRows<{ n: number }>(
      A,
      "SELECT CAST(count(*) AS integer) AS n FROM pay_configs WHERE tenant_id = current_tenant_id() AND effective_from = CAST('2026-11-16' AS date)",
    );
    expect(written).toEqual([{ n: 1 }]);
    expect((await changesOf(A)).filter((r) => r.proposal_id === id)).toHaveLength(1);
    expect(await proposalOf(A, id)).toEqual({ status: "done", decision_note: null });
  });

  type Moved = { why: string; move: () => Promise<void>; undo: () => Promise<void>; at?: () => Date; amount?: number };
  const NOTHING = async () => {};
  const LATER_ID = randomUUID();
  const PAID = { period: randomUUID(), settlement: randomUUID() };
  const moved: Moved[] = [
    {
      why: "the stored amount is not the size of the engine's impact",
      move: NOTHING,
      undo: NOTHING,
      amount: 1,
    },
    {
      why: "the old value changed under it",
      move: async () => {
        await admin.withTenant(C.tenantId, (q) =>
          q.execute("UPDATE pay_configs SET insurance_per_day_cents = 1150 WHERE tenant_id = current_tenant_id()"),
        );
      },
      undo: async () => {
        await admin.withTenant(C.tenantId, (q) =>
          q.execute("UPDATE pay_configs SET insurance_per_day_cents = 1100 WHERE tenant_id = current_tenant_id()"),
        );
      },
    },
    {
      why: "a later version was saved after it",
      move: async () => {
        await admin.withTenant(C.tenantId, (q) =>
          q.execute(
            `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
               empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
               escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
               advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-11-09' AS date), 'ui', 1, 'linehaul',
               0, 10000, 'owner_operator', 1100, 0, 0, 0, NULL, 600, 150000, 5000, 5000)`,
            [LATER_ID],
          ),
        );
      },
      undo: async () => {
        await admin.withTenant(C.tenantId, (q) =>
          q.execute("DELETE FROM pay_configs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [LATER_ID]),
        );
      },
    },
    {
      why: "pay naming the version was paid for a week on or after its start",
      move: async () => {
        await admin.withTenant(C.tenantId, async (q) => {
          await q.execute(
            `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($2 AS date) + 6, 'paid')`,
            [PAID.period, NEXT_WEEK],
          );
          await q.execute(
            `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
               deductions_cents, net_cents, paid_at)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
               'paid', 0, 0, 0, CAST('2026-10-27T14:00:00Z' AS timestamptz))`,
            [PAID.settlement, PAID.period, C.driverId, V1.C],
          );
        });
      },
      undo: async () => {
        await admin.withTenant(C.tenantId, async (q) => {
          await q.execute("DELETE FROM settlements WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
            PAID.settlement,
          ]);
          await q.execute(
            "DELETE FROM settlement_periods WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
            [PAID.period],
          );
        });
      },
    },
    {
      why: "the week it starts began before the approval",
      move: NOTHING,
      undo: NOTHING,
      // Monday Nov 2, inside the proposal's seven days.
      at: () => new Date(Date.UTC(2026, 10, 2, 15, 0, 0)),
    },
  ];

  it.each(moved)("fails as stale and writes nothing else when $why", async ({ move, undo, at, amount }) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = await changeFor(C, INSURANCE);
    const id = await addProposal(C, c, amount ?? Math.abs(c.impact.netDeltaCents));
    await move();
    try {
      const before = await versionsOf(C);
      expect(await approve(C, id, at ?? clock)).toEqual({ ok: false, category: "stale", retryable: false });
      expect(await proposalOf(C, id)).toEqual({ status: "failed", decision_note: "stale" });
      expect(await versionsOf(C)).toEqual(before);
      expect(await changesOf(C)).toEqual([]);
    } finally {
      await undo();
    }
  });

  it("refuses with the switch off before anything is written, keeps one live change per version, and shows another carrier nothing", async () => {
    const c = await changeFor(C, INSURANCE);
    const id = await addProposal(C, c);
    const before = await versionsOf(C);

    flags.rulesByTalkingEnabled = false;
    expect(await approve(C, id)).toEqual({ ok: false, category: "not_executable", retryable: false });
    expect(await proposalOf(C, id)).toEqual({ status: "proposed", decision_note: null });
    expect(await versionsOf(C)).toEqual(before);
    expect(await changesOf(C)).toEqual([]);
    flags.rulesByTalkingEnabled = true;

    // A second live change on the same version is refused by the database.
    expect(await sqlStateOf(addProposal(C, c))).toBe("23505");

    // Another carrier: approving it finds nothing, and nothing of this carrier's rules is read.
    expect(await approve(B, id)).toEqual({ ok: false, category: "not_found", retryable: false });
    expect(await proposalOf(C, id)).toEqual({ status: "proposed", decision_note: null });
    await app.withTenant(B.tenantId, async (q) => {
      expect(await readWaitingRuleChangeViews(q)).toEqual([]);
      expect(await q.query("SELECT id FROM pay_configs")).toEqual([]);
      expect(await q.query("SELECT id FROM pay_rule_changes")).toEqual([]);
    });
    // The carrier's own page sees it.
    expect((await app.withTenant(C.tenantId, (q) => readWaitingRuleChangeViews(q))).map((p) => p.id)).toEqual([id]);
  });

  it("takes a version written by an approval and refuses any other source", async () => {
    const write = (source: string, from: string) =>
      admin.withTenant(B.tenantId, (q) =>
        q.execute(
          `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
             empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
             escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
             advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), $3, 1, 'linehaul',
             0, 10000, 'owner_operator', 1100, 0, 0, 0, NULL, 500, 150000, 5000, 5000)`,
          [randomUUID(), from, source],
        ),
      );
    expect(await write("proposal", "2026-10-05")).toBe(1);
    expect(await sqlStateOf(write("chat", "2026-10-12"))).toBe("23514");
  });
});
