import type { Param, Queryable } from "../db";
import { parseRead } from "../documents/schema";
import {
  cents,
  driverPayOnLoad,
  MONEY_CODE_PURPOSES,
  MONEY_CODE_STATUSES,
  type AdvanceInput,
  type CashFridayInput,
  type CashFridayLimits,
  type CheckInput,
  type CustomerRecord,
  type LoadRecord,
  type LoadStatus,
  type MoneyCodeInput,
  type MoneyCodePurpose,
  type MoneyCodeReceipt,
  type MoneyCodeRecord,
  type MoneyCodeSource,
  type MoneyCodeStatus,
  type MoneyCodeVoice,
  type ReceivablesInput,
  type SettlementInput,
} from "../rules-engine";
import {
  assertLocalDate,
  localDateOf,
  parseInstant,
  type Instant,
  type LocalDate,
  type Period,
} from "../time/local-date";
import { isUuid } from "../uuid";
import { extractAmountsCents } from "../voice/amount";
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
      factoring_request_invoices: await readTable(q, "factoring_request_invoices"),
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

// ---- IFTA quarter ----

// The IFTA quarter's inputs (design-ifta 3): the loads delivered in the quarter with their state
// miles, and the fuel bought in it, by its stored tenant-local purchase date. Each table is read in
// pages through the same bound as a month's loads, so a quarter of fuel never reaches the Data
// API's 1 MiB cap, and a read past the bound fails whole with ReadLimitError.
export const PURCHASED_BETWEEN = "purchased_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)";

export type IftaRows = Pick<TenantRows, "loads" | "load_state_miles" | "fuel_purchases">;

export async function readIftaInput(
  q: Queryable,
  quarter: Period,
  paging: Paging = DELIVERED_PAGING,
): Promise<IftaRows> {
  const start = assertLocalDate(quarter.start, "quarter start");
  const end = assertLocalDate(quarter.end, "quarter end");
  if (end < start) throw new RangeError("quarter ends before it starts");
  const p = [start, end];
  return {
    loads: await readWherePaged(q, "loads", DELIVERED_BETWEEN, p, paging),
    load_state_miles: await readWherePaged(q, "load_state_miles", DELIVERED_LOADS, p, paging),
    fuel_purchases: await readWherePaged(q, "fuel_purchases", PURCHASED_BETWEEN, p, paging),
  };
}

// ---- Year-end 1099 ----

// The year-end 1099's inputs: the settlements paid inside one window of instants (start included,
// end not), their earning lines, the drivers they pay, and the approved pay corrections settled on
// them with the lines made from those. The report keeps only the settlements paid on a date inside
// its year in the carrier's time zone, so the window it asks for may run wider. With a driver id,
// every statement and subquery reads that driver's rows alone, so another driver's rows never count
// toward the bound. Each table is read in pages through the same bound as a month's loads, and a
// read past the bound fails whole with ReadLimitError, never a short total.
export const PAID_BETWEEN =
  "status = 'paid' AND paid_at >= CAST($1 AS timestamptz) AND paid_at < CAST($2 AS timestamptz)";

export type PaidWhere = Record<"settlements" | "settlement_lines" | "drivers" | "pay_items", string>;

// The four filters, for every driver or for the one driver in $3. A pay correction is a pay item
// that names its proposal (ref_table 'proposals'); a deduction line is read as one only when its
// source is such an item, by the item's whole id, never by its label.
function paidWhere(oneDriver: boolean): PaidWhere {
  const settlements = oneDriver ? `${PAID_BETWEEN} AND driver_id = CAST($3 AS uuid)` : PAID_BETWEEN;
  const paid = `SELECT id FROM settlements WHERE tenant_id = current_tenant_id() AND ${settlements}`;
  const payItems =
    `ref_table = 'proposals' AND settlement_id IN (${paid})` + (oneDriver ? " AND driver_id = CAST($3 AS uuid)" : "");
  const corrections = `SELECT CAST(id AS text) FROM pay_items WHERE tenant_id = current_tenant_id() AND ${payItems}`;
  return {
    settlements,
    settlement_lines:
      `settlement_id IN (${paid}) AND (kind IN ('load_pay', 'accessorial_pay', 'reimbursement')` +
      ` OR (kind = 'other_deduction' AND sources->0->>'table' = 'pay_items' AND sources->0->>'id' IN (${corrections})))`,
    drivers:
      `id IN (SELECT driver_id FROM settlements WHERE tenant_id = current_tenant_id() AND ${settlements})` +
      (oneDriver ? " AND id = CAST($3 AS uuid)" : ""),
    pay_items: payItems,
  };
}

// Exported so a test's fake database can match these statements whole.
export const PAID_WHERE: { all: PaidWhere; oneDriver: PaidWhere } = {
  all: paidWhere(false),
  oneDriver: paidWhere(true),
};

export type PaidRows = Pick<TenantRows, "settlements" | "settlement_lines" | "drivers" | "pay_items">;

export async function readPaidBetween(
  q: Queryable,
  scope: { start: Instant; end: Instant; driverId?: string },
  paging: Paging = DELIVERED_PAGING,
): Promise<PaidRows> {
  const start = parseInstant(scope.start);
  const end = parseInstant(scope.end);
  if (end <= start) throw new RangeError("window ends before it starts");
  const { driverId } = scope;
  if (driverId !== undefined && !isUuid(driverId)) throw new RangeError("the driver id is not a uuid");
  const p: Param[] = [new Date(start).toISOString(), new Date(end).toISOString()];
  if (driverId !== undefined) p.push(driverId.toLowerCase());
  const where = driverId === undefined ? PAID_WHERE.all : PAID_WHERE.oneDriver;
  return {
    settlements: await readWherePaged(q, "settlements", where.settlements, p, paging),
    settlement_lines: await readWherePaged(q, "settlement_lines", where.settlement_lines, p, paging),
    drivers: await readWherePaged(q, "drivers", where.drivers, p, paging),
    pay_items: await readWherePaged(q, "pay_items", where.pay_items, p, paging),
  };
}

// ---- Load numbers ----

// Rows per statement and statements per read for the load numbers. A row is an id and a load
// number, so a page of 1,000 stays far under the Data API's 1 MiB response cap; the bound (200,000
// loads) stops a runaway read, and a read stopped there fails closed.
export const LOAD_NUMBER_PAGING: Paging = { pageSize: 1000, maxPages: 200 };

// Exported so a test's fake database can match these statements whole; each page adds its LIMIT.
// The key and the order are loads.id, the uuid: a bare id in ORDER BY binds to the text alias,
// whose order is not the key's.
const LOAD_NUMBERS = "SELECT CAST(id AS text) AS id, load_number FROM loads WHERE tenant_id = current_tenant_id()";
export const LOAD_NUMBERS_FIRST = `${LOAD_NUMBERS} ORDER BY loads.id`;
export const LOAD_NUMBERS_NEXT = `${LOAD_NUMBERS} AND loads.id > CAST($1 AS uuid) ORDER BY loads.id`;

export type LoadNumberRow = { id: string; load_number: string | null };

// Every load of the tenant once, as its id and load number only, in pages keyed on the uuid id.
// For a caller that finds a load by its whole normalized number: its normalizer has no identical
// SQL form, so the compare runs on these rows, never on a part of a string. A page shorter than
// the page size ends the read, so an exact multiple ends with one empty page.
export async function readLoadNumbers(
  q: Queryable,
  paging: Paging = LOAD_NUMBER_PAGING,
): Promise<LoadNumberRow[]> {
  const { pageSize, maxPages } = paging;
  for (const n of [pageSize, maxPages]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("paging is not a positive count");
  }
  const out: LoadNumberRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const rows: LoadNumberRow[] =
      cursor === null
        ? await q.query<LoadNumberRow>(`${LOAD_NUMBERS_FIRST} LIMIT ${pageSize}`)
        : await q.query<LoadNumberRow>(`${LOAD_NUMBERS_NEXT} LIMIT ${pageSize}`, [cursor]);
    if (rows.length > pageSize) throw new Error("a page is larger than its page size");
    out.push(...rows);
    if (rows.length < pageSize) return out;
    const last: unknown = rows[rows.length - 1].id;
    if (!isUuid(last)) throw new Error("a page key is not a uuid");
    cursor = last;
  }
  throw new ReadLimitError();
}

// ---- Money codes (MONEY-CODE) ----

// What a money code is asked for: the driver, the load, the purpose and amount as asked, and the
// evidence it cites (a document or a voice note by its own id; none for chat or the form). The
// caps come from the caller, which reads the switches.
export type MoneyCodeAsk = {
  driverId: string;
  loadId: string;
  purpose: MoneyCodePurpose;
  amountCents: unknown;
  source: MoneyCodeSource;
  documentId?: string | null;
  voiceNoteId?: string | null;
  capCents: number;
  perDriverPerDay: number;
};

// The codes a check counts: this driver's or this load's, made in the last few days (the duplicate
// window is 24 hours and the daily limit is one tenant-local day), and every code citing the same
// document ($4) or voice note ($5), however old (null cites none). More than the bound is a
// refusal to read, never a short list.
const MONEY_CODE_ROWS_MAX = 200;
export const MONEY_CODES_SQL =
  "SELECT CAST(id AS text) AS id, CAST(driver_id AS text) AS driver_id, CAST(load_id AS text) AS load_id," +
  " purpose, amount_cents, status," +
  " to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at," +
  " CAST(document_id AS text) AS document_id, CAST(voice_note_id AS text) AS voice_note_id" +
  " FROM money_codes WHERE tenant_id = current_tenant_id()" +
  " AND (((driver_id = CAST($1 AS uuid) OR load_id = CAST($2 AS uuid))" +
  " AND created_at > CAST($3 AS timestamptz) - interval '3 days')" +
  " OR document_id = CAST($4 AS uuid) OR voice_note_id = CAST($5 AS uuid))" +
  ` ORDER BY created_at, id LIMIT ${MONEY_CODE_ROWS_MAX + 1}`;

export const MONEY_CODE_LOAD_SQL =
  "SELECT CAST(id AS text) AS id, CAST(driver_id AS text) AS driver_id, status, load_number," +
  " to_char(delivered_on, 'YYYY-MM-DD') AS delivered_on" +
  " FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";

export const MONEY_CODE_DRIVER_SQL =
  "SELECT money_armed FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";

const MONEY_CODE_DOCUMENT_SQL =
  "SELECT read_status, document_kind, CAST(reading AS text) AS reading FROM documents" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";

// A note counts only once it is past the screen and in English.
const MONEY_CODE_VOICE_SQL =
  "SELECT CAST(driver_id AS text) AS driver_id, english_text FROM voice_notes" +
  " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)" +
  " AND status IN ('ready', 'handed_off', 'replied')";

const READ_STATUSES: readonly MoneyCodeReceipt["readStatus"][] = ["pending", "read", "unreadable", "budget"];

async function moneyCodeReceipt(q: Queryable, documentId: string): Promise<MoneyCodeReceipt | null> {
  const rows = await q.query<{ read_status: string; document_kind: string | null; reading: string | null }>(
    MONEY_CODE_DOCUMENT_SQL,
    [assertUuid(documentId, "documentId")],
  );
  const row = rows[0];
  if (!row) return null;
  if (!(READ_STATUSES as readonly string[]).includes(row.read_status)) throw new Error("unknown read status");
  // The reading back through the strict schema; anything that does not parse reads as nothing
  // read, and the engine refuses it as unreadable.
  const read = row.read_status === "read" && typeof row.reading === "string" ? parseRead(row.reading) : null;
  return {
    readStatus: row.read_status as MoneyCodeReceipt["readStatus"],
    kind: read ? read.kind : null,
    totalCents: read ? read.fields.totalCents : null,
    loadNumber: read ? read.fields.loadNumber : null,
    kindConfidence: read ? read.confidence.document_kind : null,
    totalConfidence: read ? read.confidence.total_cents : null,
    loadNumberConfidence: read ? read.confidence.load_number : null,
  };
}

async function moneyCodeVoice(q: Queryable, voiceNoteId: string): Promise<MoneyCodeVoice | null> {
  const rows = await q.query<{ driver_id: string | null; english_text: string | null }>(MONEY_CODE_VOICE_SQL, [
    assertUuid(voiceNoteId, "voiceNoteId"),
  ]);
  const row = rows[0];
  if (!row || row.english_text === null) return null;
  return { driverId: row.driver_id, amountsCents: extractAmountsCents(row.english_text) };
}

function moneyCodeRecordOf(
  r: {
    id: string;
    driver_id: string;
    load_id: string;
    purpose: string;
    amount_cents: number | string;
    status: string;
    created_at: string;
    document_id: string | null;
    voice_note_id: string | null;
  },
  zone: string,
): MoneyCodeRecord {
  const amount = Number(r.amount_cents);
  if (!Number.isSafeInteger(amount)) throw new Error("a money code amount is not whole cents");
  if (!(MONEY_CODE_PURPOSES as readonly string[]).includes(r.purpose)) throw new Error("unknown purpose");
  if (!(MONEY_CODE_STATUSES as readonly string[]).includes(r.status)) throw new Error("unknown code status");
  return {
    id: r.id,
    driverId: r.driver_id,
    loadId: r.load_id,
    purpose: r.purpose as MoneyCodePurpose,
    amountCents: amount,
    status: r.status as MoneyCodeStatus,
    createdAt: r.created_at,
    createdOn: localDateOf(r.created_at, zone),
    documentId: r.document_id,
    voiceNoteId: r.voice_note_id,
  };
}

// Everything checkMoneyCode reads, as of now, in the tenant's own zone. Reads only. The cited
// document or voice note must be this tenant's (the statement names the tenant); one not found
// reads as null and the engine refuses it as evidence_missing.
export async function readMoneyCodeInput(q: Queryable, ask: MoneyCodeAsk, now: Instant): Promise<MoneyCodeInput> {
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant is set");
  const driverId = assertUuid(ask.driverId, "driverId");
  const loadId = assertUuid(ask.loadId, "loadId");
  const armed = await q.query<{ money_armed: boolean }>(MONEY_CODE_DRIVER_SQL, [driverId]);
  const loads = await q.query<{
    id: string;
    driver_id: string | null;
    status: string;
    load_number: string;
    delivered_on: string | null;
  }>(MONEY_CODE_LOAD_SQL, [loadId]);
  const row = loads[0];
  const load = row
    ? {
        id: row.id,
        driverId: row.driver_id,
        status: row.status as LoadStatus,
        loadNumber: row.load_number,
        deliveredOn: row.delivered_on === null ? null : assertLocalDate(row.delivered_on, "delivered_on"),
      }
    : null;
  // The evidence cited by its own id, lower case, as the database writes a uuid as text.
  const documentId =
    ask.source === "document" && typeof ask.documentId === "string"
      ? assertUuid(ask.documentId, "documentId").toLowerCase()
      : null;
  const voiceNoteId =
    ask.source === "voice_note" && typeof ask.voiceNoteId === "string"
      ? assertUuid(ask.voiceNoteId, "voiceNoteId").toLowerCase()
      : null;
  const receipt = documentId !== null ? await moneyCodeReceipt(q, documentId) : null;
  const voice = voiceNoteId !== null ? await moneyCodeVoice(q, voiceNoteId) : null;
  const codeRows = await q.query<{
    id: string;
    driver_id: string;
    load_id: string;
    purpose: string;
    amount_cents: number | string;
    status: string;
    created_at: string;
    document_id: string | null;
    voice_note_id: string | null;
  }>(MONEY_CODES_SQL, [driverId, loadId, now, documentId, voiceNoteId]);
  if (codeRows.length > MONEY_CODE_ROWS_MAX) throw new ReadLimitError();
  return {
    driverId,
    driverArmed: armed.length === 1 && armed[0].money_armed === true,
    load,
    purpose: ask.purpose,
    amountCents: ask.amountCents,
    capCents: ask.capCents,
    perDriverPerDay: ask.perDriverPerDay,
    now,
    today: localDateOf(now, tenant.timezone),
    source: ask.source,
    receipt,
    voice,
    documentId,
    voiceNoteId,
    codes: codeRows.map((r) => moneyCodeRecordOf(r, tenant.timezone)),
  };
}
