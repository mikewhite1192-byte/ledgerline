import { describe, expect, it } from "vitest";
import { blueRidgePlan, planDb } from "../agent/gateway/__tests__/plan-db";
import { TENANT } from "../agent/gateway/__tests__/fake-db";
import { advanceOf, driverOf, periodOf, settlementOf } from "../data/records";
import golden from "../seed/golden.json";
import { computeAdvancesOutstanding } from "./advances-outstanding";
import { parseReportArgs, type ReportRequest } from "./args";
import { computeCashNeeded } from "./cash-needed";
import { computeReport } from "./run";
import { REPORT_COLUMNS, REPORT_NAMES, type ReportResult, type ReportRow } from "./types";

// Each report computed from the Blue Ridge seed plan through the real record readers and the real
// rules engine, checked against the reviewed golden figures and the planted problems.

const GOLDEN = golden.carriers["blue-ridge"];
const plan = blueRidgePlan();
// Midday on the plan's anchor day in the carrier's zone; no test reads the wall clock.
const CLOCK = { now: new Date(Date.UTC(2026, 10, 2, 17, 0, 0)), timeZone: plan.carrier.timezone };

function request(name: ReportRequest["name"], args: Record<string, string> = {}): ReportRequest {
  const parsed = parseReportArgs(name, args);
  if (!parsed) throw new Error(`bad test args for ${name}`);
  return parsed;
}

async function run(name: ReportRequest["name"], args: Record<string, string> = {}): Promise<ReportResult> {
  return planDb(plan).withTenant(TENANT, (q) => computeReport(q, request(name, args), CLOCK));
}

function column(rows: readonly ReportRow[], key: string): number[] {
  return rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
}

const total = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);

describe("ar_aging", () => {
  it("buckets every open invoice as the golden aging does, by customer", async () => {
    const r = await run("ar_aging", { asOf: "2026-11-02" });
    const b = GOLDEN.receivables.openByBucket;
    expect(r.totals).toEqual({
      currentCents: b.current.cents,
      days1To30Cents: b["1_30"].cents,
      days31To60Cents: b["31_60"].cents,
      days61To90Cents: b["61_90"].cents,
      over90Cents: b.over_90.cents,
      totalCents: b.current.cents + b["1_30"].cents + b["31_60"].cents + b["61_90"].cents + b.over_90.cents,
    });
    for (const key of Object.keys(r.totals ?? {})) {
      expect(total(column(r.rows, key))).toBe(r.totals?.[key]);
    }
    for (const row of r.rows) {
      expect(row.totalCents).toBe(
        total(["currentCents", "days1To30Cents", "days31To60Cents", "days61To90Cents", "over90Cents"].map((k) => row[k] as number)),
      );
    }
    expect(column(r.rows, "totalCents")).toEqual([...column(r.rows, "totalCents")].sort((x, y) => y - x));
    expect(r.args).toEqual({ asOf: "2026-11-02" });
    expect(r.truncated).toBe(false);
    expect(r.rowsTotal).toBe(r.rows.length);
  });

  it("ages as of the carrier's today when no date is asked for", async () => {
    const r = await run("ar_aging");
    expect(r.asOf).toBe("2026-11-02");
    expect(r.args).toEqual({ asOf: "2026-11-02" });
  });
});

describe("driver_pay_summary", () => {
  it("defaults to the latest settled week and totals its stored net pay", async () => {
    const r = await run("driver_pay_summary");
    expect(r.period).toEqual({ start: "2026-10-19", end: "2026-10-25" });
    expect(r.args).toEqual({ periodStart: "2026-10-19" });
    expect(r.totals?.netCents).toBe(2312227);
    expect(total(column(r.rows, "netCents"))).toBe(r.totals?.netCents);
    expect(r.totals?.grossCents).toBe(total(column(r.rows, "grossCents")));
  });

  it.each(GOLDEN.settledNetCents)("holds the week of $periodStart to the cent", async ({ periodStart, netCents }) => {
    const r = await run("driver_pay_summary", { periodStart });
    expect(r.totals?.netCents).toBe(netCents);
  });

  it("narrows to one driver, and says no pay run for a week with none", async () => {
    const all = await run("driver_pay_summary", { periodStart: "2026-10-12" });
    const first = all.rows[0].driver as { id: string };
    const one = await run("driver_pay_summary", { periodStart: "2026-10-12", driverId: first.id });
    expect(one.rows).toHaveLength(1);
    expect(one.args).toEqual({ periodStart: "2026-10-12", driverId: first.id });
    expect(one.totals?.netCents).toBe(all.rows[0].netCents);

    const open = await run("driver_pay_summary", { periodStart: "2026-10-26" });
    expect(open.rows).toEqual([]);
    expect(open.emptyReason).toBe("no_pay_run");
    expect(open.totals).toBeUndefined();

    const missing = await run("driver_pay_summary", { periodStart: "2025-01-06" });
    expect(missing.emptyReason).toBe("no_pay_run");
  });
});

describe("advances_outstanding", () => {
  it("sums what drivers still owe to the golden figure, with the room under each limit", async () => {
    const r = await run("advances_outstanding", { asOf: "2026-11-02" });
    expect(r.totals?.outstandingCents).toBe(GOLDEN.advancesOutstandingCents);
    expect(total(column(r.rows, "outstandingCents"))).toBe(GOLDEN.advancesOutstandingCents);
    expect(r.totals?.advances).toBe(total(column(r.rows, "advances")));
    for (const row of r.rows) {
      expect(typeof row.limitCents).toBe("number");
      expect(row.headroomCents).toBe((row.limitCents as number) - (row.outstandingCents as number));
    }
    expect(column(r.rows, "outstandingCents")).toEqual(
      [...column(r.rows, "outstandingCents")].sort((x, y) => y - x),
    );
  });

  it("leaves out advances requested after the date asked about", async () => {
    const r = await run("advances_outstanding", { asOf: "2025-01-01" });
    expect(r.rows).toEqual([]);
    expect(r.emptyReason).toBe("no_rows");
  });

  it("shows no limit when no pay rules cover the date", () => {
    const advances = plan.rows.advances.filter((a) => a.status === "paid" || a.status === "approved");
    const r = computeAdvancesOutstanding(
      {
        advances: advances.map(advanceOf),
        drivers: plan.rows.drivers.map(driverOf),
        config: null,
      },
      "2026-11-02",
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.limitCents).toBeNull();
      expect(row.headroomCents).toBeNull();
    }
  });
});

describe("cash_needed", () => {
  it("is empty with no pay run when the open week has no settlements yet", async () => {
    const r = await run("cash_needed");
    expect(r.period).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(r.rows).toEqual([]);
    expect(r.emptyReason).toBe("no_pay_run");
    expect(r.totals).toBeUndefined();
  });

  it("owes nothing for a week already paid", async () => {
    const r = await run("cash_needed", { periodStart: "2026-10-19" });
    expect(r.rows).toEqual([]);
    expect(r.emptyReason).toBe("no_rows");
  });

  it("sums unpaid settlements above zero by worker type", () => {
    const periods = plan.rows.settlement_periods.map(periodOf);
    const week = periods.find((p) => p.periodStart === "2026-10-19");
    if (!week) throw new Error("seed week missing");
    const settlements = plan.rows.settlements.map(settlementOf).map((s, i) =>
      s.periodId !== week.id ? s : { ...s, status: i % 3 === 0 ? ("paid" as const) : i % 3 === 1 ? ("draft" as const) : ("approved" as const) },
    );
    const drivers = plan.rows.drivers.map(driverOf);
    const r = computeCashNeeded({ periods, settlements, drivers }, { periodStart: "2026-10-19" }, "2026-11-02");
    const due = settlements.filter((s) => s.periodId === week.id && s.status !== "paid" && s.netCents > 0);
    expect(r.rows).toHaveLength(due.length);
    expect(r.totals?.netDueCents).toBe(total(due.map((s) => s.netCents)));
    expect(total((r.subtotals ?? []).map((s) => s.totals.netDueCents))).toBe(r.totals?.netDueCents);
    const types = r.rows.map((row) => row.workerType);
    expect(types).toEqual([...types].sort((a, b) => (a === b ? 0 : a === "Company driver" ? -1 : 1)));
    expect(r.rows.every((row) => row.status !== "Paid")).toBe(true);
  });
});

describe("margin_per_load", () => {
  const window = { periodStart: "2026-10-05", periodEnd: "2026-11-01" };

  it("leaves the load with no rate empty with a note, and totals only what is known", async () => {
    const noRate = plan.rows.loads.find((l) => l.id === plan.planted.noRateLoadId);
    expect(noRate?.delivered_on && noRate.delivered_on >= window.periodStart && noRate.delivered_on <= window.periodEnd).toBe(true);
    const r = await run("margin_per_load", window);
    const row = r.rows.find((x) => (x.load as { id: string }).id === plan.planted.noRateLoadId);
    expect(row).toBeDefined();
    expect(row?.revenueCents).toBeNull();
    expect(row?.marginCents).toBeNull();
    expect(row?.marginBps).toBeNull();
    expect(String(row?.note)).toContain("No rate");

    const known = r.rows.filter((x) => typeof x.revenueCents === "number" && typeof x.driverPayCents === "number");
    expect(r.totals?.revenueCents).toBe(total(column(known, "revenueCents")));
    expect(r.totals?.driverPayCents).toBe(total(column(known, "driverPayCents")));
    expect(r.totals?.marginCents).toBe((r.totals?.revenueCents ?? 0) - (r.totals?.driverPayCents ?? 0));
    for (const x of known) expect(x.marginCents).toBe((x.revenueCents as number) - (x.driverPayCents as number));
    expect(r.period).toEqual({ start: window.periodStart, end: window.periodEnd });
    const days = r.rows.map((x) => String(x.deliveredOn));
    expect(days).toEqual([...days].sort());
    expect(days.every((d) => d >= window.periodStart && d <= window.periodEnd)).toBe(true);
  });

  it("narrows to one customer", async () => {
    const customerId = plan.rows.customers[0].id;
    const r = await run("margin_per_load", { ...window, customerId });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => (x.customer as { id: string }).id === customerId)).toBe(true);
    expect(r.args).toEqual({ ...window, customerId });
  });
});

describe("every report", () => {
  it.each(REPORT_NAMES)("%s names each money column so the figure check reads it as cents", (name) => {
    for (const c of REPORT_COLUMNS[name]) {
      expect(c.kind === "cents").toBe(/Cents$/.test(c.key));
    }
  });
});
