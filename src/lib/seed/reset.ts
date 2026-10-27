import { countTenantRows, readSettlementInput, readTenant } from "../data/read";
import { TENANT_TABLES, assertIdentifier, type TenantTable } from "../data/tables";
import { DbError, type Queryable, type TenantDb } from "../db/types";
import { settleDriver } from "../rules-engine";
import { HERO_OPEN_WEEK } from "./assert-plan";
import { carrierBySlug, type DemoCarrier } from "./carriers";
import type { CarrierPlan } from "./plan";
import { replaceInTransaction, verifyTenant, type SeedReport } from "./run";

// The demo reset (the admin button on /settings/demo and npm run demo:reset): put one demo carrier
// back to its seeded week, in ONE tenant transaction, as the app role.
//
//   1. the tenant is the plan's demo carrier (slug, name and time zone);
//   2. the refusals, read first so a person sees the counts: a ledger row still reserved, sent or
//      unknown, a row failed as amount_mismatch, or a flagged proposal a ledger row names. The
//      seed's fourth refusal (a ledger row naming a flow advance, FLOW_ADVANCE_ROWS in run.ts) is
//      not needed here on purpose: the function deletes every settled money_actions row before
//      the flow advances, in one transaction, so no ledger row can outlive the advance it names;
//   3. demo_reset_clear() (migration 0025), the one security-definer function, which checks the
//      same things again under the tenant row lock and deletes the settled ledger rows, the
//      agent's records and the fictional broker portal's loads (the app role has no DELETE on
//      them); the portal's loads come back only with npm run seed, since the app cannot write them;
//   4. the seed's replace of the 22 seeded tables, as the app role, under row-level security (the
//      arming log, which the app role may add to but never delete from, goes with its drivers
//      through the foreign key's cascade, and the plan's log is written again);
//   5. the read-back: every seeded table equals the plan, every cleared table is empty, and the
//      hero's open-week net is the worked example.
// Any failure rolls the whole transaction back, so a carrier is either reset or left as it was.
// The seed (npm run seed) splits the same work across two logins and three transactions; here
// one function call replaces its admin half, so nothing needs to survive a half-done run.

// The tables demo_reset_clear() empties for the carrier, each with why. A table in the database
// must be in exactly one of TENANT_TABLES, this list or DEMO_RESET_KEPT
// (src/lib/seed/reset-coverage.db.test.ts fails otherwise), so a new table gets a decision.
export const DEMO_RESET_CLEARED = {
  money_actions:
    "settled ledger rows, keyed kind:subject:attempt: against the re-created subjects they would " +
    "replay an old outcome or block a subject for good",
  documents: "uploaded paperwork and its reading; each names an inbound message the replace deletes",
  evidence_clips: "uploaded dock clips and their readings; each names a load the replace deletes",
  portal_evidence: "what each portal run found; it names a run that goes and a load the replace deletes",
  portal_run_checks: "the safety checks of the portal runs that go",
  portal_run_steps: "the steps and screenshots of the portal runs that go",
  portal_sessions: "the portal sign-in codes; a run's code names the run, which goes",
  portal_runs: "the agent's portal runs; each names a load the replace deletes",
  portal_loads:
    "the fictional broker portal's loads; each names a load the replace deletes, and only the " +
    "seed's admin login writes them back (npm run seed)",
  voice_note_audio: "the recording of each voice note that goes; it names its note",
  voice_notes: "each names a driver, an inbound message and a conversation that go",
  driver_notes: "each names a settlement, a driver and a pay period the replace deletes",
  turn_steps: "the agent's steps of the turns that go",
  sweep_items:
    "the pay sweep's findings; each names a run that goes, a pay week the replace deletes and " +
    "its drafted proposal",
  sweep_runs: "the pay sweep's runs; each names a pay week the replace deletes and a conversation that goes",
  approval_batches:
    "approve-all batches; each lists items that go, is named by the proposals it approved and names a " +
    "pay week the replace deletes",
  pay_rule_changes:
    "what each saved pay rule change changed (0030); each names its proposal, which goes, and the " +
    "pay rules version it wrote, which the replace rewrites",
  proposals:
    "the agent's proposals and the invoice queue's cards (0015); each names a subject, an " +
    "outside message or a ledger row the replace deletes",
  turns: "the agent's turns, which point at the inputs and subjects that go",
  conversations: "the agent's conversations, empty once their turns go",
} as const;

// The tables the reset never touches, each with why.
export const DEMO_RESET_KEPT = {
  tenants:
    "the carrier itself, with its document key (0015), so the invoice and payment numbers it " +
    "sends keep the same key",
  memberships: "the staff and admin logins, so nobody is signed out of the carrier",
  model_calls: "the record of every model charge",
  portal_accounts:
    "the carrier's sign-in account on the fictional broker portal; it names only the carrier, and " +
    "only the seed's admin login writes it",
  gateway_decisions:
    "the gateway's append-only audit log; it names nothing the reset deletes, and a deleted " +
    "turn only clears its turn_id",
  spend_alerts:
    "the record that a model job was stopped and which admin let it run again; the app login " +
    "cannot delete it, and its trace_id has no foreign key, so it names nothing the reset deletes",
  qbo_connections: "the QuickBooks sandbox link",
  qbo_oauth_states: "short-lived sign-in states for the sandbox link",
  qbo_entity_ids: "the sandbox entity map, still valid because the seed's ids are the same at the same anchor",
  schema_migrations: "the migration record, not tenant data",
  "ops.ai_spend": "the one model credit every tenant shares",
} as const;

export type ClearedTable = keyof typeof DEMO_RESET_CLEARED;
export type ResetTable = TenantTable | ClearedTable;

export const CLEARED_TABLES = Object.keys(DEMO_RESET_CLEARED) as ClearedTable[];
export const RESET_TABLES: readonly ResetTable[] = [...TENANT_TABLES, ...CLEARED_TABLES];

// What demo_reset_clear() reports: the cleared tables, plus the advances an approval created
// (they name a proposal; the replace rewrites the rest of advances).
export const FUNCTION_TABLES: readonly (ClearedTable | "advances")[] = [
  "money_actions",
  "documents",
  "evidence_clips",
  "portal_evidence",
  "portal_run_checks",
  "portal_run_steps",
  "portal_sessions",
  "portal_runs",
  "portal_loads",
  "voice_note_audio",
  "voice_notes",
  "driver_notes",
  "turn_steps",
  "sweep_items",
  "sweep_runs",
  "approval_batches",
  "pay_rule_changes",
  "advances",
  "proposals",
  "turns",
  "conversations",
];

// Plain names for the page and the script.
export const TABLE_LABELS: Record<ResetTable, string> = {
  customers: "Customers",
  drivers: "Drivers",
  driver_cards: "Fuel cards on file (test mode)",
  driver_identities: "Driver ids in the dispatch system",
  driver_arm_events: "Changes to who is armed to receive money",
  loads: "Loads",
  load_state_miles: "Miles by state",
  load_accessorials: "Load charges (detention and other extras)",
  driver_days: "Driver days",
  fuel_purchases: "Fuel purchases",
  pay_configs: "Pay rules",
  deduction_schedules: "Deduction schedules",
  settlement_periods: "Pay weeks",
  settlements: "Settlements",
  settlement_lines: "Settlement lines",
  pay_items: "Pay items",
  advances: "Advances",
  invoices: "Invoices",
  customer_payments: "Customer payments",
  payment_applications: "Payment applications",
  untrusted_inputs: "Inbound messages",
  screenings: "Message screenings",
  money_actions: "Settled payouts and bookings (test mode)",
  documents: "Uploaded documents",
  evidence_clips: "Dock clips",
  portal_evidence: "Broker portal findings",
  portal_run_checks: "Broker portal safety checks",
  portal_run_steps: "Broker portal run steps",
  portal_sessions: "Broker portal sign-in codes",
  portal_runs: "Broker portal runs",
  portal_loads: "Broker portal loads",
  voice_note_audio: "Voice note recordings",
  voice_notes: "Voice notes",
  driver_notes: "Driver notes",
  turn_steps: "Agent steps",
  sweep_items: "Pay sweep findings",
  sweep_runs: "Pay sweep runs",
  approval_batches: "Approve-all batches",
  pay_rule_changes: "Pay rule changes",
  proposals: "Agent proposals",
  turns: "Agent turns",
  conversations: "Agent conversations",
};

// The SQLSTATEs demo_reset_clear() raises (0025).
export const RESET_SQLSTATE = { noTenant: "LR001", notDemo: "LR002", refused: "LR003" } as const;

export type Refusal = { kind: "open" | "mismatch" | "flagged"; count: number };

// Counts only, never a row's contents; the script prints these and the page shows them.
export function refusalText(r: Refusal): string {
  switch (r.kind) {
    case "open":
      return `${r.count} ledger row(s) still reserved, sent or unknown; settle them before a reset`;
    case "mismatch":
      return `${r.count} ledger row(s) failed as amount_mismatch; a person must review them before a reset`;
    case "flagged":
      return (
        `${r.count} proposal(s) a ledger row names carry a flag from an outside message; ` +
        "a person must review them before a reset"
      );
  }
}

// The reset refused before deleting anything.
export class DemoResetRefused extends Error {
  readonly refusals: readonly Refusal[];
  constructor(refusals: readonly Refusal[]) {
    super(`${refusals.map(refusalText).join("; ")} (nothing was cleared)`);
    this.name = "DemoResetRefused";
    this.refusals = refusals;
  }
}

// A check of the reset's own failed (the wrong tenant, a read-back that differs from the plan, a
// count that is not a number). The transaction rolled back. The message is ours, never SQL text.
export class DemoResetFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoResetFailed";
  }
}

// The current tenant's demo carrier, or null when it is not one of the two.
export async function demoCarrierOf(q: Queryable): Promise<DemoCarrier | null> {
  const tenant = await readTenant(q);
  if (!tenant) return null;
  const carrier = carrierBySlug(tenant.slug);
  if (!carrier || carrier.name !== tenant.name || carrier.timezone !== tenant.timezone) return null;
  return carrier;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    // Unknown is not zero.
    throw new DemoResetFailed("a count read back is not a whole number");
  }
  return value;
}

const CLEARED_COUNT_SQL = `SELECT ${CLEARED_TABLES.map(
  (t) =>
    `(SELECT count(*) FROM ${assertIdentifier(t)} WHERE tenant_id = current_tenant_id()) AS ${t}`,
).join(", ")}`;

// Rows per table for the current tenant: the seeded tables and the ones the reset clears.
export async function readResetCounts(q: Queryable): Promise<Record<ResetTable, number>> {
  const seeded = await countTenantRows(q);
  const rows = await q.query<Record<ClearedTable, unknown>>(CLEARED_COUNT_SQL);
  if (rows.length !== 1) throw new DemoResetFailed("the counts returned no row");
  const out = { ...seeded } as Record<ResetTable, number>;
  for (const t of CLEARED_TABLES) out[t] = count(rows[0][t]);
  return out;
}

const REFUSAL_SQL = `SELECT
  (SELECT count(*) FROM money_actions m
    WHERE m.tenant_id = current_tenant_id() AND m.state IN ('reserved', 'sent', 'unknown')) AS open,
  (SELECT count(*) FROM money_actions m
    WHERE m.tenant_id = current_tenant_id() AND m.failure_category = 'amount_mismatch') AS mismatch,
  (SELECT count(*) FROM proposals p
    WHERE p.tenant_id = current_tenant_id() AND p.flagged_input_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM money_actions m
                   WHERE m.tenant_id = current_tenant_id() AND m.proposal_id = p.id)) AS flagged`;

// What would make the reset refuse, as counts; empty when it may run.
export async function readRefusals(q: Queryable): Promise<Refusal[]> {
  const rows = await q.query<{ open: unknown; mismatch: unknown; flagged: unknown }>(REFUSAL_SQL);
  if (rows.length !== 1) throw new DemoResetFailed("the refusal counts returned no row");
  const found: Refusal[] = [
    { kind: "open", count: count(rows[0].open) },
    { kind: "mismatch", count: count(rows[0].mismatch) },
    { kind: "flagged", count: count(rows[0].flagged) },
  ];
  return found.filter((r) => r.count > 0);
}

export type DemoResetPreview = {
  carrier: DemoCarrier;
  current: Record<ResetTable, number>;
  refusals: Refusal[];
};

// Read-only: what the carrier holds now and what would stop a reset. The page's confirm and the
// script's --dry-run show this.
export async function previewDemoReset(q: Queryable, carrier: DemoCarrier): Promise<DemoResetPreview> {
  await verifyTenant(q, carrier);
  return { carrier, current: await readResetCounts(q), refusals: await readRefusals(q) };
}

// The function's rows: exactly one per table it reports, each a whole number.
async function clearAsOwner(q: Queryable): Promise<Record<ClearedTable | "advances", number>> {
  const rows = await q.query<{ table_name: unknown; deleted: unknown }>(
    "SELECT table_name, deleted FROM demo_reset_clear()",
  );
  const out = {} as Record<ClearedTable | "advances", number>;
  for (const row of rows) {
    const name = row.table_name;
    if (typeof name !== "string" || !(FUNCTION_TABLES as readonly string[]).includes(name)) {
      throw new DemoResetFailed("the clear reported a table it should not touch");
    }
    if (Object.hasOwn(out, name)) throw new DemoResetFailed("the clear reported a table twice");
    out[name as ClearedTable | "advances"] = count(row.deleted);
  }
  if (Object.keys(out).length !== FUNCTION_TABLES.length) {
    throw new DemoResetFailed("the clear did not report every table");
  }
  return out;
}

// The hero's open-week net, read back and settled by the engine; null for a carrier with no hero.
async function heroNet(q: Queryable, plan: CarrierPlan): Promise<number | null> {
  if (!plan.carrier.heroCode) return null;
  const hero = plan.rows.drivers.find((d) => d.code === plan.carrier.heroCode);
  const open = plan.rows.settlement_periods.find((p) => p.status === "open");
  if (!hero || !open) throw new DemoResetFailed("the plan has no hero open week");
  return settleDriver(await readSettlementInput(q, hero.id, open.id)).netCents;
}

export type DemoResetReport = {
  slug: DemoCarrier["slug"];
  before: Record<ResetTable, number>;
  cleared: Record<ClearedTable | "advances", number>;
  replaced: SeedReport;
  after: Record<ResetTable, number>;
  heroNetCents: number | null;
};

// The reset, inside a tenant transaction the caller opened as the app role. Throws
// DemoResetRefused (nothing deleted), DemoResetFailed (a check failed), or the DbError of a
// statement; the caller's transaction then rolls back.
export async function resetDemoInTransaction(q: Queryable, plan: CarrierPlan): Promise<DemoResetReport> {
  try {
    await verifyTenant(q, plan.carrier);
    const before = await readResetCounts(q);
    const refusals = await readRefusals(q);
    if (refusals.length > 0) throw new DemoResetRefused(refusals);
    const cleared = await clearAsOwner(q);
    const replaced = await replaceInTransaction(q, plan);
    const after = await readResetCounts(q);
    for (const t of CLEARED_TABLES) {
      if (after[t] !== 0) throw new DemoResetFailed(`${t}: rows are left after the clear`);
    }
    for (const t of TENANT_TABLES) {
      if (after[t] !== replaced.inserted[t]) {
        throw new DemoResetFailed(`${t}: the rows read back differ from the plan`);
      }
    }
    const heroNetCents = await heroNet(q, plan);
    if (heroNetCents !== null && heroNetCents !== HERO_OPEN_WEEK.netCents) {
      throw new DemoResetFailed("the hero's open-week net read back is not the worked example");
    }
    return { slug: plan.carrier.slug, before, cleared, replaced, after, heroNetCents };
  } catch (err) {
    if (err instanceof DbError || err instanceof DemoResetRefused || err instanceof DemoResetFailed) {
      throw err;
    }
    // verifyTenant and the replace throw plain errors with messages of our own.
    throw new DemoResetFailed(err instanceof Error ? err.message : "the reset failed");
  }
}

// The same reset in its own tenant transaction, for npm run demo:reset.
export function resetDemoTenant(
  app: TenantDb,
  tenantId: string,
  plan: CarrierPlan,
): Promise<DemoResetReport> {
  return app.withTenant(tenantId, (q) => resetDemoInTransaction(q, plan));
}
