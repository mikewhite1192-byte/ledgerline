import type { Param, Queryable } from "../db";
import {
  cents,
  type AdvanceInput,
  type CheckInput,
  type ReceivablesInput,
  type SettlementInput,
} from "../rules-engine";
import { localDateOf, type Instant, type LocalDate } from "../time/local-date";
import { isUuid } from "../uuid";
import { configFor, configForDay, sortVersions } from "./config-version";
import {
  checkInputOf,
  driverOf,
  loadsOf,
  payConfigOf,
  receivablesInputOf,
  settlementInputOf,
  advanceOf,
} from "./records";
import type { PayConfigRow, TenantRows } from "./rows";
import { assertIdentifier, TABLE_SPECS, TENANT_TABLES, type TenantTable } from "./tables";

// Read-only loaders for the tenant tables. SELECT only, always inside withTenant. The app role is
// bound by row-level security, but every statement still names its tenant
// (`tenant_id = current_tenant_id()`), so a login that bypasses row-level security (a cluster
// admin) also reads one tenant only. The engine readers at the bottom map rows to records with
// the same functions the seed uses (records.ts), so a seeded row and a row read back are equal.

// timestamptz comes back as one ISO form in UTC whatever the session time zone; jsonb comes back
// as text and is parsed here, because the Data API returns it as a string and pg as an object.
function selectExpr(column: string, kind: string): string {
  const col = assertIdentifier(column);
  if (kind === "timestamptz") {
    return `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${col}`;
  }
  if (kind === "jsonb") return `CAST(${col} AS text) AS ${col}`;
  return col;
}

// `where` is SQL written in this file, never input; values travel as parameters.
function selectSql(table: TenantTable, where?: string): string {
  const { columns } = TABLE_SPECS[table];
  const list = columns.map(([name, kind]) => selectExpr(name, kind)).join(", ");
  const order = assertIdentifier(columns[0][0]);
  const extra = where ? ` AND ${where}` : "";
  const from = `FROM ${assertIdentifier(table)} WHERE tenant_id = current_tenant_id()${extra}`;
  return `SELECT ${list} ${from} ORDER BY ${order}`;
}

const SELECT_SQL = Object.fromEntries(
  TENANT_TABLES.map((table) => [table, selectSql(table)]),
) as Record<TenantTable, string>;

const COUNT_SQL = `SELECT ${TENANT_TABLES.map(
  (t) =>
    `(SELECT count(*) FROM ${assertIdentifier(t)} WHERE tenant_id = current_tenant_id()) AS ${t}`,
).join(", ")}`;

export async function readTable<K extends TenantTable>(
  q: Queryable,
  table: K,
): Promise<TenantRows[K]> {
  return readRows(q, table, SELECT_SQL[table], []);
}

async function readRows<K extends TenantTable>(
  q: Queryable,
  table: K,
  sql: string,
  params: Param[],
): Promise<TenantRows[K]> {
  const rows = await q.query<Record<string, unknown>>(sql, params);
  const jsonColumns = TABLE_SPECS[table].columns.filter(([, kind]) => kind === "jsonb");
  for (const row of rows) {
    for (const [name] of jsonColumns) {
      const value = row[name];
      if (typeof value === "string") row[name] = JSON.parse(value);
    }
  }
  return rows as TenantRows[K];
}

export async function readTenantRows(q: Queryable): Promise<TenantRows> {
  const out: Partial<Record<TenantTable, unknown>> = {};
  for (const table of TENANT_TABLES) out[table] = await readTable(q, table);
  return out as TenantRows;
}

// Rows per table for the current tenant, in one statement.
export async function countTenantRows(q: Queryable): Promise<Record<TenantTable, number>> {
  const rows = await q.query<Record<TenantTable, number>>(COUNT_SQL);
  if (rows.length !== 1) throw new Error("count returned no row");
  const out = {} as Record<TenantTable, number>;
  for (const table of TENANT_TABLES) {
    const n = rows[0][table];
    if (!Number.isSafeInteger(n)) throw new Error("count is not a number");
    out[table] = n;
  }
  return out;
}

export type TenantSummary = { id: string; slug: string; name: string; timezone: string };

// The current tenant's own row, or null when app.tenant_id names no tenant.
export async function readTenant(q: Queryable): Promise<TenantSummary | null> {
  const rows = await q.query<TenantSummary>(
    "SELECT id, slug, name, timezone FROM tenants WHERE id = current_tenant_id()",
  );
  if (rows.length > 1) throw new Error("more than one tenant row");
  return rows[0] ?? null;
}

// ---- The engine's inputs ----

const BY_ID = "id = CAST($1 AS uuid)";
const BY_DRIVER = "driver_id = CAST($1 AS uuid)";
const BY_DRIVER_LOADS =
  "load_id IN (SELECT id FROM loads" +
  " WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid))";

function readWhere<K extends TenantTable>(
  q: Queryable,
  table: K,
  where: string,
  params: Param[],
): Promise<TenantRows[K]> {
  return readRows(q, table, selectSql(table, where), params);
}

function assertUuid(value: string, what: string): string {
  if (!isUuid(value)) throw new Error(`${what} is not a uuid`);
  return value;
}

// The current tenant's rows of one table whose id column equals one id (for example a driver's
// loads, or one invoice by its id). The column must be a uuid column of that table; the id
// travels as a parameter.
export async function readRowsWhereId<K extends TenantTable>(
  q: Queryable,
  table: K,
  column: string,
  id: string,
): Promise<TenantRows[K]> {
  const spec = TABLE_SPECS[table].columns.find(([name]) => name === column);
  if (!spec || spec[1] !== "uuid") throw new Error("not an id column of that table");
  const where = `${assertIdentifier(column)} = CAST($1 AS uuid)`;
  return readWhere(q, table, where, [assertUuid(id, column)]);
}

// Every version of the tenant's pay rules, oldest first (the settings page). Refuses a tenant with
// none, two on one date, or a week shape that changed between versions.
export async function readPayConfigVersions(q: Queryable): Promise<PayConfigRow[]> {
  return sortVersions(await readTable(q, "pay_configs"));
}

// The version a pay period runs under, given the period's first day; payConfigOf turns it into
// the engine's PayConfig.
export async function readPayConfigFor(
  q: Queryable,
  periodStart: LocalDate,
): Promise<PayConfigRow> {
  return configFor(await readPayConfigVersions(q), periodStart);
}

// Everything the six pay checks read, for the whole tenant, under the open period's version.
export async function readCheckInput(q: Queryable): Promise<CheckInput> {
  return checkInputOf({
    pay_configs: await readTable(q, "pay_configs"),
    settlement_periods: await readTable(q, "settlement_periods"),
    drivers: await readTable(q, "drivers"),
    loads: await readTable(q, "loads"),
    load_state_miles: await readTable(q, "load_state_miles"),
    load_accessorials: await readTable(q, "load_accessorials"),
    driver_days: await readTable(q, "driver_days"),
    fuel_purchases: await readTable(q, "fuel_purchases"),
    pay_items: await readTable(q, "pay_items"),
    advances: await readTable(q, "advances"),
  });
}

type DriverRows = Pick<
  TenantRows,
  | "pay_configs"
  | "drivers"
  | "loads"
  | "load_state_miles"
  | "load_accessorials"
  | "driver_days"
  | "pay_items"
  | "deduction_schedules"
  | "advances"
>;

// One driver's rows: the driver, their loads with miles and accessorials, days, items,
// schedules and advances, and every version of the tenant's pay rules.
async function readDriverRows(q: Queryable, driverId: string): Promise<DriverRows> {
  const p = [assertUuid(driverId, "driverId")];
  const drivers = await readWhere(q, "drivers", BY_ID, p);
  if (drivers.length !== 1) throw new Error("no such driver");
  return {
    pay_configs: await readTable(q, "pay_configs"),
    drivers,
    loads: await readWhere(q, "loads", BY_DRIVER, p),
    load_state_miles: await readWhere(q, "load_state_miles", BY_DRIVER_LOADS, p),
    load_accessorials: await readWhere(q, "load_accessorials", BY_DRIVER_LOADS, p),
    driver_days: await readWhere(q, "driver_days", BY_DRIVER, p),
    pay_items: await readWhere(q, "pay_items", BY_DRIVER, p),
    deduction_schedules: await readWhere(q, "deduction_schedules", BY_DRIVER, p),
    advances: await readWhere(q, "advances", BY_DRIVER, p),
  };
}

// One driver's settlement for one period, from the escrow balance the driver holds now.
export async function readSettlementInput(
  q: Queryable,
  driverId: string,
  periodId: string,
): Promise<SettlementInput> {
  const periods = await readWhere(q, "settlement_periods", BY_ID, [
    assertUuid(periodId, "periodId"),
  ]);
  if (periods.length !== 1) throw new Error("no such pay period");
  const rows = await readDriverRows(q, driverId);
  const period = { start: periods[0].period_start, end: periods[0].period_end };
  return settlementInputOf(rows, driverId, period);
}

// What advanceEligibility needs for one request: the date is the tenant's own, the loads
// delivered inside a paid period count as paid, and the pay rules are the version that the
// request's week will settle under.
export async function readAdvanceInput(
  q: Queryable,
  driverId: string,
  requestedAt: Instant,
  amountCents: number,
): Promise<AdvanceInput> {
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant is set");
  const rows = await readDriverRows(q, driverId);
  const paid = await readWhere(q, "settlement_periods", "status = $1", ["paid"]);
  const requestedOn = localDateOf(requestedAt, tenant.timezone);
  return {
    config: payConfigOf(configForDay(rows.pay_configs, requestedOn)),
    driver: driverOf(rows.drivers[0]),
    amountCents: cents(amountCents),
    requestedAt,
    requestedOn,
    loads: loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials),
    paidPeriods: paid.map((p) => ({ start: p.period_start, end: p.period_end })),
    advances: rows.advances.map(advanceOf),
  };
}

// Invoices, payments and applications, aged as of a tenant-local date.
export async function readReceivablesInput(
  q: Queryable,
  asOf: LocalDate,
): Promise<ReceivablesInput> {
  return receivablesInputOf(
    {
      invoices: await readTable(q, "invoices"),
      customer_payments: await readTable(q, "customer_payments"),
      payment_applications: await readTable(q, "payment_applications"),
    },
    asOf,
  );
}
