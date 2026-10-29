import type { Param, Queryable } from "../db";
import {
  cents,
  driverPayOnLoad,
  type AdvanceInput,
  type CashFridayInput,
  type CashFridayLimits,
  type CheckInput,
  type CustomerRecord,
  type LoadRecord,
  type ReceivablesInput,
  type SettlementInput,
} from "../rules-engine";
import {
  assertLocalDate,
  localDateOf,
  type Instant,
  type LocalDate,
  type Period,
} from "../time/local-date";
import { isUuid } from "../uuid";
import { configFor, configForDay, sortVersions } from "./config-version";
import {
  cashFridayInputOf,
  checkInputOf,
  customerOf,
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

// The escrow lines of the current tenant's settlements, at most one per settlement. Each line's
// meta holds the escrow balance its week started from (balanceBeforeCents), as the engine wrote it.
export const ESCROW_LINES = "kind = 'escrow'";
export async function readEscrowLines(q: Queryable): Promise<TenantRows["settlement_lines"]> {
  return readWhere(q, "settlement_lines", ESCROW_LINES, []);
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
  loadId?: string | null,
): Promise<AdvanceInput> {
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant is set");
  const rows = await readDriverRows(q, driverId);
  const paid = await readWhere(q, "settlement_periods", "status = $1", ["paid"]);
  const requestedOn = localDateOf(requestedAt, tenant.timezone);
  const config = payConfigOf(configForDay(rows.pay_configs, requestedOn));
  const driver = driverOf(rows.drivers[0]);
  const loads = loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials);
  // The load the advance is for, with the driver's pay on it. One that is not this driver's
  // (another driver's, or no load at all) reads as null, and the caller refuses load_not_drivers.
  let load: AdvanceInput["load"] = null;
  if (loadId !== undefined && loadId !== null) {
    const own = loads.find((l) => l.id === assertUuid(loadId, "loadId"));
    load = own ? { id: own.id, payCents: driverPayOnLoad(config, driver, own) } : null;
  }
  return {
    config,
    driver,
    amountCents: cents(amountCents),
    requestedAt,
    requestedOn,
    loads,
    paidPeriods: paid.map((p) => ({ start: p.period_start, end: p.period_end })),
    advances: rows.advances.map(advanceOf),
    load,
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

// Everything Cash Friday reads, whole, for the current tenant (design 4.2). SELECT only; the zone
// is the tenant's own, used to turn paid instants into dates.
export async function readCashFridayInput(
  q: Queryable,
  zone: string,
  limits: CashFridayLimits,
): Promise<CashFridayInput> {
  return cashFridayInputOf(
    {
      pay_configs: await readTable(q, "pay_configs"),
      settlement_periods: await readTable(q, "settlement_periods"),
      settlements: await readTable(q, "settlements"),
      drivers: await readTable(q, "drivers"),
      loads: await readTable(q, "loads"),
      load_state_miles: await readTable(q, "load_state_miles"),
      load_accessorials: await readTable(q, "load_accessorials"),
      driver_days: await readTable(q, "driver_days"),
      pay_items: await readTable(q, "pay_items"),
      deduction_schedules: await readTable(q, "deduction_schedules"),
      advances: await readTable(q, "advances"),
      invoices: await readTable(q, "invoices"),
      customer_payments: await readTable(q, "customer_payments"),
      payment_applications: await readTable(q, "payment_applications"),
      vendor_bills: await readTable(q, "vendor_bills"),
      cash_settings: await readTable(q, "cash_settings"),
    },
    zone,
    limits,
  );
}

// Only the named tables, whole, for the current tenant: what one report reads. A report is a view
// over the whole tenant, so nothing is filtered here; the report's own code picks the rows.
export async function readReportInput<K extends TenantTable>(
  q: Queryable,
  tables: readonly K[],
): Promise<Pick<TenantRows, K>> {
  const out: Partial<Record<TenantTable, unknown>> = {};
  for (const table of tables) out[table] = await readTable(q, table);
  return out as Pick<TenantRows, K>;
}

// The invoice queue's rows: delivered loads from `start` on (a tenant-local date) with no invoice
// yet, with their state miles and accessorials, and the tenant's customers. The split by the rules
// engine is src/lib/invoices/queue.ts.
// Exported so a test's fake database can match these statements whole.
export const QUEUE_LOADS =
  "status = 'delivered' AND delivered_on >= CAST($1 AS date) AND NOT EXISTS (" +
  "SELECT 1 FROM invoices i WHERE i.tenant_id = current_tenant_id() AND i.load_id = loads.id)";
export const QUEUE_CHILDREN =
  "load_id IN (SELECT l.id FROM loads l WHERE l.tenant_id = current_tenant_id()" +
  " AND l.status = 'delivered' AND l.delivered_on >= CAST($1 AS date) AND NOT EXISTS (" +
  "SELECT 1 FROM invoices i WHERE i.tenant_id = current_tenant_id() AND i.load_id = l.id))";

export async function readInvoiceQueue(
  q: Queryable,
  start: LocalDate,
): Promise<{ loads: LoadRecord[]; customers: CustomerRecord[] }> {
  const from = assertLocalDate(start, "queue start");
  const loads = await readWhere(q, "loads", QUEUE_LOADS, [from]);
  const miles = await readWhere(q, "load_state_miles", QUEUE_CHILDREN, [from]);
  const accessorials = await readWhere(q, "load_accessorials", QUEUE_CHILDREN, [from]);
  const customers = await readTable(q, "customers");
  return { loads: loadsOf(loads, miles, accessorials), customers: customers.map(customerOf) };
}

// A paged read that reached its page bound. The whole read fails: a partial set is never returned.
export class ReadLimitError extends Error {
  readonly category = "too_many_rows";

  constructor() {
    super("read stopped at its page bound: too_many_rows");
    this.name = "ReadLimitError";
  }
}

// Rows per statement and statements per table for a paged read. A page of the widest of the
// month's tables (a load, under 1 KB as JSON) stays far under the Data API's 1 MiB response cap;
// the bound (100,000 rows of one table in one month) stops a runaway read.
export type Paging = { pageSize: number; maxPages: number };
const DELIVERED_PAGING: Paging = { pageSize: 200, maxPages: 500 };

// readWhere in pages, keyed on the table's uuid primary key (its first column, the one selectSql
// orders by): every matching row once, in the order one unpaged read gives. A page shorter than
// the page size ends the read, so an exact multiple ends with one empty page.
async function readWherePaged<K extends TenantTable>(
  q: Queryable,
  table: K,
  where: string,
  params: Param[],
  paging: Paging,
): Promise<TenantRows[K]> {
  const { pageSize, maxPages } = paging;
  for (const n of [pageSize, maxPages]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("paging is not a positive count");
  }
  const [key, kind] = TABLE_SPECS[table].columns[0];
  if (kind !== "uuid") throw new Error("a paged read needs a uuid key");
  const after = `${assertIdentifier(key)} > CAST($${params.length + 1} AS uuid)`;
  const first = `${selectSql(table, `(${where})`)} LIMIT ${pageSize}`;
  const next = `${selectSql(table, `(${where}) AND ${after}`)} LIMIT ${pageSize}`;
  const out: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const rows: unknown[] =
      cursor === null
        ? await readRows(q, table, first, params)
        : await readRows(q, table, next, [...params, cursor]);
    if (rows.length > pageSize) throw new Error("a page is larger than its page size");
    out.push(...rows);
    if (rows.length < pageSize) return out as TenantRows[K];
    const last = (rows[rows.length - 1] as Record<string, unknown>)[key];
    if (!isUuid(last)) throw new Error("a page key is not a uuid");
    cursor = last;
  }
  throw new ReadLimitError();
}

// Loads delivered inside one tenant-local date range, first to last day, and only the rows those
// loads need: their customers, state miles, accessorials and invoices. The other tables are read
// through the same delivered-date filter on loads, so a month's read never pulls the rest of the
// tenant's history, and each table is read in pages, because the Data API ends a statement whose
// result passes 1 MiB.
const DELIVERED_BETWEEN = "delivered_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)";
const DELIVERED_LOADS =
  "load_id IN (SELECT id FROM loads" +
  ` WHERE tenant_id = current_tenant_id() AND ${DELIVERED_BETWEEN})`;
const DELIVERED_CUSTOMERS =
  "id IN (SELECT customer_id FROM loads" +
  ` WHERE tenant_id = current_tenant_id() AND ${DELIVERED_BETWEEN})`;

export type DeliveredRows = Pick<
  TenantRows,
  "loads" | "customers" | "load_state_miles" | "load_accessorials" | "invoices"
>;

export async function readDeliveredBetween(
  q: Queryable,
  period: Period,
  paging: Paging = DELIVERED_PAGING,
): Promise<DeliveredRows> {
  const start = assertLocalDate(period.start, "period start");
  const end = assertLocalDate(period.end, "period end");
  if (end < start) throw new RangeError("period ends before it starts");
  const p = [start, end];
  return {
    loads: await readWherePaged(q, "loads", DELIVERED_BETWEEN, p, paging),
    customers: await readWherePaged(q, "customers", DELIVERED_CUSTOMERS, p, paging),
    load_state_miles: await readWherePaged(q, "load_state_miles", DELIVERED_LOADS, p, paging),
    load_accessorials: await readWherePaged(q, "load_accessorials", DELIVERED_LOADS, p, paging),
    invoices: await readWherePaged(q, "invoices", DELIVERED_LOADS, p, paging),
  };
}
