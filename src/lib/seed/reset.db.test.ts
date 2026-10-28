import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { readTenantRows } from "../data/read";
import type { TenantRows } from "../data/rows";
import { TENANT_TABLES } from "../data/tables";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { approvalFrom } from "../money/approval";
import { markSent, reserve, settle, type OutsideRecord, type Settlement } from "../money/ledger";
import type { MoneyDraft } from "../money/types";
import { DEMO_ANCHOR } from "./anchor";
import { HERO_OPEN_WEEK } from "./assert-plan";
import { DEMO_CARRIERS } from "./carriers";
import { buildCarrierPlan, type CarrierPlan } from "./plan";
import { buildPortalPlan } from "./portal";
import { seedTenantPortal } from "./portal-db";
import {
  CLEARED_TABLES,
  DEMO_RESET_KEPT,
  DemoResetFailed,
  DemoResetRefused,
  RESET_SQLSTATE,
  previewDemoReset,
  resetDemoTenant,
} from "./reset";
import { replaceTenantData } from "./run";
import { countRows } from "./summary";

// The demo reset end to end on a fresh database, both carriers seeded with the broker portal's
// loads as npm run seed leaves them: carrier A (blue-ridge) reset with ledger, agent, note,
// detention, flow-advance, dock clip and portal run rows in place; carrier B (prairie-wind), a third carrier that
// is not a demo one, and the shared tables byte for byte unchanged; each refusal deleting
// nothing; a failure after the clear rolling the clear back; and a second run changing nothing.

const [BR, PW] = DEMO_CARRIERS;
const planA = buildCarrierPlan(BR, DEMO_ANCHOR);
const planB = buildCarrierPlan(PW, DEMO_ANCHOR);
const portalA = buildPortalPlan(planA);
const portalB = buildPortalPlan(planB);
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const OTHER = { slug: `reset-other-${C.slice(0, 8)}`, name: "Other Freight", timezone: "America/Chicago" };

const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;

let admin: Db;
let app: Db;

type TableInfo = { name: string; ref: string; key: "id" | "tenant_id" | null };
let tableInfo: TableInfo[] = [];

async function createTenant(id: string, t: { slug: string; name: string; timezone: string }): Promise<void> {
  await admin.withTenant(id, (q) =>
    q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)",
      [t.slug, t.name, t.timezone],
    ),
  );
}

async function sqlStateOf(work: Promise<unknown>): Promise<string | undefined> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return (err as { sqlState?: string }).sqlState;
}

async function errorOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (e: unknown) => e,
  );
}

function sorted(rows: TenantRows): TenantRows {
  const key = (r: object) => ("id" in r ? String(r.id) : JSON.stringify(r));
  return Object.fromEntries(
    TENANT_TABLES.map((t) => [t, [...rows[t]].sort((a, b) => (key(a) < key(b) ? -1 : 1))]),
  ) as TenantRows;
}

const rowsOf = (tenantId: string) =>
  app.withTenant(tenantId, async (q) => sorted(await readTenantRows(q)));

// Each table's row count and an md5 of its rows, read by the admin login (which ignores row-level
// security) with the tenant named in the statement. tenantId null reads the tables that hold no
// tenant's rows. drop names a column left out of a table's rows.
async function printOf(
  tenantId: string | null,
  drop: Record<string, string> = {},
): Promise<Record<string, { n: number; h: string }>> {
  const out: Record<string, { n: number; h: string }> = {};
  for (const t of tableInfo) {
    if ((tenantId === null) !== (t.key === null)) continue;
    const row = Object.hasOwn(drop, t.name) ? "to_jsonb(t) - CAST($2 AS text)" : "to_jsonb(t)";
    const where = t.key === null ? "true" : `t.${t.key} = CAST($1 AS uuid)`;
    const params = Object.hasOwn(drop, t.name) ? [tenantId, drop[t.name]] : tenantId === null ? [] : [tenantId];
    const [found] = await admin.withoutTenant((q) =>
      q.query<{ n: number; h: string }>(
        `SELECT count(*) AS n,
                md5(coalesce(string_agg(CAST(${row} AS text), '|' ORDER BY CAST(${row} AS text)), '')) AS h
           FROM ${t.ref} t WHERE ${where}`,
        params,
      ),
    );
    out[t.name] = { n: Number(found.n), h: found.h };
  }
  return out;
}

const pick = <T,>(all: Record<string, T>, names: Iterable<string>) =>
  Object.fromEntries([...names].filter((n) => Object.hasOwn(all, n)).map((n) => [n, all[n]]));

const KEPT_WITH_TENANT = Object.keys(DEMO_RESET_KEPT).filter((n) => !n.includes("."));

const clearDirectly = (tenantId: string | null) =>
  tenantId === null
    ? app.withoutTenant((q) => q.query("SELECT * FROM demo_reset_clear()"))
    : app.withTenant(tenantId, (q) => q.query("SELECT * FROM demo_reset_clear()"));

describe("the demo reset", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug IN ($1, $2) ORDER BY slug", [
        BR.slug,
        PW.slug,
      ]),
    );
    if (leftover.length > 0) {
      throw new Error(
        `a tenant ${leftover[0].slug} already exists: the database tests need a fresh database ` +
          "(npm run test:db:fresh)",
      );
    }
    tableInfo = await admin.withoutTenant((q) =>
      q.query<TableInfo>(
        `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS name,
                quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS ref,
                CASE WHEN n.nspname = 'public' AND c.relname = 'tenants' THEN 'id'
                     WHEN EXISTS (SELECT 1 FROM pg_attribute a
                                   WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                                     AND NOT a.attisdropped) THEN 'tenant_id'
                END AS key
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE ${SYSTEM_SCHEMAS} AND c.relkind IN ('r', 'p')
          ORDER BY 1`,
      ),
    );
    await createTenant(A, BR);
    await createTenant(B, PW);
    await createTenant(C, OTHER);
    await replaceTenantData(app, A, planA);
    await replaceTenantData(app, B, planB);
    // As npm run seed does after the replace: the portal's account and loads, by the admin login.
    expect(await seedTenantPortal(admin, A, portalA)).toBe(portalA.loads.length);
    expect(await seedTenantPortal(admin, B, portalB)).toBe(portalB.loads.length);
  });

  afterAll(async () => {
    // Only what this file made: the three tenants (every row of theirs goes with them by cascade).
    for (const id of [A, B, C]) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  // A staff login; each call makes its own membership.
  const member = async (tenantId: string, label: string): Promise<Session> => {
    const sub = `reset-${label}-${randomUUID()}`;
    await admin.withTenant(tenantId, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), $1, 'ops@carrier.example', 'staff')`,
        [sub],
      ),
    );
    return { sub, email: "", tenantId };
  };

  // The agent's chain as the app writes it: a conversation, a turn, the gateway's decision, a step
  // and an approved proposal.
  const agentChain = async (
    tenantId: string,
    session: Session,
    subject: { kind: string; table: string; id: string; amountCents: number },
    flaggedInputId: string | null,
  ): Promise<string> => {
    const [conversation, turn, decision, proposal] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const trace = `trace-${turn.slice(0, 8)}`;
    await app.withTenant(tenantId, async (q) => {
      await q.execute(
        "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
        [conversation, session.sub],
      );
      await q.execute(
        `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, finished_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'What should we fix?', 'done', $3, now())`,
        [turn, conversation, trace],
      );
      await q.execute(
        `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision,
           reason, latency_ms)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark',
           'propose_fix', 'propose', 'allowed', 'ok', 1)`,
        [decision, turn, trace],
      );
      await q.execute(
        `INSERT INTO turn_steps (id, tenant_id, turn_id, seq, kind, label, state, gateway_decision_id, finished_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'proposal', 'Proposing a fix',
           'done', CAST($3 AS uuid), now())`,
        [randomUUID(), turn, decision],
      );
      await q.execute(
        `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
           amount_cents, direction, title, args, operator_verdict, flagged_input_id, gateway_decision_id,
           dedupe_key, status, decided_by, decided_at, trace_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, $5,
           CAST($6 AS uuid), $7, 'none', 'Fix it', CAST('{}' AS jsonb), 'eligible', CAST($8 AS uuid),
           CAST($9 AS uuid), $10, 'approved', $11, now(), $12)`,
        [
          proposal,
          conversation,
          turn,
          subject.kind,
          subject.table,
          subject.id,
          subject.amountCents,
          flaggedInputId,
          decision,
          `${subject.kind}:${subject.id}:${"0".repeat(64)}`,
          session.sub,
          trace,
        ],
      );
    });
    return proposal;
  };

  // A seeded advance back to requested (the plan writes them all paid), so a payout may reserve.
  const requested = (tenantId: string, advanceId: string) =>
    app.withTenant(tenantId, (q) =>
      q.execute(
        `UPDATE advances SET status = 'requested', paid_at = NULL
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [advanceId],
      ),
    );

  // A ledger row as the app writes it: reserved, then (when given) sent and settled.
  const ledgerRow = async (session: Session, draft: MoneyDraft, settlement: Settlement | "reserved") =>
    app.withTenant(session.tenantId, async (q) => {
      const { action } = await reserve(q, await approvalFrom(q, session), draft);
      if (settlement === "reserved") return action.id;
      expect(await markSent(q, action.id)).toBe(true);
      expect(await settle(q, action.id, settlement)).toBe(true);
      return action.id;
    });

  const seededInput = async (tenantId: string) => {
    const [input] = await app.withTenant(tenantId, (q) =>
      q.query<{ id: string }>(
        "SELECT CAST(id AS text) AS id FROM untrusted_inputs WHERE tenant_id = current_tenant_id() ORDER BY id LIMIT 1",
      ),
    );
    expect(input).toBeDefined();
    return input.id;
  };

  // Everything a demo leaves behind on a carrier: an advance an approval created, paid and booked
  // (two settled ledger rows naming its proposal); a failed payout on a seeded advance; a detention
  // charge an approval billed (an accessorial naming its proposal); a flagged proposal no ledger
  // row names; a driver note being drafted; a Memory note added and a seeded one changed; an
  // uploaded document and a voice note with its recording, each naming a seeded inbound message; a
  // dock clip being redacted; a finished portal run with its session (the two name each other), a
  // step, an approved check and what it found; a vendor bill an approved card moved and a stored
  // cash check; and a model charge.
  const dress = async (tenantId: string, plan: CarrierPlan, outsideTag: string) => {
    const session = await member(tenantId, "dress");
    const [driver, other] = plan.rows.drivers;
    const amountCents = 10_000;
    const flowProposal = await agentChain(
      tenantId,
      session,
      { kind: "advance_payout", table: "drivers", id: driver.id, amountCents },
      null,
    );
    const advanceId = randomUUID();
    await app.withTenant(tenantId, (q) =>
      q.execute(
        `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on,
           amount_cents, status, source, proposal_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3,
           CAST('2026-11-02T15:00:00Z' AS timestamptz), CAST('2026-11-02' AS date), $4,
           'approved', 'ui', CAST($5 AS uuid))`,
        [advanceId, driver.id, `ADV-${flowProposal.replace(/-/g, "").slice(0, 12)}`, amountCents, flowProposal],
      ),
    );
    const confirmed = (outside: Omit<OutsideRecord, "amountCents">): Settlement => ({
      to: "confirmed",
      via: "response",
      outside: { ...outside, amountCents },
    });
    const flowDraft = (kind: "advance_payout" | "advance_expense", status: string): MoneyDraft => ({
      kind,
      subjectId: advanceId,
      counterpartyId: driver.id,
      amountCents,
      proposedBy: "agent",
      proposalId: flowProposal,
      subjectStatuses: [status],
    });
    await ledgerRow(session, flowDraft("advance_payout", "approved"), confirmed({
      system: "mock",
      type: "payout",
      id: `mock_reset_${outsideTag}_1`,
    }));
    await app.withTenant(tenantId, (q) =>
      q.execute(
        `UPDATE advances SET status = 'paid', paid_at = CAST('2026-11-02T15:05:00Z' AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [advanceId],
      ),
    );
    await ledgerRow(session, flowDraft("advance_expense", "paid"), confirmed({
      system: "qbo_sandbox",
      type: "Purchase",
      id: `${outsideTag === "a" ? 7 : 8}001`,
    }));

    const seededAdvance = plan.rows.advances[1];
    expect(await requested(tenantId, seededAdvance.id)).toBe(1);
    await ledgerRow(
      session,
      {
        kind: "advance_payout",
        subjectId: seededAdvance.id,
        counterpartyId: seededAdvance.driver_id,
        amountCents: seededAdvance.amount_cents,
        proposedBy: "person",
        subjectStatuses: ["requested"],
      },
      { to: "failed", via: "response", category: "outside_failed" },
    );

    const load = plan.rows.loads[0];
    const detention = await agentChain(
      tenantId,
      session,
      { kind: "detention_charge", table: "loads", id: load.id, amountCents: 4_500 },
      null,
    );
    await app.withTenant(tenantId, (q) =>
      q.execute(
        `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, paid_by_driver,
           description, proposal_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'detention', 99, 4500, false,
           'Detention billed after an approval', CAST($3 AS uuid))`,
        [randomUUID(), load.id, detention],
      ),
    );
    // A person disarming a driver and adding the id the dispatch system knows them by (0027). The
    // app role cannot delete the arming log, so the reset's replace removes it with its drivers
    // (the foreign key cascades) and writes the plan's log again.
    await app.withTenant(tenantId, async (q) => {
      await q.execute(
        `INSERT INTO driver_arm_events (id, tenant_id, driver_id, armed, note, membership_id, source)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), false, 'Paused after a call',
           (SELECT id FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $3), 'ui')`,
        [randomUUID(), other.id, session.sub],
      );
      await q.execute(
        `INSERT INTO driver_identities (id, tenant_id, driver_id, system, external_id, source)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'tms', 'reset-test-1', 'ui')`,
        [randomUUID(), other.id],
      );
    });
    // A note a person added on the Memory page and a seeded note they changed (0040): the replace
    // removes the first and writes the seeded words back.
    await app.withTenant(tenantId, async (q) => {
      await q.execute(
        `INSERT INTO carrier_notes (id, tenant_id, subject_kind, subject_id, text, status, source_kind,
           created_by_kind, created_by_sub)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'driver', CAST($2 AS uuid), 'Asks for advances on Thursdays',
           'active', 'person', 'person', $3)`,
        [randomUUID(), other.id, session.sub],
      );
      expect(
        await q.execute(
          "UPDATE carrier_notes SET text = 'Changed during the demo', updated_by_sub = $2 WHERE id = CAST($1 AS uuid)",
          [plan.rows.carrier_notes[0].id, session.sub],
        ),
      ).toBe(1);
    });

    await agentChain(
      tenantId,
      session,
      { kind: "advance_payout", table: "drivers", id: other.id, amountCents: 5_000 },
      await seededInput(tenantId),
    );

    // Cash Friday (0029): a flexible bill an approved bill_defer card moved (the bill names the
    // proposal) and a stored check naming a seeded pay week. The function's proposal delete clears
    // the bill's link, then the replace deletes the check before the weeks and rewrites the bill.
    const bill = plan.rows.vendor_bills.find((b) => b.status === "open" && b.urgency === "flexible");
    if (!bill) throw new Error("the plan has no flexible open bill");
    const deferral = await agentChain(
      tenantId,
      session,
      { kind: "bill_defer", table: "vendor_bills", id: bill.id, amountCents: bill.amount_cents },
      null,
    );
    await app.withTenant(tenantId, async (q) => {
      expect(
        await q.execute(
          `UPDATE vendor_bills
              SET status = 'deferred', deferred_to = due_on + 7, proposal_id = CAST($2 AS uuid)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [bill.id, deferral],
        ),
      ).toBe(1);
      await q.execute(
        `INSERT INTO cash_checks (id, tenant_id, period_id, as_of, pay_day, figures, gap_cents, pay_run_source,
           explain_category, created_by)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), DATE '2026-11-02', DATE '2026-11-06',
           CAST('{"gapCents":-680000}' AS jsonb), -680000, 'preview', 'disabled', $3)`,
        [randomUUID(), plan.rows.settlements[0].period_id, session.sub],
      );
    });

    const settlement = plan.rows.settlements[0];
    await app.withTenant(tenantId, (q) =>
      q.execute(
        `INSERT INTO driver_notes (id, tenant_id, settlement_id, driver_id, period_id, language, status, trace_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
           'en', 'drafting', CAST($5 AS uuid))`,
        [randomUUID(), settlement.id, settlement.driver_id, settlement.period_id, randomUUID()],
      ),
    );
    // A profit brief the owner had written (0042): a seeded table with none planted, so the replace
    // removes it.
    await app.withTenant(tenantId, (q) =>
      q.execute(
        `INSERT INTO briefs (id, tenant_id, kind, period_start, period_end, as_of, status, figures, model, trace_id,
           created_by)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'profit_week', DATE '2026-10-05', DATE '2026-10-11',
           DATE '2026-10-14', 'drafting', CAST('[]' AS jsonb), 'spark', CAST($2 AS uuid), 'reset-test')`,
        [randomUUID(), randomUUID()],
      ),
    );

    // A finished pay sweep whose finding drafted the detention proposal, in the detention chain's
    // conversation, and an approve-all batch over that proposal (0018): each names a row that goes.
    const sweep = randomUUID();
    await app.withTenant(tenantId, async (q) => {
      await q.execute(
        `INSERT INTO sweep_runs (id, tenant_id, period_id, trigger, started_by, status, phase, cap_cents,
           conversation_id, finished_at)
         SELECT CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'button', $3, 'done', 'done', 100,
           p.conversation_id, now()
           FROM proposals p WHERE p.id = CAST($4 AS uuid)`,
        [sweep, settlement.period_id, session.sub, detention],
      );
      await q.execute(
        `INSERT INTO sweep_items (id, tenant_id, run_id, seen_run_id, period_id, finding_key, check_name, category,
           kind, driver_id, plan, status, proposal_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid),
           'reset-test', 'reset_test', 'reset_test', 'fix', CAST($4 AS uuid), CAST('{}' AS jsonb), 'drafted',
           CAST($5 AS uuid))`,
        [randomUUID(), sweep, settlement.period_id, settlement.driver_id, detention],
      );
      // The run's second check and one driver's check, both naming the detention chain's turn
      // (0024): the reset clears them before the run and the turn.
      await q.execute(
        `INSERT INTO sweep_fanout (run_id, tenant_id, status, plan_turn_id, counts, finished_at)
         SELECT CAST($1 AS uuid), current_tenant_id(), 'done', p.turn_id, CAST('{}' AS jsonb), now()
           FROM proposals p WHERE p.id = CAST($2 AS uuid)`,
        [sweep, detention],
      );
      await q.execute(
        `INSERT INTO sweep_fanout_checks (tenant_id, run_id, driver_id, priority, status, attempts, turn_id,
           result, cost_cents, finished_at)
         SELECT current_tenant_id(), CAST($1 AS uuid), CAST($2 AS uuid), 1, 'done', 1, p.turn_id,
           CAST('{"issues": []}' AS jsonb), 2, now()
           FROM proposals p WHERE p.id = CAST($3 AS uuid)`,
        [sweep, settlement.driver_id, detention],
      );
      const batch = randomUUID();
      await q.execute(
        `INSERT INTO approval_batches (id, tenant_id, scope, period_id, item_ids, total_cents, status, requested_by,
           finished_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'proposals', CAST($2 AS uuid), ARRAY[CAST($3 AS uuid)],
           4500, 'done', $4, now())`,
        [batch, settlement.period_id, detention, session.sub],
      );
      // As Approve all clean does: the approved proposal names its batch, so the batch can only go
      // after the proposal.
      await q.execute("UPDATE proposals SET batch_id = CAST($1 AS uuid) WHERE id = CAST($2 AS uuid)", [
        batch,
        detention,
      ]);
      // A saved pay rule change (0030): it names a proposal that goes and a rules version the
      // replace rewrites, so the clear must take it before either.
      const version = plan.rows.pay_configs[0];
      await q.execute(
        `INSERT INTO pay_rule_changes (id, tenant_id, pay_config_id, proposal_id, rule_key, old_value, new_value,
           asked_from, effective_from, applied, decided_by)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'insurance_per_day_cents',
           '1100', '1200', CAST($4 AS date), CAST($4 AS date), 'edited_version', $5)`,
        [randomUUID(), version.id, detention, version.effective_from, session.sub],
      );
    });

    // A fuel check whose finding names a seeded fill-up, its load, one of the driver's pay lines and
    // a card it sent for approval (0031): the finding must go before the proposals and before the
    // replace deletes the fill-up, and its run after it.
    const fill = plan.rows.fuel_purchases.find((f) => f.load_id !== null);
    const payLine = plan.rows.pay_items.find((i) => fill !== undefined && i.driver_id === fill.driver_id);
    if (!fill || !payLine) throw new Error("the plan has no fill-up on a load with a pay line for its driver");
    await app.withTenant(tenantId, async (q) => {
      const fuelRun = randomUUID();
      const finding = randomUUID();
      await q.execute(
        `INSERT INTO fuel_check_runs (id, tenant_id, as_of, started_by, status, checked_count, found_count,
           finished_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), $3, 'done', 1, 1, now())`,
        [fuelRun, fill.purchased_on, session.sub],
      );
      await q.execute(
        `INSERT INTO fuel_findings (id, tenant_id, finding_key, check_name, category, driver_id, fuel_purchase_id,
           load_id, pay_item_id, purchased_on, state, gallons_milli, tank_gallons, paid_with, amount_cents,
           suggested_cents, sources, first_run_id, last_run_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $13, 'fuel_off_route', 'state_not_on_route',
           CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), CAST($5 AS uuid), CAST($6 AS date), $7, $8, 150,
           $9, $10, $11, CAST('[]' AS jsonb), CAST($12 AS uuid), CAST($12 AS uuid))`,
        [
          finding,
          fill.driver_id,
          fill.id,
          fill.load_id,
          payLine.id,
          fill.purchased_on,
          fill.state,
          fill.gallons_milli,
          fill.paid_with,
          fill.amount_cents,
          -fill.amount_cents,
          fuelRun,
          `reset-test:${finding}`,
        ],
      );
      expect(
        await q.execute(
          `UPDATE fuel_findings SET status = 'proposed', proposal_id = CAST($2 AS uuid)
            WHERE id = CAST($1 AS uuid)`,
          [finding, detention],
        ),
      ).toBe(1);
    });

    const input = await seededInput(tenantId);
    const voiceNote = randomUUID();
    await app.withTenant(tenantId, async (q) => {
      await q.execute(
        `INSERT INTO documents (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash,
           untrusted_input_id, trace_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, 'receipt.png', 'image/png', 4,
           decode('89504e47', 'hex'), $3, CAST($4 AS uuid), CAST($5 AS uuid))`,
        [randomUUID(), session.sub, randomUUID().replace(/-/g, "").repeat(2), input, randomUUID()],
      );
      await q.execute(
        `INSERT INTO voice_notes (id, tenant_id, driver_id, input_id, trace_id, created_by, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
           $5, 'transcribed')`,
        [voiceNote, driver.id, input, randomUUID(), session.sub],
      );
      await q.execute(
        `INSERT INTO voice_note_audio (tenant_id, voice_note_id, audio, audio_mime, audio_bytes)
         VALUES (current_tenant_id(), CAST($1 AS uuid), decode('52494646', 'hex'), 'audio/wav', 4)`,
        [voiceNote],
      );
      await q.execute(
        `INSERT INTO evidence_clips (id, tenant_id, load_id, stop, uploaded_by, filename, raw_hash, raw_byte_length,
           width, height, frames_per_second, frame_count, duration_ms, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'delivery', $3, 'dock.mp4', $4, 1000,
           640, 480, 10, 50, 5000, 'redacting')`,
        [randomUUID(), load.id, session.sub, randomUUID().replace(/-/g, "").repeat(2)],
      );
    });

    const [run, portalSession, step] = [randomUUID(), randomUUID(), randomUUID()];
    await app.withTenant(tenantId, async (q) => {
      await q.execute(
        `INSERT INTO portal_runs (id, tenant_id, load_id, reference, requested_by, trace_id, model, status,
           ended_reason, finished_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'FFE-000001', $3, $4, 'spark', 'done',
           'answered', now())`,
        [run, load.id, session.sub, `trace-${run.slice(0, 8)}`],
      );
      await q.execute(
        `INSERT INTO portal_sessions (id, tenant_id, run_id, code_hash, expires_at, created_by)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, now() + interval '20 minutes', $4)`,
        [portalSession, run, "c".repeat(64), session.sub],
      );
      expect(
        await q.execute(
          `UPDATE portal_runs SET session_id = CAST($2 AS uuid)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [run, portalSession],
        ),
      ).toBe(1);
      await q.execute(
        `INSERT INTO portal_run_steps (id, tenant_id, run_id, seq, executed)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 0, false)`,
        [step, run],
      );
      await q.execute(
        `INSERT INTO portal_run_checks (id, tenant_id, run_id, step_id, check_id, code, message, status,
           decided_by, decided_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'check-1', 'sign_in',
           'Sign in to the portal', 'approved', $4, now())`,
        [randomUUID(), run, step, session.sub],
      );
      await q.execute(
        `INSERT INTO portal_evidence (id, tenant_id, run_id, load_id, answer, untrusted_input_id, screen_verdict,
           readback_match)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST('{}' AS jsonb),
           CAST($4 AS uuid), 'clean', 'matches')`,
        [randomUUID(), run, load.id, input],
      );
    });

    await app.withTenant(tenantId, (q) =>
      q.execute(
        `INSERT INTO model_calls (tenant_id, provider, model, purpose, status, reserved_nanocents, target)
         VALUES (current_tenant_id(), 'meta', 'reset-test-model', 'reset_test', 'reserved', 0, 'spark')`,
      ),
    );
    return session;
  };

  // The ledger and agent switches the fixtures need, restored after each test.
  const withMoneySwitches = async (work: () => Promise<void>) => {
    const saved = { ...flags };
    flags.payoutsEnabled = true;
    flags.paymentProvider = "mock";
    flags.accountingEnabled = true;
    try {
      await work();
    } finally {
      Object.assign(flags, saved);
    }
  };

  it("resets carrier A to its seeded week in one call, and leaves carrier B, the other carrier and the shared tables as they were", async () => {
    await withMoneySwitches(async () => {
      await dress(A, planA, "a");
      await dress(B, planB, "b");
      const otherSession = await member(C, "other");
      await agentChain(C, otherSession, { kind: "invoice_fix", table: "customers", id: randomUUID(), amountCents: 100 }, null);

      const before = {
        keptA: pick(await printOf(A, { gateway_decisions: "turn_id" }), KEPT_WITH_TENANT),
        b: await printOf(B),
        c: await printOf(C),
        shared: await printOf(null),
      };
      expect(before.keptA.memberships.n).toBe(1);
      expect(before.keptA.model_calls.n).toBe(1);
      expect(before.keptA.gateway_decisions.n).toBe(4);
      expect(before.keptA.portal_accounts.n).toBe(1);
      expect(before.c.proposals.n).toBe(1);

      const preview = await app.withTenant(A, (q) => previewDemoReset(q, BR));
      expect(preview.refusals).toEqual([]);
      expect(pick(preview.current, CLEARED_TABLES)).toEqual({
        money_actions: 3,
        documents: 1,
        evidence_clips: 1,
        portal_evidence: 1,
        portal_run_checks: 1,
        portal_run_steps: 1,
        portal_sessions: 1,
        portal_runs: 1,
        portal_loads: portalA.loads.length,
        voice_note_audio: 1,
        voice_notes: 1,
        driver_notes: 1,
        turn_steps: 4,
        sweep_fanout_checks: 1,
        sweep_fanout: 1,
        sweep_items: 1,
        sweep_runs: 1,
        fuel_findings: 1,
        fuel_check_runs: 1,
        approval_batches: 1,
        pay_rule_changes: 1,
        proposals: 4,
        turns: 4,
        conversations: 4,
      });
      expect(preview.current.advances).toBe(planA.rows.advances.length + 1);
      expect(preview.current.load_accessorials).toBe(planA.rows.load_accessorials.length + 1);
      expect(preview.current.driver_arm_events).toBe(planA.rows.driver_arm_events.length + 1);
      expect(preview.current.driver_identities).toBe(planA.rows.driver_identities.length + 1);
      expect(preview.current.briefs).toBe(planA.rows.briefs.length + 1);
      expect(preview.current.cash_checks).toBe(1);
      expect(planA.rows.cash_checks).toEqual([]);
      expect(preview.current.carrier_notes).toBe(planA.rows.carrier_notes.length + 1);

      const report = await resetDemoTenant(app, A, planA);
      expect(report.slug).toBe("blue-ridge");
      expect(report.before).toEqual(preview.current);
      expect(portalA.loads.length).toBeGreaterThan(0);
      expect(report.cleared).toEqual({
        money_actions: 3,
        documents: 1,
        evidence_clips: 1,
        portal_evidence: 1,
        portal_run_checks: 1,
        portal_run_steps: 1,
        portal_sessions: 1,
        portal_runs: 1,
        portal_loads: portalA.loads.length,
        voice_note_audio: 1,
        voice_notes: 1,
        driver_notes: 1,
        turn_steps: 4,
        sweep_fanout_checks: 1,
        sweep_fanout: 1,
        sweep_items: 1,
        sweep_runs: 1,
        fuel_findings: 1,
        fuel_check_runs: 1,
        approval_batches: 1,
        pay_rule_changes: 1,
        advances: 1,
        proposals: 4,
        turns: 4,
        conversations: 4,
      });
      expect(report.heroNetCents).toBe(HERO_OPEN_WEEK.netCents);
      expect(report.replaced.inserted).toEqual(countRows(planA.rows));
      expect(pick(report.after, TENANT_TABLES)).toEqual(countRows(planA.rows));
      expect(pick(report.after, CLEARED_TABLES)).toEqual(
        Object.fromEntries(CLEARED_TABLES.map((t) => [t, 0])),
      );

      // A is its seeded week again, row for row.
      expect(await rowsOf(A)).toEqual(sorted(planA.rows));
      // A's logins, model charges, audit log and sandbox link are kept; the audit log's rows only
      // lost the turn they named.
      expect(pick(await printOf(A, { gateway_decisions: "turn_id" }), KEPT_WITH_TENANT)).toEqual(before.keptA);
      const [named] = await admin.withoutTenant((q) =>
        q.query<{ n: number }>(
          "SELECT count(*) AS n FROM gateway_decisions WHERE tenant_id = CAST($1 AS uuid) AND turn_id IS NOT NULL",
          [A],
        ),
      );
      expect(Number(named.n)).toBe(0);
      // Nothing of B's, of the other carrier's, or of the shared tables moved.
      expect(await printOf(B)).toEqual(before.b);
      expect(await printOf(C)).toEqual(before.c);
      expect(await printOf(null)).toEqual(before.shared);
    });
  });

  it("changes nothing on a second run: the same rows, and the clear finds nothing", async () => {
    const before = await rowsOf(A);
    const b = await printOf(B);
    const report = await resetDemoTenant(app, A, planA);
    expect(Object.values(report.cleared).every((n) => n === 0)).toBe(true);
    // The arming log reports no deletes: the app role never deletes from it, and its rows went with
    // their drivers (the foreign key cascades) before the plan's log was written again.
    expect(report.replaced.deleted).toEqual({ ...countRows(planA.rows), driver_arm_events: 0 });
    expect(report.replaced.inserted).toEqual(countRows(planA.rows));
    expect(report.heroNetCents).toBe(HERO_OPEN_WEEK.netCents);
    expect(await rowsOf(A)).toEqual(before);
    expect(await rowsOf(A)).toEqual(sorted(planA.rows));
    expect(await printOf(B)).toEqual(b);
  });

  it("resets prairie-wind too, which has no hero", async () => {
    const a = await printOf(A);
    const report = await resetDemoTenant(app, B, planB);
    expect(report.heroNetCents).toBeNull();
    expect(report.cleared.money_actions).toBe(3);
    expect(await rowsOf(B)).toEqual(sorted(planB.rows));
    expect(await printOf(A)).toEqual(a);
  });

  it("refuses, deleting nothing, while a ledger row is still open, and the function refuses on its own too", async () => {
    await withMoneySwitches(async () => {
      const session = await dress(A, planA, "a");
      const advance = planA.rows.advances[2];
      expect(await requested(A, advance.id)).toBe(1);
      const open = await ledgerRow(
        session,
        {
          kind: "advance_payout",
          subjectId: advance.id,
          counterpartyId: advance.driver_id,
          amountCents: advance.amount_cents,
          proposedBy: "person",
          subjectStatuses: ["requested"],
        },
        "reserved",
      );
      const [a, b] = [await printOf(A), await printOf(B)];

      const refused = await errorOf(resetDemoTenant(app, A, planA));
      expect(refused).toBeInstanceOf(DemoResetRefused);
      expect((refused as DemoResetRefused).refusals).toEqual([{ kind: "open", count: 1 }]);
      expect((refused as Error).message).toBe(
        "1 payment record(s) still waiting to send, sent or not confirmed yet; settle them before a reset (nothing was cleared)",
      );
      // Past the app's own check, the function refuses under the tenant lock.
      expect(await sqlStateOf(clearDirectly(A))).toBe(RESET_SQLSTATE.refused);
      expect(await printOf(A)).toEqual(a);

      // Sent is still open; once the outcome is known the reset runs.
      await app.withTenant(A, async (q) => expect(await markSent(q, open)).toBe(true));
      expect(await errorOf(resetDemoTenant(app, A, planA))).toBeInstanceOf(DemoResetRefused);
      await app.withTenant(A, async (q) =>
        expect(
          await settle(q, open, {
            to: "confirmed",
            via: "response",
            outside: { system: "mock", type: "payout", id: "mock_reset_a_open", amountCents: advance.amount_cents },
          }),
        ).toBe(true),
      );
      const report = await resetDemoTenant(app, A, planA);
      expect(report.cleared.money_actions).toBe(4);
      expect(await rowsOf(A)).toEqual(sorted(planA.rows));
      expect(await printOf(B)).toEqual(b);
    });
  });

  it("refuses, deleting nothing, while a ledger row failed as amount_mismatch, until a person removes it", async () => {
    await withMoneySwitches(async () => {
      const session = await member(A, "mismatch");
      const advance = planA.rows.advances[3];
      expect(await requested(A, advance.id)).toBe(1);
      const mismatch = await ledgerRow(
        session,
        {
          kind: "advance_payout",
          subjectId: advance.id,
          counterpartyId: advance.driver_id,
          amountCents: advance.amount_cents,
          proposedBy: "person",
          subjectStatuses: ["requested"],
        },
        {
          to: "failed",
          via: "read_back",
          category: "amount_mismatch",
          outside: { system: "mock", type: "payout", id: "mock_reset_a_mismatch", amountCents: advance.amount_cents + 100 },
        },
      );
      const a = await printOf(A);
      const refused = await errorOf(resetDemoTenant(app, A, planA));
      expect((refused as DemoResetRefused).refusals).toEqual([{ kind: "mismatch", count: 1 }]);
      expect(await sqlStateOf(clearDirectly(A))).toBe(RESET_SQLSTATE.refused);
      expect(await printOf(A)).toEqual(a);

      // A person reviews it and removes it with the admin login; then the reset runs.
      await admin.withTenant(A, (q) =>
        q.execute("DELETE FROM money_actions WHERE tenant_id = CAST($1 AS uuid) AND id = CAST($2 AS uuid)", [
          A,
          mismatch,
        ]),
      );
      await resetDemoTenant(app, A, planA);
      expect(await rowsOf(A)).toEqual(sorted(planA.rows));
    });
  });

  it("refuses, deleting nothing, while a ledger row names a proposal an outside message flagged", async () => {
    await withMoneySwitches(async () => {
      const session = await member(A, "flagged");
      const advance = planA.rows.advances[4];
      const proposal = await agentChain(
        A,
        session,
        { kind: "advance_payout", table: "advances", id: advance.id, amountCents: advance.amount_cents },
        await seededInput(A),
      );
      expect(await requested(A, advance.id)).toBe(1);
      const row = await ledgerRow(
        session,
        {
          kind: "advance_payout",
          subjectId: advance.id,
          counterpartyId: advance.driver_id,
          amountCents: advance.amount_cents,
          proposedBy: "agent",
          proposalId: proposal,
          subjectStatuses: ["requested"],
        },
        {
          to: "confirmed",
          via: "response",
          outside: { system: "mock", type: "payout", id: "mock_reset_a_flagged", amountCents: advance.amount_cents },
        },
      );
      const a = await printOf(A);
      const refused = await errorOf(resetDemoTenant(app, A, planA));
      expect((refused as DemoResetRefused).refusals).toEqual([{ kind: "flagged", count: 1 }]);
      expect((refused as Error).message).toBe(
        "1 card(s) behind a payment record carry a flag from an outside message; a person must " +
          "review them before a reset (nothing was cleared)",
      );
      expect(await sqlStateOf(clearDirectly(A))).toBe(RESET_SQLSTATE.refused);
      expect(await printOf(A)).toEqual(a);

      await admin.withTenant(A, (q) =>
        q.execute("DELETE FROM money_actions WHERE tenant_id = CAST($1 AS uuid) AND id = CAST($2 AS uuid)", [A, row]),
      );
      const report = await resetDemoTenant(app, A, planA);
      expect(report.cleared.proposals).toBe(1);
      expect(await rowsOf(A)).toEqual(sorted(planA.rows));
    });
  });

  it("refuses a carrier that is not a demo one, and a transaction with no tenant, touching nothing", async () => {
    const [a, b, c, shared] = [await printOf(A), await printOf(B), await printOf(C), await printOf(null)];
    expect(c.proposals.n).toBe(1);
    expect(await sqlStateOf(clearDirectly(C))).toBe(RESET_SQLSTATE.notDemo);
    expect(await sqlStateOf(clearDirectly(null))).toBe(RESET_SQLSTATE.noTenant);
    // The app's own check stops first: the transaction's tenant is not the plan's carrier.
    const wrong = await errorOf(resetDemoTenant(app, C, planA));
    expect(wrong).toBeInstanceOf(DemoResetFailed);
    expect((wrong as Error).message).toBe("the current tenant is not blue-ridge");
    // B's plan on A's tenant is refused the same way.
    expect(await errorOf(resetDemoTenant(app, A, planB))).toBeInstanceOf(DemoResetFailed);
    expect(await printOf(A)).toEqual(a);
    expect(await printOf(B)).toEqual(b);
    expect(await printOf(C)).toEqual(c);
    expect(await printOf(null)).toEqual(shared);
  });

  it("refuses a carrier that took a demo slug unless its name and timezone are that carrier's too, touching nothing", async () => {
    // The app login may update its own tenant row: blue-ridge gives its slug up and the other
    // carrier takes it, each as payday_app under row-level security.
    const setTenant = (id: string, t: { slug: string; name: string; timezone: string }) =>
      app.withTenant(id, (q) =>
        q.execute(
          "UPDATE tenants SET slug = $1, name = $2, timezone = $3 WHERE id = current_tenant_id()",
          [t.slug, t.name, t.timezone],
        ),
      );
    expect(OTHER.name).not.toBe(BR.name);
    expect(OTHER.timezone).not.toBe(BR.timezone);
    expect(PW.timezone).not.toBe(BR.timezone);
    try {
      await setTenant(A, { ...BR, slug: `reset-moved-${A.slice(0, 8)}` });
      for (const pose of [
        { slug: BR.slug, name: OTHER.name, timezone: BR.timezone },
        { slug: BR.slug, name: BR.name, timezone: OTHER.timezone },
        // Each field is some demo carrier's, but not all three the same one's.
        { slug: BR.slug, name: PW.name, timezone: PW.timezone },
      ]) {
        await setTenant(C, pose);
        const [a, b, c, shared] = [await printOf(A), await printOf(B), await printOf(C), await printOf(null)];
        expect(c.proposals.n).toBe(1);
        expect(await sqlStateOf(clearDirectly(C)), JSON.stringify(pose)).toBe(RESET_SQLSTATE.notDemo);
        expect(await printOf(A)).toEqual(a);
        expect(await printOf(B)).toEqual(b);
        expect(await printOf(C)).toEqual(c);
        expect(await printOf(null)).toEqual(shared);
      }
    } finally {
      await setTenant(C, OTHER);
      await setTenant(A, BR);
    }
  });

  it("rolls the clear back when the replace fails after it, so the carrier is left as it was", async () => {
    await withMoneySwitches(async () => {
      await dress(A, planA, "a");
      const a = await printOf(A);
      // A plan that writes one customer twice: the insert fails after the clear has run.
      const broken: CarrierPlan = {
        ...planA,
        rows: { ...planA.rows, customers: [...planA.rows.customers, planA.rows.customers[0]] },
      };
      expect(await sqlStateOf(resetDemoTenant(app, A, broken))).toBe("23505");
      expect(await printOf(A)).toEqual(a);
      await resetDemoTenant(app, A, planA);
      expect(await rowsOf(A)).toEqual(sorted(planA.rows));
    });
  });
});
