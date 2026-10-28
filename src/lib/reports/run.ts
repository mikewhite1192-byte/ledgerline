import type { Queryable } from "../db";
import { configForDay } from "../data/config-version";
import { readReportInput } from "../data/read";
import {
  advanceOf,
  customerOf,
  driverOf,
  loadsOf,
  payConfigOf,
  periodOf,
  receivablesInputOf,
  settlementOf,
} from "../data/records";
import type { PayConfigRow } from "../data/rows";
import { ConfigError, type PayConfig } from "../rules-engine";
import { localDateOf } from "../time/local-date";
import { computeAdvancesOutstanding } from "./advances-outstanding";
import { computeArAging } from "./ar-aging";
import type { ReportRequest } from "./args";
import { computeCashNeeded } from "./cash-needed";
import { computeDriverPaySummary } from "./driver-pay-summary";
import { computeMarginPerLoad } from "./margin-per-load";
import type { ReportResult } from "./types";

// One report for the current tenant: read the tables it needs (whole, SELECT only, inside the
// caller's tenant transaction), map them to the engine's records, compute. The same function
// serves the chat tool and the download route, so both show the same numbers.

export type ReportClock = { now: Date; timeZone: string };

// The pay rules in force on a day, or null before the first version. Any other problem with the
// rules (none on file, two on one date) is refused, never read as "no rules".
export function payConfigOn(versions: readonly PayConfigRow[]): (day: string) => PayConfig | null {
  return (day) => {
    try {
      return payConfigOf(configForDay(versions, day));
    } catch (err) {
      if (err instanceof ConfigError && err.message === "no_config_for_period") return null;
      throw err;
    }
  };
}

export async function computeReport(
  q: Queryable,
  request: ReportRequest,
  clock: ReportClock,
): Promise<ReportResult> {
  const today = localDateOf(clock.now.toISOString(), clock.timeZone);
  switch (request.name) {
    case "ar_aging": {
      const asOf = request.args.asOf ?? today;
      const rows = await readReportInput(q, [
        "invoices",
        "customer_payments",
        "payment_applications",
        "customers",
      ]);
      return computeArAging({
        receivables: receivablesInputOf(rows, asOf),
        customers: rows.customers.map(customerOf),
      });
    }
    case "driver_pay_summary": {
      const rows = await readReportInput(q, ["settlement_periods", "settlements", "drivers"]);
      return computeDriverPaySummary(
        {
          periods: rows.settlement_periods.map(periodOf),
          settlements: rows.settlements.map(settlementOf),
          drivers: rows.drivers.map(driverOf),
        },
        request.args,
        today,
      );
    }
    case "advances_outstanding": {
      const asOf = request.args.asOf ?? today;
      const rows = await readReportInput(q, ["advances", "drivers", "pay_configs"]);
      return computeAdvancesOutstanding(
        {
          advances: rows.advances.map(advanceOf),
          drivers: rows.drivers.map(driverOf),
          config: payConfigOn(rows.pay_configs)(asOf),
        },
        asOf,
      );
    }
    case "cash_needed": {
      const rows = await readReportInput(q, ["settlement_periods", "settlements", "drivers"]);
      return computeCashNeeded(
        {
          periods: rows.settlement_periods.map(periodOf),
          settlements: rows.settlements.map(settlementOf),
          drivers: rows.drivers.map(driverOf),
        },
        request.args,
        today,
      );
    }
    case "margin_per_load": {
      const rows = await readReportInput(q, [
        "loads",
        "load_state_miles",
        "load_accessorials",
        "drivers",
        "customers",
        "pay_configs",
      ]);
      return computeMarginPerLoad(
        {
          loads: loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials),
          drivers: rows.drivers.map(driverOf),
          customers: rows.customers.map(customerOf),
          payConfigOn: payConfigOn(rows.pay_configs),
        },
        request.args,
        today,
      );
    }
  }
}
