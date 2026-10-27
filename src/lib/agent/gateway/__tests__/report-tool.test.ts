import { describe, expect, it } from "vitest";
import { computeReport } from "../../../reports/run";
import { parseReportArgs } from "../../../reports/args";
import { MAX_RESULT_CHARS } from "../index";
import { fitResult, REPORT_RESULT_CHARS } from "../tools/read/report-tool";
import { TENANT } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

const plan = blueRidgePlan();
const CLOCK = { now: new Date(Date.UTC(2026, 10, 2, 17, 0, 0)), timeZone: plan.carrier.timezone };

describe("fitResult", () => {
  it("uses the gateway's own cap", () => {
    expect(REPORT_RESULT_CHARS).toBe(MAX_RESULT_CHARS);
  });

  it("keeps as many leading rows as fit, with the report's own row count and totals", async () => {
    const request = parseReportArgs("margin_per_load", { periodStart: "2026-08-05", periodEnd: "2026-11-01" });
    if (!request) throw new Error("bad args");
    const full = await planDb(plan).withTenant(TENANT, (q) => computeReport(q, request, CLOCK));
    expect(full.rows.length).toBeGreaterThan(50);
    const fitted = fitResult(full) as {
      rows: unknown[];
      rowsShown: number;
      rowsTotal: number;
      truncated: boolean;
      totals: unknown;
      subtotals: unknown;
    };
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(fitted.rows.length).toBeGreaterThan(0);
    expect(fitted.rows.length).toBeLessThanOrEqual(50);
    expect(fitted.rows).toEqual(full.rows.slice(0, fitted.rows.length));
    expect(fitted.rowsShown).toBe(fitted.rows.length);
    expect(fitted.rowsTotal).toBe(full.rows.length);
    expect(fitted.truncated).toBe(true);
    expect(fitted.totals).toEqual(full.totals);
    // Not every load in this window is priced, so the sums ride on a labeled row, kept whole too.
    expect(full.subtotals).toHaveLength(1);
    expect(fitted.subtotals).toEqual(full.subtotals);
  });

  it("leaves a small report whole", async () => {
    const request = parseReportArgs("cash_needed", {});
    if (!request) throw new Error("bad args");
    const full = await planDb(plan).withTenant(TENANT, (q) => computeReport(q, request, CLOCK));
    expect(fitResult(full)).toEqual({ ...full, rowsShown: 0 });
  });
});
