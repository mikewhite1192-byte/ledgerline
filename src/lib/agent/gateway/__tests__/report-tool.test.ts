import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { IFTA_SAMPLE_RATES } from "../../../../config/ifta-sample-rates";
import { computeIftaQuarter } from "../../../reports/ifta-quarter";
import { computeReport } from "../../../reports/run";
import { parseReportArgs } from "../../../reports/args";
import { c, load } from "../../../rules-engine/test-records";
import type { FuelPurchaseRecord } from "../../../rules-engine/types";
import { centsIn, maskFigures } from "../../operator/figures";
import { MAX_RESULT_CHARS } from "../index";
import { reportDriverInsights } from "../tools/read/report-driver-insights";
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

  const Q4 = { start: "2026-10-01", end: "2026-12-31" };
  const purchase = (state: string, gallonsMilli: number): FuelPurchaseRecord => ({
    id: `F-${state}`,
    driverId: "drv-1",
    loadId: null,
    purchasedAt: "2026-10-28T13:03:00Z",
    purchasedOn: "2026-10-28",
    state,
    gallonsMilli,
    amountCents: c(57_000),
    paidWith: "company_card",
    purchaseRef: `fp-${state}`,
  });

  it("carries the hand-checked example's largest tax due, SC at $21.02, beside its rows", () => {
    const sm = (loadId: string, rows: Array<[string, number]>) =>
      rows.map(([state, miles], i) => ({ id: `${loadId}-sm${i + 1}`, state, miles }));
    const loads = [
      load({ id: "L1", loadedMiles: 1_900, emptyMiles: 100, stateMiles: sm("L1", [["NC", 1_000], ["SC", 500], ["GA", 500]]) }),
      load({ id: "L2", loadedMiles: 1_000, emptyMiles: 0, stateMiles: sm("L2", [["NC", 600], ["VA", 400]]) }),
    ];
    const fuel = [purchase("NC", 300_000), purchase("GA", 100_000), purchase("VA", 50_500)];
    const rates = [
      { state: "NC", rateMcents: 36_300 },
      { state: "SC", rateMcents: 28_000 },
      { state: "GA", rateMcents: 35_000 },
      { state: "VA", rateMcents: 30_000 },
    ];
    const full = computeIftaQuarter({ loads, fuel, rates }, "2026-11-02", Q4);
    expect(full.rows.map((r) => [r.state, r.taxDueCents])).toEqual([["GA", -872], ["NC", -2_168], ["SC", 2_102], ["VA", 287]]);
    expect(full.largestTaxDue).toEqual({ state: "SC", taxCents: 2_102 });
    expect(full.notes).toContain("Largest tax due: SC, $21.02.");
    const fitted = fitResult(full);
    expect(fitted).toEqual({ ...full, rowsShown: 4 });
    expect(maskFigures("Largest tax due: SC, $21.02.", centsIn(fitted)).masked).toBe(0);
  });

  it("keeps the IFTA quarter's largest tax due quotable when the state rows are cut", () => {
    // 48 states, A to Z: WI drives the most miles with no fuel bought there, so it owes the most;
    // every other state buys more fuel than it burns and gets a credit.
    expect(IFTA_SAMPLE_RATES).toHaveLength(48);
    const stateMiles = IFTA_SAMPLE_RATES.map((r, i) => ({ id: `T1-sm${i + 1}`, state: r.state, miles: r.state === "WI" ? 20_000 : 1_000 }));
    const miles = stateMiles.reduce((a, s) => a + s.miles, 0);
    const fuel = IFTA_SAMPLE_RATES.filter((r) => r.state !== "WI").map((r) => purchase(r.state, 150_000));
    const input = { loads: [load({ id: "T1", loadedMiles: miles, emptyMiles: 0, stateMiles })], fuel, rates: IFTA_SAMPLE_RATES };
    const full = computeIftaQuarter(input, "2026-11-02", Q4);
    expect(full.rows).toHaveLength(48);
    const wi = full.rows.find((r) => r.state === "WI");
    if (!wi || typeof wi.taxDueCents !== "number") throw new Error("no WI row");
    expect(wi.taxDueCents).toBeGreaterThan(0);
    expect(full.largestTaxDue).toEqual({ state: "WI", taxCents: wi.taxDueCents });
    expect(JSON.stringify(full).length).toBeGreaterThan(REPORT_RESULT_CHARS);

    const fitted = fitResult(full) as { rows: Array<{ state: unknown }>; rowsShown: number; rowsTotal: number; truncated: boolean; notes: string[] };
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(fitted.truncated).toBe(true);
    expect(fitted.rowsShown).toBe(fitted.rows.length);
    expect(fitted.rowsShown).toBeLessThan(48);
    expect(fitted.rowsTotal).toBe(48);
    expect(fitted.rows.map((r) => r.state)).not.toContain("WI");
    expect(fitted).toMatchObject({ largestTaxDue: { state: "WI", taxCents: wi.taxDueCents } });

    // The note's dollar figure passes the agent's figure check from the fitted result alone.
    const note = fitted.notes.find((n) => n.startsWith("Largest tax due: WI, $"));
    if (!note) throw new Error("no largest tax due note");
    const allowed = centsIn(fitted);
    expect(allowed.has(wi.taxDueCents)).toBe(true);
    expect(maskFigures(note, allowed)).toEqual({ text: note, masked: 0 });
    // Without the top-level field the cut rows would take the figure with them.
    const bare: Record<string, unknown> = { ...fitted };
    delete bare.largestTaxDue;
    expect(maskFigures(note, centsIn(bare)).masked).toBe(1);
  });
});

describe("report_driver_insights", () => {
  const saved = flags.reportsEnabled;
  afterEach(() => {
    flags.reportsEnabled = saved;
  });
  // 5 PM UTC on Nov 2 is still Nov 2 in the carrier's zone.
  const ctx = { now: CLOCK.now, timeZone: CLOCK.timeZone } as Parameters<typeof reportDriverInsights.run>[1];
  const EXTRAS = { screen: null, limit: null };
  const run = (args: Record<string, string>) =>
    planDb(plan).withTenant(TENANT, (q) => reportDriverInsights.run(q, ctx, args, EXTRAS));

  it("answers a lone from after today or 366 days or more back as invalid args, the way the schema answers a bad window", async () => {
    flags.reportsEnabled = true;
    for (const from of ["2026-11-03", "2025-11-01"]) {
      expect(await run({ from }), from).toEqual({
        result: { error: "invalid_args", fieldErrors: [{ path: "from", code: "custom" }] },
      });
    }
    const ok = (await run({ from: "2025-11-02" })).result as { report: string; period: unknown };
    expect(ok).toMatchObject({ report: "driver_insights", period: { start: "2025-11-02", end: "2026-11-02" } });
  });
});
