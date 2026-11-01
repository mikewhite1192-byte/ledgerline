import type { Queryable } from "../db";
import { assertInsightWindow, type DriverInsightsInput, type InsightDeficit } from "../reports/driver-insights";
import { isUuid } from "../uuid";
import type { Period } from "../time/local-date";
import { DELIVERED_BETWEEN, DELIVERED_PAGING, ReadLimitError, readTable, readWherePaged, type Paging } from "./read";
import { advanceOf, driverOf, periodOf, settlementOf } from "./records";
import type { TenantRows } from "./rows";

// The driver insights' rows (design-d1-drivers 4.1), SELECT only, inside the caller's tenant
// transaction: every driver; the pay weeks that end inside a window of the carrier's own dates
// with their paid stubs and those stubs' fuel lines; the loads delivered in the window; every
// approved or paid advance (what is owed is as of today, not the window); and what each driver
// owes on deficits not settled yet. Each table but drivers is read in pages and a read past its
// bound fails whole with ReadLimitError, never a short total.

const PERIOD_END_BETWEEN = "period_end BETWEEN CAST($1 AS date) AND CAST($2 AS date)";
const PAID_IN_WINDOW =
  "status = 'paid' AND period_id IN (SELECT id FROM settlement_periods" +
  ` WHERE tenant_id = current_tenant_id() AND ${PERIOD_END_BETWEEN})`;

// Exported so a test's fake database can match these statements whole.
export const INSIGHT_WHERE = {
  settlement_periods: PERIOD_END_BETWEEN,
  settlements: PAID_IN_WINDOW,
  settlement_lines:
    "kind = 'fuel' AND settlement_id IN (SELECT id FROM settlements" +
    ` WHERE tenant_id = current_tenant_id() AND ${PAID_IN_WINDOW})`,
  loads: `status IN ('delivered', 'invoiced') AND ${DELIVERED_BETWEEN}`,
  advances: "status IN ('approved', 'paid')",
} as const;

// One row per driver with a deficit not settled yet: what is left of it, amount less recovered.
// The table is not one of the record tables, so this is written by hand; bigint sums come back as
// text and are read as safe integers. At most one row per driver, bounded like the drivers read.
export const DEFICITS_MAX = 1000;
export const DEFICITS_SQL =
  "SELECT CAST(driver_id AS text) AS driver_id, CAST(sum(amount_cents - recovered_cents) AS text) AS owed_cents" +
  " FROM driver_deficits WHERE tenant_id = current_tenant_id() AND settled_in IS NULL" +
  ` GROUP BY driver_id ORDER BY driver_id LIMIT ${DEFICITS_MAX + 1}`;

export type DriverInsightRows = Pick<
  TenantRows,
  "drivers" | "settlement_periods" | "settlements" | "settlement_lines" | "loads" | "advances"
> & { deficits: InsightDeficit[] };

export async function readDeficitsOwed(q: Queryable): Promise<InsightDeficit[]> {
  const rows = await q.query<{ driver_id: unknown; owed_cents: unknown }>(DEFICITS_SQL, []);
  if (rows.length > DEFICITS_MAX) throw new ReadLimitError();
  return rows.map((r) => {
    const owed = typeof r.owed_cents === "string" ? Number(r.owed_cents) : NaN;
    if (!isUuid(r.driver_id)) throw new Error("a deficit row names no driver");
    if (!Number.isSafeInteger(owed) || owed < 0) throw new Error("a deficit total is not whole cents");
    return { driverId: r.driver_id.toLowerCase(), owedCents: owed };
  });
}

export async function readDriverInsightRows(
  q: Queryable,
  window: Period,
  paging: Paging = DELIVERED_PAGING,
): Promise<DriverInsightRows> {
  const { start, end } = assertInsightWindow(window);
  const p = [start, end];
  return {
    drivers: await readTable(q, "drivers"),
    settlement_periods: await readWherePaged(q, "settlement_periods", INSIGHT_WHERE.settlement_periods, p, paging),
    settlements: await readWherePaged(q, "settlements", INSIGHT_WHERE.settlements, p, paging),
    settlement_lines: await readWherePaged(q, "settlement_lines", INSIGHT_WHERE.settlement_lines, p, paging),
    loads: await readWherePaged(q, "loads", INSIGHT_WHERE.loads, p, paging),
    advances: await readWherePaged(q, "advances", INSIGHT_WHERE.advances, [], paging),
    deficits: await readDeficitsOwed(q),
  };
}

export function driverInsightInputOf(rows: DriverInsightRows): DriverInsightsInput {
  return {
    drivers: rows.drivers.map(driverOf),
    periods: rows.settlement_periods.map(periodOf),
    settlements: rows.settlements.map(settlementOf),
    lines: rows.settlement_lines.map((l) => ({
      settlementId: l.settlement_id,
      kind: l.kind,
      amountCents: l.amount_cents,
    })),
    loads: rows.loads.flatMap((l) => {
      // A delivered or invoiced load always names its driver and date (the loads CHECK); one that
      // does not is not counted for anyone.
      if (l.driver_id === null || l.delivered_on === null) return [];
      return [
        { driverId: l.driver_id, deliveredOn: l.delivered_on, loadedMiles: l.loaded_miles, emptyMiles: l.empty_miles },
      ];
    }),
    advances: rows.advances.map(advanceOf),
    deficits: rows.deficits,
  };
}

export async function readDriverInsightInput(
  q: Queryable,
  window: Period,
  paging: Paging = DELIVERED_PAGING,
): Promise<DriverInsightsInput> {
  return driverInsightInputOf(await readDriverInsightRows(q, window, paging));
}

// The drivers with an active fuel card on file, for the list page's "No card" badge. Only the
// driver id is read, never the card itself; at most one row per driver.
export const CARDED_SQL =
  "SELECT DISTINCT CAST(driver_id AS text) AS driver_id FROM driver_cards" +
  " WHERE tenant_id = current_tenant_id() AND status = 'active' ORDER BY driver_id";

export async function readCardedDrivers(q: Queryable): Promise<Set<string>> {
  const rows = await q.query<{ driver_id: unknown }>(CARDED_SQL, []);
  return new Set(
    rows.map((r) => {
      if (!isUuid(r.driver_id)) throw new Error("a card row names no driver");
      return r.driver_id.toLowerCase();
    }),
  );
}
