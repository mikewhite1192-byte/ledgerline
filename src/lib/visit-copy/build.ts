import { DEFAULT_RULES } from "../autopilot/defaults";
import { visitSub } from "../auth/claims";
import { countTenantRows } from "../data/read";
import { TENANT_TABLES, type TenantTable } from "../data/tables";
import { insertRows, insertStatements } from "../data/writer";
import type { Queryable, TenantDb } from "../db/types";
import { DEMO_ANCHOR } from "../seed/anchor";
import { HERO_OPEN_WEEK } from "../seed/assert-plan";
import type { DemoCarrier } from "../seed/carriers";
import { buildCarrierPlan, type CarrierPlan } from "../seed/plan";
import { heroNet } from "../seed/reset";
import { countRows } from "../seed/summary";
import { isUuid } from "../uuid";
import { remapPlanIds } from "./remap";
import { VISIT_EMAIL } from "./visitor";

export { VISIT_EMAIL };

// A visit's own copy of a demo carrier (flags.visitCopies), built in slices by the preparing page
// (src/app/preparing/actions.ts). The copy is a carrier of its own: a tenants row with the
// template's name and timezone, a slug of its own and demo_copy_of naming the template (0091); the
// visit's admin login visitSub(ticket) and the carrier's two service logins, as the demo setup
// writes them (scripts/lib/demo-rows.ts); the starting autopilot rules; the copy's own visit row,
// which its model spend and agent turns are counted on, ending when the visit does; then the
// template's seed plan at the demo anchor with every id the copy's own (./remap.ts).
//
// Each slice is one transaction in the copy's tenant, as the app login, under the copy's tenants
// row lock (two slices of one copy never run at once; the second waits, then finds the first's
// work). The first slice writes the setup rows; every slice then counts the copy's rows and
// inserts each table that is still empty, in TENANT_TABLES order (parents first), whole, and stops
// once a table finishes past the slice's time. A table is only ever written whole inside one
// committed transaction, so a table that holds some rows but not the plan's count was not written
// by this build: the slice fails closed instead of adding to it. Once every count equals the
// plan's, the hero's open-week net is read back through the engine (as the demo reset does), and
// only then is the copy done. The caller marks the visit ready in the demo carrier.
//
// Idempotent: the counts are the progress, and the row lock is the dedupe.

export type CopyTarget = {
  ticketId: string;
  copyTenantId: string;
  copySessionId: string;
  // The visit's expiry (ISO, UTC): the copy's own visit row ends with it.
  expiresAt: string;
  template: DemoCarrier;
};

export type SliceReport = {
  done: boolean;
  // This slice wrote the copy's setup rows: the build's first.
  setup: boolean;
  // Tables whose counts equal the plan's after this slice, of all of them.
  tablesDone: number;
  tablesTotal: number;
  // The statements this slice sent, setup and inserts, and how long it took.
  statements: number;
  ms: number;
};

// A copy build that cannot go on: the copy holds what this build did not write, or the hero's net
// read back is not the worked example. The message is ours, never SQL text.
export class CopyBuildFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyBuildFailed";
  }
}

// The copy's slug: the template's, "-v-" and the first eight hex digits of the copy's id.
export function copySlug(template: DemoCarrier, copyTenantId: string): string {
  if (!isUuid(copyTenantId)) throw new CopyBuildFailed("the copy id is not a uuid");
  return `${template.slug}-v-${copyTenantId.toLowerCase().replace(/-/g, "").slice(0, 8)}`;
}


// The setup's statements: the tenant insert, the three logins, the rules and the visit row.
const SETUP_STATEMENTS = 1 + 3 + DEFAULT_RULES.length + 1;

// The template plans, built once per process per demo carrier (about 400 ms each); every copy
// remaps its own from them.
const templates = new Map<string, CarrierPlan>();

export function templatePlan(template: DemoCarrier): CarrierPlan {
  let plan = templates.get(template.slug);
  if (!plan) {
    plan = buildCarrierPlan(template, DEMO_ANCHOR);
    templates.set(template.slug, plan);
  }
  return plan;
}

export function copyPlan(template: DemoCarrier, copyTenantId: string): CarrierPlan {
  return remapPlanIds(templatePlan(template), copyTenantId);
}

// ---- The slice planner (pure) ----

export type TableStep = { table: TenantTable; rows: number; statements: number };

// What is left to write: each table, in TENANT_TABLES order, whose count is not yet the plan's.
// A table with rows but not the plan's count throws (see above).
export function pendingTables(have: Record<TenantTable, number>, plan: CarrierPlan): TableStep[] {
  const want = countRows(plan.rows);
  const out: TableStep[] = [];
  for (const table of TENANT_TABLES) {
    if (have[table] === want[table]) continue;
    if (have[table] !== 0) throw new CopyBuildFailed(`${table}: the copy holds rows this build did not write`);
    const rows = plan.rows[table] as readonly Record<string, unknown>[];
    out.push({ table, rows: rows.length, statements: insertStatements(table, rows).length });
  }
  return out;
}

// The tables one slice writes, as buildCopySlice decides it, given how long a statement takes:
// from the front of the pending list, each started while the slice still has time, and always at
// least one, so every slice moves the build on. Pure, so the slicing is tested without a database.
export function sliceOf(pending: readonly TableStep[], msPerStatement: number, sliceMs: number): TableStep[] {
  const out: TableStep[] = [];
  let spent = 0;
  for (const step of pending) {
    if (out.length > 0 && spent >= sliceMs) break;
    out.push(step);
    spent += step.statements * msPerStatement;
  }
  return out;
}

// How many slices a whole build takes at msPerStatement (the setup counts in the first slice).
export function sliceCount(plan: CarrierPlan, msPerStatement: number, sliceMs: number): number {
  const empty = Object.fromEntries(TENANT_TABLES.map((t) => [t, 0])) as Record<TenantTable, number>;
  let pending = pendingTables(empty, plan);
  let n = 0;
  while (pending.length > 0) {
    const first = n === 0 ? SETUP_STATEMENTS * msPerStatement : 0;
    const slice = sliceOf(pending, msPerStatement, sliceMs - first);
    pending = pending.slice(slice.length);
    n += 1;
  }
  return n;
}

// The statements the whole build sends, setup included: the round trips the preparing page waits
// on (each slice adds its lock and count reads).
export function buildStatements(plan: CarrierPlan): number {
  let n = SETUP_STATEMENTS;
  for (const table of TENANT_TABLES) {
    n += insertStatements(table, plan.rows[table] as readonly Record<string, unknown>[]).length;
  }
  return n;
}

// ---- The slice ----

const LOCK_SQL = "SELECT id FROM tenants WHERE id = current_tenant_id() FOR UPDATE";

// The statements sent, and whether the setup rows were written (false: an earlier slice did).
async function writeSetup(q: Queryable, target: CopyTarget): Promise<{ statements: number; wrote: boolean }> {
  const { template } = target;
  const tenant = await q.execute(
    `INSERT INTO tenants (id, slug, name, timezone, demo_copy_of)
     VALUES (current_tenant_id(), $1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [copySlug(template, target.copyTenantId), template.name, template.timezone, template.slug],
  );
  if (tenant === 0) return { statements: 1, wrote: false };
  if (tenant !== 1) throw new CopyBuildFailed("the copy's carrier row was not written");
  const one = async (sql: string, params: (string | number | null)[], what: string) => {
    if ((await q.execute(sql, params)) !== 1) throw new CopyBuildFailed(`${what} was not written`);
  };
  await one(
    `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')`,
    [visitSub(target.ticketId), VISIT_EMAIL],
    "the visitor's login",
  );
  await one(
    `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
     VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), $1, 'staff')`,
    [`sweep@${copySlug(template, target.copyTenantId)}.invalid`],
    "the sweep's login",
  );
  await one(
    `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
     VALUES (current_tenant_id(), 'service:autopilot:' || CAST(current_tenant_id() AS text), $1, 'staff')`,
    [`autopilot@${copySlug(template, target.copyTenantId)}.invalid`],
    "the autopilot's login",
  );
  for (const rule of DEFAULT_RULES) {
    await one(
      `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count,
                                   driver_day_max_cents, updated_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, 'setup')`,
      [rule.kind, rule.mode, rule.maxCents, rule.dayMaxCents, rule.dayMaxCount, rule.driverDayMaxCents],
      "an autopilot rule",
    );
  }
  await one(
    `INSERT INTO demo_sessions (id, tenant_id, cognito_sub, created_at, last_seen_at, expires_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $2, now(), now(), CAST($3 AS timestamptz))`,
    [target.copySessionId, visitSub(target.ticketId), target.expiresAt],
    "the copy's visit row",
  );
  return { statements: SETUP_STATEMENTS, wrote: true };
}

export type SliceOptions = { sliceMs: number; clock?: () => number };

// One slice, in its own transaction in the copy's tenant (db is the app login).
export async function buildCopySlice(db: TenantDb, target: CopyTarget, opts: SliceOptions): Promise<SliceReport> {
  const clock = opts.clock ?? (() => Date.now());
  if (!isUuid(target.ticketId) || !isUuid(target.copyTenantId) || !isUuid(target.copySessionId)) {
    throw new CopyBuildFailed("an id of the copy is not a uuid");
  }
  if (!Number.isSafeInteger(opts.sliceMs) || opts.sliceMs <= 0) throw new CopyBuildFailed("the slice time is not set");
  const started = clock();
  const plan = copyPlan(target.template, target.copyTenantId);
  return db.withTenant(target.copyTenantId, async (q) => {
    const setup = await writeSetup(q, target);
    let statements = setup.statements;
    // The lock: a second slice of this copy waits here for the first to commit.
    const locked = await q.query<{ id: string }>(LOCK_SQL, []);
    statements += 1;
    if (locked.length !== 1) throw new CopyBuildFailed("the copy's carrier row is missing");
    let pending = pendingTables(await countTenantRows(q), plan);
    statements += 1;
    // At least one table a slice, then each next one while the slice still has time.
    let wrote = 0;
    while (pending.length > 0 && (wrote === 0 || clock() - started < opts.sliceMs)) {
      const step = pending[0];
      await insertRows(q, step.table, plan.rows[step.table] as readonly Record<string, unknown>[]);
      statements += step.statements;
      pending = pending.slice(1);
      wrote += 1;
    }
    const tablesDone = TENANT_TABLES.length - pending.length;
    if (pending.length === 0) {
      // The whole copy: every count read back, then the hero's week through the engine.
      const after = pendingTables(await countTenantRows(q), plan);
      statements += 1;
      if (after.length !== 0) throw new CopyBuildFailed("the copy's rows read back differ from the plan");
      const net = await heroNet(q, plan);
      statements += 1;
      if (net !== null && net !== HERO_OPEN_WEEK.netCents) {
        throw new CopyBuildFailed("the hero's open-week net read back is not the worked example");
      }
    }
    return {
      done: pending.length === 0,
      setup: setup.wrote,
      tablesDone,
      tablesTotal: TENANT_TABLES.length,
      statements,
      ms: clock() - started,
    };
  });
}
