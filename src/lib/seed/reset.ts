import { countTenantRows, readSettlementInput, readTenant } from "../data/read";
import { TENANT_TABLES, assertIdentifier, type TenantTable } from "../data/tables";
import { DbError, type Queryable, type TenantDb } from "../db/types";
import { settleDriver } from "../rules-engine";
import { HERO_OPEN_WEEK } from "./assert-plan";
import { demoCarrierFor, type DemoCarrier } from "./carriers";
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
//   3. demo_reset_clear() (migration 0025, re-created whole by later migrations: 0033, then 0034 to
//      empty the fuel checks too, then 0036 to empty the pay rule changes, then 0038 with the Inbox
//      messages, then 0066 with the rate confirmation readings, then 0069 with the escrow
//      releases, then 0072 with the agent's questions, then 0078 with the driver deficits, then
//      0080 with the card pull-backs), the
//      one security-definer function, which checks the same things again under the tenant row
//      lock and deletes the settled ledger rows,
//      the agent's records and the fictional broker portal's loads (the app role has no DELETE on
//      them); the portal's loads come back only with npm run seed, since the app cannot write them;
//   4. the seed's replace of the 49 seeded tables (TENANT_TABLES, with Cash Friday's checks, the
//      money codes, the card check's runs and differences, the pinned fuel and tax rates, the
//      drivers' status log, the activation steps and the phone line's calls, segments and turns,
//      which the seed leaves empty), as the app role, under
//      row-level security (the arming log, the status log, the activation steps and the calls,
//      which the app role may add to but never delete from, go with their drivers through the
//      foreign keys' cascades, and the plan's arming log is written again);
//   5. the read-back: every seeded table equals the plan, every cleared table is empty, and the
//      hero's open-week net is the worked example;
//   6. the autopilot paused for 30 minutes (paused_by demo_reset), so it approves nothing on the
//      fresh rows while a person looks them over; the desk writes "skipped reset_pause" for what it
//      meets meanwhile. A pause a person set with no end stays as it is, and a longer one is kept.
//      The owner's autopilot rules are kept; each proposal's autopilot decision goes with it.
// Any failure rolls the whole transaction back, so a carrier is either reset or left as it was.
// The seed (npm run seed) splits the same work across two logins and three transactions; here
// one function call replaces its admin half, so nothing needs to survive a half-done run.

// The tables demo_reset_clear() empties for the carrier, each with why. A table in the database
// must be in exactly one of TENANT_TABLES, this list or DEMO_RESET_KEPT
// (src/lib/seed/reset-coverage.db.test.ts fails otherwise), so a new table gets a decision.
export const DEMO_RESET_CLEARED = {
  card_pullbacks:
    "each fuel card pull-back (0080); it names a ledger row and a proposal that go, and the app " +
    "role cannot delete it",
  escrow_releases:
    "each terminated driver's escrow release (0069); it names a ledger row and a proposal that go, " +
    "and the app role cannot delete it",
  money_actions:
    "settled ledger rows, keyed kind:subject:attempt: against the re-created subjects they would " +
    "replay an old outcome or block a subject for good",
  ratecon_reads:
    "each rate confirmation's second reading and the load id it holds (0066); it names a document " +
    "that goes and an inbound message the replace deletes",
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
  inbound_messages: "messages the office pasted or received; the demo starts with an empty Inbox",
  voice_note_audio: "the recording of each voice note that goes; it names its note",
  voice_notes: "each names a driver, an inbound message and a conversation that go",
  driver_notes: "each names a settlement, a driver and a pay period the replace deletes",
  turn_steps: "the agent's steps of the turns that go",
  sweep_fanout_checks:
    "the sweep's second check of each driver (0024); each names a run that goes, a driver the " +
    "replace deletes and a turn that goes",
  sweep_fanout: "the sweep's second check of each run (0024); each names a run and turns that go",
  sweep_items:
    "the pay sweep's findings; each names a run that goes, a pay week the replace deletes and " +
    "its drafted proposal",
  sweep_runs: "the pay sweep's runs; each names a pay week the replace deletes and a conversation that goes",
  fuel_findings:
    "the fuel checks' findings (0031); each names a fill-up, a driver, a load and a pay line the " +
    "replace deletes, and the card it drafted",
  fuel_check_runs: "the fuel checks' runs; each is named by the findings that go",
  approval_batches:
    "approve-all batches; each lists items that go, is named by the proposals it approved and names a " +
    "pay week the replace deletes",
  pay_rule_changes:
    "what each saved pay rule change changed (0030); each names its proposal, which goes, and the " +
    "pay rules version it wrote, which the replace rewrites",
  driver_deficits:
    "what a card load ruling booked as money a driver owes (0078); each names the proposal that " +
    "booked it, which goes, and a driver the replace rewrites, and the app role cannot delete them",
  agent_asks:
    "the agent's questions and told lines about its proposals (0072); each names a proposal that " +
    "goes, and the app role cannot delete them",
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
  memberships: "the staff, admin and demo visitor logins, so nobody is signed out of the carrier",
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
  desk_loops:
    "the desk loop's own row per carrier (running since, lease, watermarks), kept so its running-since " +
    "date survives a reset; it names only the carrier",
  desk_log:
    "the desk loop's insert-only log, kept so the events it handled survive a reset; its subject ids " +
    "have no foreign key, so it names nothing the reset deletes, and a day's sweep whose run the " +
    "reset deletes is found again as that day's next go (src/lib/desk/discover.ts)",
  autopilot_rules:
    "the owner's Off, Ask me or Auto rule and limits per action kind (0070); it names only the " +
    "carrier, and the owner's choices survive a reset",
  autopilot_state:
    "the carrier's Pause autopilot switch (0070); it names only the carrier, and the reset itself " +
    "sets a 30 minute pause on it",
  demo_sessions:
    "each demo visitor's sign-in with its spend and turn counts (0043); it names only the carrier, " +
    "the app login cannot delete it, and a reset must not hand a visitor a fresh budget",
  tms_wakeups:
    "the dispatch webhook's waiting wake-ups (0083); each names only the carrier and a dispatch " +
    "record id, so one kept over a reset only reads that record again",
  tms_hook_minutes:
    "the dispatch webhook's calls a minute (0083); it names only the carrier, and a reset must not " +
    "hand the webhook a fresh minute",
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
  "card_pullbacks",
  "escrow_releases",
  "money_actions",
  "ratecon_reads",
  "documents",
  "evidence_clips",
  "portal_evidence",
  "portal_run_checks",
  "portal_run_steps",
  "portal_sessions",
  "portal_runs",
  "portal_loads",
  "inbound_messages",
  "voice_note_audio",
  "voice_notes",
  "driver_notes",
  "turn_steps",
  "sweep_fanout_checks",
  "sweep_fanout",
  "sweep_items",
  "sweep_runs",
  "fuel_findings",
  "fuel_check_runs",
  "approval_batches",
  "pay_rule_changes",
  "advances",
  "driver_deficits",
  "agent_asks",
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
  driver_status_events: "Drivers deactivated or reactivated",
  driver_activation_steps: "Activation steps recorded before arming",
  loads: "Loads",
  load_events: "Load moves",
  tms_connections: "Dispatch connection",
  tms_parties: "Dispatch parties",
  tms_loads: "Dispatch loads",
  tms_stops: "Dispatch stops",
  tms_status_events: "Dispatch status history",
  tms_line_items: "Dispatch line items",
  tms_documents: "Dispatch documents",
  load_state_miles: "Miles by state",
  load_accessorials: "Load charges (detention and other extras)",
  driver_days: "Driver days",
  fuel_purchases: "Fuel purchases",
  card_transactions: "Card provider statement (test mode)",
  pay_configs: "Pay rules",
  deduction_schedules: "Deduction schedules",
  settlement_periods: "Pay weeks",
  settlements: "Settlements",
  settlement_lines: "Settlement lines",
  pay_cards: "Pay cards",
  pay_items: "Pay items",
  money_codes: "Money codes (test mode)",
  advances: "Advances",
  invoices: "Invoices",
  customer_payments: "Customer payments",
  payment_applications: "Payment applications",
  untrusted_inputs: "Inbound messages",
  screenings: "Message screenings",
  calls: "Phone line calls",
  call_segments: "Phone line call segments",
  call_turns: "Phone line call turns",
  card_recon_runs: "Card checks",
  card_recon_breaks: "Card check differences",
  collection_drafts: "Collection reminders",
  briefs: "Profit briefs",
  carrier_notes: "Memory notes",
  pinned_rates: "Pinned fuel and tax rates",
  card_pullbacks: "Card pull-backs (test mode)",
  escrow_releases: "Escrow releases (test mode)",
  money_actions: "Settled payouts and bookings (test mode)",
  ratecon_reads: "Rate confirmation readings",
  documents: "Uploaded documents",
  evidence_clips: "Dock clips",
  portal_evidence: "Broker portal findings",
  portal_run_checks: "Broker portal safety checks",
  portal_run_steps: "Broker portal run steps",
  portal_sessions: "Broker portal sign-in codes",
  portal_runs: "Broker portal runs",
  portal_loads: "Broker portal loads",
  inbound_messages: "Inbox messages",
  voice_note_audio: "Voice note recordings",
  voice_notes: "Voice notes",
  driver_notes: "Driver notes",
  turn_steps: "Agent steps",
  sweep_fanout_checks: "Pay sweep second checks by driver",
  sweep_fanout: "Pay sweep second checks",
  sweep_items: "Pay sweep findings",
  sweep_runs: "Pay sweep runs",
  fuel_findings: "Fuel check findings",
  fuel_check_runs: "Fuel check runs",
  approval_batches: "Approve-all batches",
  pay_rule_changes: "Pay rule changes",
  driver_deficits: "Driver deficits",
  agent_asks: "Agent questions",
  proposals: "Agent cards",
  turns: "Agent turns",
  conversations: "Agent conversations",
  vendor_bills: "Vendor bills",
  cash_settings: "Bank balance and cash settings",
  cash_checks: "Cash checks",
  factoring_requests: "Factoring requests (test mode)",
  factoring_request_invoices: "Factored invoices (test mode)",
};

// The SQLSTATEs demo_reset_clear() raises (0025).
export const RESET_SQLSTATE = { noTenant: "LR001", notDemo: "LR002", refused: "LR003" } as const;

export type Refusal = { kind: "open" | "mismatch" | "flagged"; count: number };

// Counts only, never a row's contents; the script prints these and the page shows them, so they
// use the page's words: a payment record, a card, waiting to send, not confirmed yet.
export function refusalText(r: Refusal): string {
  switch (r.kind) {
    case "open":
      return `${r.count} payment record(s) still waiting to send, sent or not confirmed yet; settle them before a reset`;
    case "mismatch":
      return `${r.count} payment record(s) failed because the amount did not match; a person must review them before a reset`;
    case "flagged":
      return (
        `${r.count} card(s) behind a payment record carry a flag from an outside message; ` +
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
  return demoCarrierFor(await readTenant(q));
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

// Step 6: pause the autopilot for 30 minutes from the transaction's own time. A pause with no end
// (a person's) is left alone; a timed pause ending later keeps its end.
const RESET_PAUSE_SQL = `INSERT INTO autopilot_state (tenant_id, paused_at, paused_by, paused_until, updated_at)
VALUES (current_tenant_id(), now(), 'demo_reset', now() + interval '30 minutes', now())
ON CONFLICT (tenant_id) DO UPDATE
  SET paused_at = EXCLUDED.paused_at, paused_by = EXCLUDED.paused_by,
      paused_until = greatest(EXCLUDED.paused_until, autopilot_state.paused_until),
      updated_at = EXCLUDED.updated_at
  WHERE NOT (autopilot_state.paused_at IS NOT NULL AND autopilot_state.paused_until IS NULL)`;

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
    await q.execute(RESET_PAUSE_SQL, []);
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
