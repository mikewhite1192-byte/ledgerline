import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { TENANT } from "../agent/gateway/__tests__/fake-db";
import { blueRidgePlan, planDb } from "../agent/gateway/__tests__/plan-db";
import { fitResult, REPORT_RESULT_CHARS } from "../agent/gateway/tools/read/report-tool";
import { centsIn, maskFigures } from "../agent/operator/figures";
import type { SettlementRecord } from "../rules-engine";
import { c, companyDriver, driver } from "../rules-engine/test-records";
import type { CarrierPlan } from "../seed/plan";
import { instantAt } from "../seed/calendar";
import { localDateOf } from "../time/local-date";
import { parseReportArgs } from "./args";
import { reportCsv } from "./csv";
import { computeReport, type ReportClock } from "./run";
import { ReportsOffError } from "./switch";
import { REPORT_COLUMNS, type ReportResult } from "./types";
import {
  computeYearEnd1099,
  NEC_THRESHOLDS,
  necThresholdCents,
  thresholdCentsIn,
  yearEndWindow,
  type YearEndCorrection,
  type YearEndInput,
  type YearEndLine,
} from "./year-end";

// The year-end 1099 totals from hand-built settlements (the method, the tenant-local year, the
// threshold by payment year, the CSV) and from the Blue Ridge seed plan through the real readers.
// No test reads the wall clock: every "today" is a fixed date.

const NY = "America/New_York";
const TODAY = "2026-11-02";

const A = driver({ id: "drv-a", code: "T-A", firstName: "Avery", lastName: "Quillfeather", email: "t-a@test.example" });
const B = driver({ id: "drv-b", code: "T-B", firstName: "Blake", lastName: "Ostrander", email: "t-b@test.example" });
const CO = companyDriver({ id: "drv-co", code: "T-CO", firstName: "Casey", lastName: "Marrow", email: "t-co@test.example" });

function settlement(over: Partial<SettlementRecord> & { id: string; driverId: string }): SettlementRecord {
  return {
    periodId: "per-1",
    status: "paid",
    grossCents: c(0),
    deductionsCents: c(0),
    netCents: c(0),
    carryForwardCents: c(0),
    exceptionCount: 0,
    paidAt: "2026-06-12T14:00:00.000Z",
    ...over,
  };
}

const line = (
  settlementId: string,
  kind: string,
  amountCents: number,
  sources: YearEndLine["sources"] = [],
): YearEndLine => ({ settlementId, kind, amountCents, sources });

// One paid settlement per [driver, load pay] pair, paid in June of the year, with one load pay line.
function paidOnce(pairs: readonly [string, number][], year = "2026"): YearEndInput {
  const settlements = pairs.map(([driverId], i) =>
    settlement({ id: `st-${i}`, driverId, paidAt: `${year}-06-12T14:00:00.000Z` }),
  );
  const lines = pairs.map(([, amount], i) => line(`st-${i}`, "load_pay", amount));
  return { settlements, lines, drivers: [A, B, CO], corrections: [] };
}

const run = (input: YearEndInput, args: { year: string; driverId?: string } = { year: "2026" }, today = TODAY) =>
  computeYearEnd1099(input, args, today, NY);

const rowOf = (r: ReportResult, id: string) => r.rows.find((row) => (row.driver as { id: string }).id === id);

describe("year_end_contractors: what counts", () => {
  it("lists contractors only, never a company driver paid in the year", () => {
    const r = run(paidOnce([[A.id, 50_000], [CO.id, 90_000]]));
    expect(r.rows.map((row) => (row.driver as { id: string }).id)).toEqual([A.id]);
    expect(r.rows[0]).toMatchObject({ workerType: "Owner-operator", settlementsPaid: 1, compensationCents: 50_000 });
    expect(JSON.stringify(r)).not.toContain(CO.id);
    expect(r.totals?.compensationCents).toBe(50_000);
  });

  it("counts a settlement by its paid date in the carrier's zone: 23:30 on Dec 31 is the old year, 00:30 on Jan 1 the new", () => {
    const late = instantAt("2025-12-31", 23, 30, NY);
    const early = instantAt("2026-01-01", 0, 30, NY);
    // Both are already Jan 1 in UTC.
    expect(Date.parse(late)).toBe(Date.UTC(2026, 0, 1, 4, 30));
    expect(Date.parse(early)).toBe(Date.UTC(2026, 0, 1, 5, 30));
    const input: YearEndInput = {
      settlements: [settlement({ id: "st-late", driverId: A.id, paidAt: late }), settlement({ id: "st-early", driverId: A.id, paidAt: early })],
      lines: [line("st-late", "load_pay", 10_000), line("st-early", "load_pay", 20_000)],
      drivers: [A],
      corrections: [],
    };
    const y2026 = run(input);
    expect(y2026.rows).toHaveLength(1);
    expect(y2026.rows[0]).toMatchObject({ settlementsPaid: 1, compensationCents: 20_000, firstPaidOn: "2026-01-01" });
    const y2025 = run(input, { year: "2025" });
    expect(y2025.rows[0]).toMatchObject({ settlementsPaid: 1, compensationCents: 10_000, lastPaidOn: "2025-12-31" });
    // The read window of either year holds both instants, so the local date alone decides.
    for (const year of [2025, 2026]) {
      const w = yearEndWindow(year);
      for (const at of [late, early]) {
        expect(Date.parse(w.start) <= Date.parse(at) && Date.parse(at) < Date.parse(w.end), `${year} ${at}`).toBe(true);
      }
    }
  });

  it("reads a window wide enough for any zone, from 14 hours ahead of UTC to 12 behind", () => {
    const w = yearEndWindow(2026);
    expect(w).toEqual({ start: "2025-12-31T00:00:00.000Z", end: "2027-01-02T00:00:00.000Z" });
    const first = instantAt("2026-01-01", 0, 0, "Pacific/Kiritimati");
    const last = instantAt("2026-12-31", 23, 59, "Etc/GMT+12");
    expect(Date.parse(first)).toBeGreaterThanOrEqual(Date.parse(w.start));
    expect(Date.parse(last)).toBeLessThan(Date.parse(w.end));
    expect(() => yearEndWindow(1999)).toThrow(RangeError);
    expect(() => yearEndWindow(2101)).toThrow(RangeError);
    expect(() => yearEndWindow(2026.5)).toThrow(RangeError);
  });

  it("shows reimbursements apart and never adds them to compensation", () => {
    const input: YearEndInput = {
      settlements: [settlement({ id: "st-1", driverId: A.id })],
      lines: [line("st-1", "load_pay", 150_000), line("st-1", "accessorial_pay", 7_500), line("st-1", "reimbursement", 4_200)],
      drivers: [A],
      corrections: [],
    };
    expect(run(input).rows[0]).toMatchObject({ compensationCents: 157_500, reimbursementsCents: 4_200 });
  });

  it("counts a negative load pay or accessorial pay line as stored, which lowers compensation", () => {
    const input: YearEndInput = {
      settlements: [settlement({ id: "st-1", driverId: A.id })],
      lines: [line("st-1", "load_pay", 100_000), line("st-1", "accessorial_pay", -2_500), line("st-1", "load_pay", -1_000)],
      drivers: [A],
      corrections: [],
    };
    expect(run(input).rows[0]).toMatchObject({ compensationCents: 96_500 });
  });

  it("ignores draft and approved settlements and every line that is not pay or a reimbursement", () => {
    const input: YearEndInput = {
      settlements: [
        settlement({ id: "st-paid", driverId: A.id }),
        settlement({ id: "st-approved", driverId: A.id, status: "approved", paidAt: null }),
        settlement({ id: "st-draft", driverId: B.id, status: "draft", paidAt: null }),
        // A paid time on a settlement not marked paid still does not count.
        settlement({ id: "st-approved-2", driverId: B.id, status: "approved" }),
      ],
      lines: [
        line("st-paid", "load_pay", 30_000),
        line("st-paid", "fuel", -12_000),
        line("st-paid", "escrow", -5_000),
        line("st-approved", "load_pay", 999_999),
        line("st-draft", "load_pay", 999_999),
        line("st-approved-2", "load_pay", 999_999),
      ],
      drivers: [A, B],
      corrections: [],
    };
    const r = run(input);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ settlementsPaid: 1, compensationCents: 30_000, reimbursementsCents: 0 });
  });

  it("lists a contractor paid only reimbursements, with compensation 0 that does not meet the threshold", () => {
    const input: YearEndInput = {
      settlements: [settlement({ id: "st-1", driverId: A.id })],
      lines: [line("st-1", "reimbursement", 80_000)],
      drivers: [A],
      corrections: [],
    };
    expect(run(input).rows[0]).toMatchObject({ compensationCents: 0, reimbursementsCents: 80_000, meetsThreshold: "no" });
  });

  it("narrows to one contractor by id, and to none for a company driver or an id not paid", () => {
    const input = paidOnce([[A.id, 50_000], [B.id, 70_000], [CO.id, 90_000]]);
    const one = run(input, { year: "2026", driverId: B.id });
    expect(one.rows.map((row) => (row.driver as { id: string }).id)).toEqual([B.id]);
    expect(one.args).toEqual({ year: "2026", driverId: B.id });
    expect(run(input, { year: "2026", driverId: CO.id }).rows).toEqual([]);
    const none = run(input, { year: "2026", driverId: "drv-nobody" });
    expect(none.rows).toEqual([]);
    expect(none.emptyReason).toBe("no_rows");
  });

  it("sums the totals from the rows, and sorts the largest compensation first", () => {
    const base = paidOnce([[A.id, 50_000], [B.id, 70_000], [A.id, 25_000]]);
    const r = run({ ...base, lines: [...base.lines, line("st-1", "reimbursement", 1_300)] });
    expect(r.rows.map((row) => [(row.driver as { id: string }).id, row.compensationCents, row.settlementsPaid])).toEqual([
      [A.id, 75_000, 2],
      [B.id, 70_000, 1],
    ]);
    const sumOf = (key: string) => r.rows.reduce((n, row) => n + (row[key] as number), 0);
    expect(r.totals).toEqual({
      settlementsPaid: sumOf("settlementsPaid"),
      compensationCents: sumOf("compensationCents"),
      reimbursementsCents: sumOf("reimbursementsCents"),
      correctionsCents: sumOf("correctionsCents"),
    });
    expect(r.totals).toEqual({ settlementsPaid: 3, compensationCents: 145_000, reimbursementsCents: 1_300, correctionsCents: 0 });
    expect(r.period).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(r.asOf).toBe(TODAY);
  });

  it("refuses a paid settlement with no paid time, a driver not on file and a year that is not four digits", () => {
    const noTime: YearEndInput = { settlements: [settlement({ id: "st-1", driverId: A.id, paidAt: null })], lines: [], drivers: [A], corrections: [] };
    expect(() => run(noTime)).toThrow(/no paid time/);
    const noDriver: YearEndInput = { settlements: [settlement({ id: "st-1", driverId: "drv-gone" })], lines: [], drivers: [A], corrections: [] };
    expect(() => run(noDriver)).toThrow(/not on file/);
    expect(() => run(paidOnce([]), { year: "26" })).toThrow(RangeError);
    expect(() => run(paidOnce([]), { year: "2101" })).toThrow(RangeError);
  });
});

describe("year_end_contractors: the threshold by payment year", () => {
  it("keeps the table in year order: $600 through 2025, $2,000 for 2026, not known after", () => {
    expect(NEC_THRESHOLDS).toEqual([
      { throughYear: 2025, cents: 60_000 },
      { throughYear: 2026, cents: 200_000 },
    ]);
    expect(necThresholdCents(2000)).toBe(60_000);
    expect(necThresholdCents(2025)).toBe(60_000);
    expect(necThresholdCents(2026)).toBe(200_000);
    expect(necThresholdCents(2027)).toBeNull();
    expect(necThresholdCents(2100)).toBeNull();
    expect(() => necThresholdCents(2026.5)).toThrow(RangeError);
  });

  it("finds the same threshold whatever order the table is in, and sorts no table", () => {
    const reversed = [...NEC_THRESHOLDS].reverse();
    for (const year of [2000, 2024, 2025, 2026, 2027, 2100]) {
      expect(thresholdCentsIn(reversed, year), String(year)).toBe(necThresholdCents(year));
      expect(thresholdCentsIn(NEC_THRESHOLDS, year), String(year)).toBe(necThresholdCents(year));
    }
    expect(thresholdCentsIn(reversed, 2000)).toBe(60_000);
    expect(thresholdCentsIn(reversed, 2025)).toBe(60_000);
    expect(thresholdCentsIn(reversed, 2026)).toBe(200_000);
    expect(thresholdCentsIn(reversed, 2027)).toBeNull();
    // A shuffled table picks the earliest year on or after the one asked for.
    const shuffled = [
      { throughYear: 2030, cents: 3 },
      { throughYear: 2010, cents: 1 },
      { throughYear: 2020, cents: 2 },
    ];
    expect([2005, 2010, 2015, 2020, 2025, 2030, 2031].map((y) => thresholdCentsIn(shuffled, y))).toEqual([1, 1, 2, 2, 3, 3, null]);
    // Neither the copy nor the shared table is reordered.
    expect(reversed.map((t) => t.throughYear)).toEqual([2026, 2025]);
    expect(shuffled.map((t) => t.throughYear)).toEqual([2030, 2010, 2020]);
    expect(NEC_THRESHOLDS.map((t) => t.throughYear)).toEqual([2025, 2026]);
  });

  it("2025: 59,999 cents does not meet it and 60,000 does", () => {
    const r = run(paidOnce([[A.id, 59_999], [B.id, 60_000]], "2025"), { year: "2025" });
    expect(rowOf(r, A.id)?.meetsThreshold).toBe("no");
    expect(rowOf(r, B.id)?.meetsThreshold).toBe("yes");
    expect(r.form1099).toEqual({ taxYear: 2025, thresholdCents: 60_000, meeting: 1, unclassified: 0 });
    expect(r.notes).toContain(
      "1099-NEC threshold for payments made in 2025: $600.00 (confirm for the tax year). 1 of 2 contractors meets it.",
    );
    // 2025 is over by the carrier's today, so no note says the year is still running.
    expect(r.notes?.some((n) => n.includes("is not over"))).toBe(false);
  });

  it("2026: 199,999 cents does not meet it and 200,000 does, so $600 alone is no longer enough", () => {
    const r = run(paidOnce([[A.id, 199_999], [B.id, 200_000]]));
    expect(rowOf(r, A.id)?.meetsThreshold).toBe("no");
    expect(rowOf(r, B.id)?.meetsThreshold).toBe("yes");
    expect(r.form1099).toEqual({ taxYear: 2026, thresholdCents: 200_000, meeting: 1, unclassified: 0 });
    expect(r.notes).toContain(
      "1099-NEC threshold for payments made in 2026: $2,000.00 (confirm for the tax year). 1 of 2 contractors meets it.",
    );
    expect(r.notes).toContain(`2026 is not over: the totals run through ${TODAY}.`);
  });

  it("2027: the threshold is not known, so no contractor is yes or no and the summary says how many", () => {
    const r = run(paidOnce([[A.id, 10_000], [B.id, 900_000]], "2027"), { year: "2027" }, "2027-03-01");
    expect(r.rows.map((row) => row.meetsThreshold)).toEqual(["unknown", "unknown"]);
    expect(r.form1099).toEqual({ taxYear: 2027, thresholdCents: null, meeting: null, unclassified: 2 });
    expect(r.notes).toContain(
      "1099-NEC threshold for payments made in 2027: not known to this report (confirm for the tax year), so 2 " +
        "contractors were not classified.",
    );
    expect(JSON.stringify(r)).not.toMatch(/"meetsThreshold":"(yes|no)"/);
  });

  it("says how the figures were worked out and that nothing is filed", () => {
    const r = run(paidOnce([[A.id, 50_000]]));
    expect(r.notes?.[0]).toBe(
      "Nonemployee compensation = load pay + accessorial pay on settlements marked paid, counted by the date each " +
        "was paid in the carrier's time zone (America/New_York). Reimbursements are shown apart and not counted. " +
        "Company drivers are not listed.",
    );
    expect(r.notes).toContain("Not a filing: no form is made or sent, and the app holds no tax id or address for any driver.");
    // An empty year keeps these two notes and no threshold note.
    expect(run(paidOnce([])).notes).toEqual([r.notes?.[0], r.notes?.[2]]);
  });

  it("keeps the definition and the not-a-filing notes on an empty result, with no threshold note", () => {
    const definition =
      "Nonemployee compensation = load pay + accessorial pay on settlements marked paid, counted by the date each " +
      "was paid in the carrier's time zone (America/New_York). Reimbursements are shown apart and not counted. " +
      "Company drivers are not listed.";
    const notFiling = "Not a filing: no form is made or sent, and the app holds no tax id or address for any driver.";
    const emptyYear = run(paidOnce([]));
    expect(emptyYear.rows).toEqual([]);
    expect(emptyYear.emptyReason).toBe("no_rows");
    expect(emptyYear.notes).toEqual([definition, notFiling]);
    // One driver asked for by id, a company driver paid in the year: the notes say company drivers are not listed.
    const company = run(paidOnce([[A.id, 250_000], [CO.id, 90_000]]), { year: "2026", driverId: CO.id });
    expect(company.rows).toEqual([]);
    expect(company.emptyReason).toBe("no_rows");
    expect(company.notes).toEqual([definition, notFiling]);
    for (const r of [emptyYear, company]) {
      expect(r.notes?.some((n) => n.startsWith("1099-NEC threshold"))).toBe(false);
      expect(r.notes?.some((n) => n.includes("is not over"))).toBe(false);
    }
    // A result with rows keeps all four notes, in their order.
    expect(run(paidOnce([[A.id, 250_000], [CO.id, 90_000]])).notes).toEqual([
      definition,
      "1099-NEC threshold for payments made in 2026: $2,000.00 (confirm for the tax year). 1 of 1 contractor meets it.",
      notFiling,
      `2026 is not over: the totals run through ${TODAY}.`,
    ]);
  });
});

// An approved pay correction settled on a settlement, and the paystub line the engine makes from
// it: a reimbursement for a positive delta, a deduction for a negative one, citing the item.
function corrected(settlementId: string, driverId: string, itemId: string, deltaCents: number) {
  const kind = deltaCents > 0 ? "reimbursement" : "other_deduction";
  const item: YearEndCorrection = { id: itemId, driverId, settlementId, kind, amountCents: Math.abs(deltaCents) };
  return { item, line: line(settlementId, kind, deltaCents, [{ table: "pay_items", id: itemId }]) };
}

// One settlement paid in June 2026 for a driver: its load pay and the corrections given.
function withCorrections(loadPayCents: number, deltas: readonly number[], driverId = A.id, st = "st-1"): YearEndInput {
  const made = deltas.map((d, i) => corrected(st, driverId, `pi-${st}-${i}`, d));
  return {
    settlements: [settlement({ id: st, driverId })],
    lines: [line(st, "load_pay", loadPayCents), ...made.map((m) => m.line)],
    drivers: [A, B, CO],
    corrections: made.map((m) => m.item),
  };
}

const CORRECTIONS_NOTE =
  "Pay corrections are shown apart and not counted as compensation, because a correction can be pay, a " +
  "reimbursement or a refunded charge. A contractor whose threshold answer depends on them reads unknown, " +
  "and a person decides.";

describe("year_end_contractors: approved pay corrections", () => {
  it("reads unknown when a negative correction could take a contractor under the threshold", () => {
    const r = run(withCorrections(200_500, [-1_000]));
    expect(r.rows[0]).toMatchObject({
      compensationCents: 200_500,
      reimbursementsCents: 0,
      correctionsCents: -1_000,
      meetsThreshold: "unknown",
    });
    expect(r.form1099).toEqual({ taxYear: 2026, thresholdCents: 200_000, meeting: 0, unclassified: 1 });
    expect(r.notes).toContain(
      "1099-NEC threshold for payments made in 2026: $2,000.00 (confirm for the tax year). 0 of 1 contractor " +
        "meet it and 1 reads unknown.",
    );
    expect(r.notes).toContain(CORRECTIONS_NOTE);
    expect(JSON.stringify(r)).not.toMatch(/"meetsThreshold":"(yes|no)"/);
  });

  it("still reads yes when a negative correction cannot change the answer, to the cent", () => {
    for (const [pay, delta] of [
      [300_000, -1_000],
      [201_000, -1_000],
    ]) {
      const r = run(withCorrections(pay, [delta]));
      expect(r.rows[0], `${pay} ${delta}`).toMatchObject({ compensationCents: pay, correctionsCents: delta, meetsThreshold: "yes" });
      expect(r.form1099, `${pay} ${delta}`).toEqual({ taxYear: 2026, thresholdCents: 200_000, meeting: 1, unclassified: 0 });
    }
    // One cent less and the correction decides it.
    expect(run(withCorrections(200_999, [-1_000])).rows[0].meetsThreshold).toBe("unknown");
  });

  it("reads unknown, never yes, when a positive correction would lift a contractor over", () => {
    for (const [pay, delta] of [
      [199_000, 5_000],
      [199_000, 1_000],
    ]) {
      const r = run(withCorrections(pay, [delta]));
      expect(r.rows[0], `${pay} ${delta}`).toMatchObject({ compensationCents: pay, correctionsCents: delta, meetsThreshold: "unknown" });
      expect(r.form1099?.meeting).toBe(0);
      expect(r.form1099?.unclassified).toBe(1);
    }
    // Short of the threshold even with the correction counted: no. Over it without: yes.
    expect(run(withCorrections(190_000, [9_999])).rows[0].meetsThreshold).toBe("no");
    expect(run(withCorrections(200_000, [5_000])).rows[0].meetsThreshold).toBe("yes");
    // Both signs: under with the deduction taken off, over with the reimbursement added.
    const both = run(withCorrections(200_000, [3_000, -500]));
    expect(both.rows[0]).toMatchObject({ compensationCents: 200_000, correctionsCents: 2_500, meetsThreshold: "unknown" });
  });

  it("keeps a positive correction out of the reimbursement column, which holds only real reimbursements", () => {
    const base = withCorrections(50_000, [2_500]);
    const input: YearEndInput = {
      ...base,
      lines: [...base.lines, line("st-1", "reimbursement", 4_200, [{ table: "pay_items", id: "pi-lumper" }])],
    };
    const r = run(input);
    expect(r.rows[0]).toMatchObject({ compensationCents: 50_000, reimbursementsCents: 4_200, correctionsCents: 2_500 });
    expect(r.totals).toEqual({ settlementsPaid: 1, compensationCents: 50_000, reimbursementsCents: 4_200, correctionsCents: 2_500 });
  });

  it("sums the corrections from the rows, signed, and the CSV writes them as numbers", () => {
    const a = withCorrections(150_000, [2_500, -700], A.id, "st-a");
    const b = withCorrections(90_000, [-1_200], B.id, "st-b");
    const input: YearEndInput = {
      settlements: [...a.settlements, ...b.settlements],
      lines: [...a.lines, ...b.lines],
      drivers: [A, B],
      corrections: [...a.corrections, ...b.corrections],
    };
    const r = run(input);
    expect(rowOf(r, A.id)?.correctionsCents).toBe(1_800);
    expect(rowOf(r, B.id)?.correctionsCents).toBe(-1_200);
    const sumOf = (key: string) => r.rows.reduce((n, row) => n + (row[key] as number), 0);
    expect(r.totals?.correctionsCents).toBe(sumOf("correctionsCents"));
    expect(r.totals).toEqual({ settlementsPaid: 2, compensationCents: 240_000, reimbursementsCents: 0, correctionsCents: 600 });
    const csv = reportCsv(r).split("\r\n");
    expect(csv[0]).toContain(",Reimbursements (not counted),Pay corrections (not counted),");
    expect(csv).toContain("Blake Ostrander (T-B),drv-b,Owner-operator,1,900.00,0.00,-12.00,no,2026-06-12,2026-06-12");
    expect(csv).toContain("Total,,,2,2400.00,0.00,6.00,,,");
  });

  it("refuses the report when a correction on a kept settlement has no line, or two, or a line that says otherwise", () => {
    const good = withCorrections(150_000, [2_500]);
    expect(() => run(good)).not.toThrow();
    // The item with no line.
    expect(() => run({ ...good, lines: good.lines.filter((l) => l.kind !== "reimbursement") })).toThrow(
      /exactly one paystub line/,
    );
    // Two lines made from one item.
    expect(() => run({ ...good, lines: [...good.lines, good.lines[1]] })).toThrow(/exactly one paystub line/);
    const cites = [{ table: "pay_items", id: "pi-st-1-0" }];
    // A line that names the item but disagrees with it: another amount, another kind, another
    // settlement, or more than one source.
    const two = { ...good, settlements: [...good.settlements, settlement({ id: "st-2", driverId: A.id })] };
    for (const wrong of [
      line("st-1", "reimbursement", 2_400, cites),
      line("st-1", "other_deduction", -2_500, cites),
      line("st-2", "reimbursement", 2_500, cites),
      line("st-1", "reimbursement", 2_500, [...cites, { table: "loads", id: "load-1" }]),
    ]) {
      expect(() => run({ ...two, lines: [good.lines[0], wrong] }), JSON.stringify(wrong)).toThrow(/does not match/);
    }
    // An item on another driver's settlement cited from this one.
    const theirs: YearEndCorrection = { ...good.corrections[0], driverId: B.id };
    expect(() => run({ ...good, corrections: [theirs] })).toThrow(/does not match/);
    // An item whose kind is neither a reimbursement nor a deduction, or whose amount is not positive.
    const fuel = { ...good, corrections: [{ ...good.corrections[0], kind: "fuel" }] };
    expect(() => run(fuel)).toThrow(/does not match/);
    expect(() => run({ ...fuel, lines: [good.lines[0], line("st-1", "fuel", 2_500, cites)] })).toThrow();
    expect(() => run({ ...good, corrections: [{ ...good.corrections[0], amountCents: -2_500 }] })).toThrow();
    expect(() => run({ ...good, corrections: [good.corrections[0], good.corrections[0]] })).toThrow(/share an id/);
  });

  it("leaves alone a correction on a settlement the report does not keep", () => {
    const input = paidOnce([[A.id, 250_000], [CO.id, 90_000]]);
    // Settled with the company driver's pay, and one not settled at all; neither has a kept line.
    const corrections: YearEndCorrection[] = [
      { id: "pi-co", driverId: CO.id, settlementId: "st-1", kind: "reimbursement", amountCents: 5_000 },
      { id: "pi-open", driverId: A.id, settlementId: null, kind: "other_deduction", amountCents: 5_000 },
    ];
    expect(run({ ...input, corrections })).toEqual(run(input));
    // The year asked for keeps none of A's 2025 settlements, so its correction there is not checked.
    const old = withCorrections(100_000, [5_000]);
    expect(run({ ...old, lines: [old.lines[0]] }, { year: "2025" }).rows).toEqual([]);
  });

  it("never reads a correction from a part of an id or another table: only a source naming the item whole", () => {
    const good = withCorrections(150_000, [2_500]);
    const id = good.corrections[0].id;
    for (const sources of [
      [{ table: "fuel_purchases", id }],
      [{ table: "pay_items", id: id.slice(0, -1) }],
      [{ table: "pay_items", id: `${id}0` }],
      [{ table: "pay_items", id: id.toUpperCase() }],
      [],
    ]) {
      // The real line is there, so the item matches; the extra reimbursement line is a reimbursement.
      const r = run({ ...good, lines: [...good.lines, line("st-1", "reimbursement", 900, sources)] });
      expect(r.rows[0], JSON.stringify(sources)).toMatchObject({ reimbursementsCents: 900, correctionsCents: 2_500 });
    }
  });

  it("gives exactly the old figures, notes and summary with no corrections", () => {
    for (const [pay, year, today] of [
      [199_999, "2026", TODAY],
      [200_000, "2026", TODAY],
      [59_999, "2025", TODAY],
      [60_000, "2025", TODAY],
      [900_000, "2027", "2027-03-01"],
    ] as const) {
      const r = run(paidOnce([[A.id, pay]], year), { year }, today);
      const threshold = necThresholdCents(Number(year));
      const old = threshold === null ? "unknown" : pay >= threshold ? "yes" : "no";
      expect(r.rows[0], `${year} ${pay}`).toMatchObject({ compensationCents: pay, correctionsCents: 0, meetsThreshold: old });
      expect(r.form1099).toEqual({
        taxYear: Number(year),
        thresholdCents: threshold,
        meeting: threshold === null ? null : old === "yes" ? 1 : 0,
        unclassified: threshold === null ? 1 : 0,
      });
      expect(r.notes).not.toContain(CORRECTIONS_NOTE);
      expect(r.notes?.some((n) => n.includes("reads unknown"))).toBe(false);
      expect(r.totals?.correctionsCents).toBe(0);
    }
  });
});

describe("year_end_contractors: the download and the tool result", () => {
  it("guards a name that starts with = in the CSV and writes no email column or address", () => {
    const evil = driver({ id: "drv-evil", code: "T-E", firstName: "=HYPERLINK(\"x\")", lastName: "Doe", email: "evil@test.example" });
    const input: YearEndInput = {
      settlements: [settlement({ id: "st-1", driverId: evil.id }), settlement({ id: "st-2", driverId: A.id })],
      lines: [line("st-1", "load_pay", 250_000), line("st-2", "load_pay", 1_000)],
      drivers: [evil, A],
      corrections: [],
    };
    const r = run(input);
    const csv = reportCsv(r);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Contractor,Contractor id,Type,Settlements paid,Nonemployee compensation,Reimbursements (not counted)," +
        "Pay corrections (not counted),Meets 1099-NEC threshold,First paid,Last paid",
    );
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"") Doe (T-E)",drv-evil,Owner-operator,1,2500.00,0.00,0.00,yes,2026-06-12,2026-06-12`);
    for (const field of csv.split(/[,\r\n]/)) expect(field.startsWith("=")).toBe(false);
    expect(csv.toLowerCase()).not.toContain("email");
    expect(csv).not.toContain("@test.example");
    expect(JSON.stringify(r)).not.toContain("@test.example");
    expect(REPORT_COLUMNS.year_end_contractors.map((col) => col.key)).not.toContain("email");
  });

  it("keeps at most 50 rows in a tool result, with the row count, the totals and the threshold kept whole", () => {
    const drivers = Array.from({ length: 60 }, (_, i) =>
      driver({ id: `drv-${String(i).padStart(2, "0")}`, code: `T-${i}`, firstName: "Driver", lastName: `Number${i}` }),
    );
    const input: YearEndInput = {
      settlements: drivers.map((d, i) => settlement({ id: `st-${i}`, driverId: d.id })),
      lines: drivers.map((_, i) => line(`st-${i}`, "load_pay", 150_000 + i * 1_000)),
      drivers,
      corrections: [],
    };
    const full = run(input);
    expect(full.rows).toHaveLength(60);
    const fitted = fitResult(full) as {
      rows: unknown[];
      rowsShown: number;
      rowsTotal: number;
      truncated: boolean;
      totals: unknown;
      notes: string[];
      form1099: unknown;
    };
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(REPORT_RESULT_CHARS);
    expect(fitted.rows.length).toBeGreaterThan(0);
    expect(fitted.rows.length).toBeLessThanOrEqual(50);
    expect(fitted.rowsShown).toBe(fitted.rows.length);
    expect(fitted.rowsTotal).toBe(60);
    expect(fitted.truncated).toBe(true);
    expect(fitted.totals).toEqual(full.totals);
    expect(fitted.form1099).toEqual({ taxYear: 2026, thresholdCents: 200_000, meeting: 10, unclassified: 0 });
    // The threshold note's dollar figure passes the agent's figure check from the fitted result alone.
    const note = fitted.notes.find((n) => n.startsWith("1099-NEC threshold"));
    if (!note) throw new Error("no threshold note");
    expect(maskFigures(note, centsIn(fitted))).toEqual({ text: note, masked: 0 });
  });
});

// The Blue Ridge seed plan's own sums for a year, worked from its rows apart from the report.
function planSums(plan: CarrierPlan, year: string) {
  const zone = plan.carrier.timezone;
  const contractors = new Set(plan.rows.drivers.filter((d) => d.worker_type === "owner_operator").map((d) => d.id));
  const kept = plan.rows.settlements.filter(
    (s) => s.status === "paid" && s.paid_at !== null && localDateOf(s.paid_at, zone).startsWith(year) && contractors.has(s.driver_id),
  );
  const ids = new Set(kept.map((s) => s.id));
  // A line made from an approved pay correction's item is a correction, whatever its kind.
  const corrections = new Set(plan.rows.pay_items.filter((i) => i.ref_table === "proposals").map((i) => i.id));
  const isCorrection = (l: (typeof plan.rows.settlement_lines)[number]) =>
    l.sources.some((src) => src.table === "pay_items" && corrections.has(src.id));
  const lines = plan.rows.settlement_lines.filter((l) => ids.has(l.settlement_id));
  const total = (kinds: string[]) =>
    lines.filter((l) => kinds.includes(l.kind) && !isCorrection(l)).reduce((n, l) => n + l.amount_cents, 0);
  return {
    settlementsPaid: kept.length,
    compensationCents: total(["load_pay", "accessorial_pay"]),
    reimbursementsCents: total(["reimbursement"]),
    correctionsCents: lines.filter(isCorrection).reduce((n, l) => n + l.amount_cents, 0),
    contractors: new Set(kept.map((s) => s.driver_id)).size,
  };
}

describe("year_end_contractors on the Blue Ridge seed plan", () => {
  const plan = blueRidgePlan();
  const CLOCK: ReportClock = { now: new Date(Date.UTC(2026, 10, 2, 17, 0, 0)), timeZone: plan.carrier.timezone };
  const request = (args: Record<string, string>) => {
    const parsed = parseReportArgs("year_end_contractors", args);
    if (!parsed) throw new Error("bad test args");
    return parsed;
  };
  const report = (args: Record<string, string>, clock = CLOCK) =>
    planDb(plan).withTenant(TENANT, (q) => computeReport(q, request(args), clock));

  beforeEach(() => {
    flags.yearEndEnabled = true;
  });
  afterEach(() => {
    flags.yearEndEnabled = false;
  });

  it("matches the plan's own sums for 2026 through the real readers", async () => {
    const want = planSums(plan, "2026");
    expect(want.contractors).toBeGreaterThan(0);
    const r = await report({ year: "2026" });
    expect(r.totals).toEqual({
      settlementsPaid: want.settlementsPaid,
      compensationCents: want.compensationCents,
      reimbursementsCents: want.reimbursementsCents,
      correctionsCents: want.correctionsCents,
    });
    expect(r.rowsTotal).toBe(want.contractors);
    expect(r.rows.every((row) => row.workerType === "Owner-operator")).toBe(true);
    expect(r.form1099?.thresholdCents).toBe(200_000);
    expect(r.form1099?.meeting).toBe(r.rows.filter((row) => row.meetsThreshold === "yes").length);
    // The seed pays nothing in 2025.
    expect((await report({ year: "2025" })).rows).toEqual([]);
  });

  it("defaults to the year of the carrier's today, in its own zone", async () => {
    const today = await report({});
    expect(today.args).toEqual({ year: "2026" });
    expect(today.asOf).toBe("2026-11-02");
    // 03:00 UTC on Jan 1, 2027 is still Dec 31, 2026 in New York.
    const lastNight = await report({}, { now: new Date(Date.UTC(2027, 0, 1, 3, 0, 0)), timeZone: plan.carrier.timezone });
    expect(lastNight.args).toEqual({ year: "2026" });
    expect(lastNight.asOf).toBe("2026-12-31");
    expect(lastNight.totals).toEqual(today.totals);
  });

  it("reads a correction by its approved item through the real reader, never by a line's label", async () => {
    const zone = plan.carrier.timezone;
    const contractors = new Set(plan.rows.drivers.filter((d) => d.worker_type === "owner_operator").map((d) => d.id));
    const st = plan.rows.settlements.find(
      (s) => s.status === "paid" && s.paid_at !== null && localDateOf(s.paid_at, zone).startsWith("2026") && contractors.has(s.driver_id),
    );
    if (!st) throw new Error("the plan pays no contractor in 2026");
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const item = (id: string, kind: "reimbursement" | "other_deduction", amount: number, approved: boolean) => ({
      id,
      driver_id: st.driver_id,
      kind,
      subkind: "correction",
      amount_cents: amount,
      item_date: "2026-06-01",
      ref_table: approved ? ("proposals" as const) : null,
      ref_id: approved ? uuid(99) : null,
      item_ref: approved ? `correction:${uuid(99)}` : `decoy:${id}`,
      description: "Pay correction",
      settlement_id: st.id,
    });
    const stub = (n: number, kind: string, label: string, amount: number, sources: { table: string; id: string }[]) => ({
      id: uuid(n),
      settlement_id: st.id,
      seq: 900 + n,
      kind,
      label,
      amount_cents: amount,
      sources,
      meta: null,
    });
    const changed: CarrierPlan = {
      ...plan,
      rows: {
        ...plan.rows,
        pay_items: [
          ...plan.rows.pay_items,
          item(uuid(1), "other_deduction", 1_500, true),
          item(uuid(2), "reimbursement", 700, false),
        ],
        settlement_lines: [
          ...plan.rows.settlement_lines,
          // The approved correction's line.
          stub(11, "other_deduction", "Deduction (correction)", -1_500, [{ table: "pay_items", id: uuid(1) }]),
          // Labeled as corrections but made from no approved correction: a reimbursement counts as
          // one, and a deduction is not read at all.
          stub(12, "reimbursement", "Reimbursement (correction)", 700, [{ table: "pay_items", id: uuid(2) }]),
          stub(13, "other_deduction", "Deduction (correction)", -400, []),
        ],
      },
    };
    const before = await report({ year: "2026" });
    const after = await planDb(changed).withTenant(TENANT, (q) => computeReport(q, request({ year: "2026" }), CLOCK));
    const was = rowOf(before, st.driver_id);
    const now = rowOf(after, st.driver_id);
    expect(was?.correctionsCents).toBe(0);
    expect(now).toMatchObject({
      compensationCents: was?.compensationCents,
      reimbursementsCents: (was?.reimbursementsCents as number) + 700,
      correctionsCents: -1_500,
    });
    expect(after.totals).toEqual({
      ...before.totals,
      reimbursementsCents: (before.totals?.reimbursementsCents ?? 0) + 700,
      correctionsCents: -1_500,
    });
    expect(after.notes).toContain(CORRECTIONS_NOTE);
    expect(before.notes).not.toContain(CORRECTIONS_NOTE);
  });

  it("is refused by computeReport itself while its own switch is off, even with the reports on", async () => {
    flags.yearEndEnabled = false;
    expect(flags.reportsEnabled).toBe(true);
    await expect(report({ year: "2026" })).rejects.toBeInstanceOf(ReportsOffError);
    // The IFTA quarter's switch does not open it.
    flags.iftaEnabled = true;
    try {
      await expect(report({ year: "2026" })).rejects.toBeInstanceOf(ReportsOffError);
    } finally {
      flags.iftaEnabled = false;
    }
  });
});
