import { describe, expect, it } from "vitest";
import { REPORT_COLUMNS, REPORT_TITLES, type ReportResult } from "@/lib/reports/types";
import { formatBps, reportResultOf, reportTable } from "./report-table";

const result: ReportResult = {
  report: "cash_needed",
  title: REPORT_TITLES.cash_needed,
  asOf: "2026-11-02",
  args: { periodStart: "2026-10-26" },
  period: { start: "2026-10-26", end: "2026-11-01" },
  columns: [...REPORT_COLUMNS.cash_needed],
  rows: [{ driver: { table: "drivers", id: "d1", label: "Ann" }, workerType: "Company driver", status: "Draft", netDueCents: 100 }],
  totals: { netDueCents: 100 },
  subtotals: [{ label: "Company drivers", totals: { netDueCents: 100 } }],
  truncated: false,
  rowsTotal: 1,
};

describe("formatBps", () => {
  it("writes basis points as a percent from the integer", () => {
    expect(formatBps(1234)).toBe("12.34%");
    expect(formatBps(-5)).toBe("-0.05%");
    expect(formatBps(0)).toBe("0.00%");
    expect(formatBps(10000)).toBe("100.00%");
  });
});

describe("reportTable", () => {
  it("puts rows, then subtotals, then the total, right-aligning the money", () => {
    const t = reportTable("cash_needed", { state: "ready", result });
    expect(t.state).toBe("ready");
    expect(t.rows.map((l) => l.kind)).toEqual(["row", "subtotal", "total"]);
    expect(t.columns.find((c) => c.key === "netDueCents")?.align).toBe("right");
    expect(t.caption).toContain("Cash needed for the pay run");
  });

  it("says when the chat shows fewer rows than the report has", () => {
    const t = reportTable("cash_needed", { state: "ready", result: { ...result, truncated: true, rowsTotal: 80 } });
    expect(t.caption).toContain("Showing the first 1 of 80 rows; the CSV has them all");
  });

  it("explains an empty week as no pay run yet", () => {
    const t = reportTable("cash_needed", {
      state: "ready",
      result: { ...result, rows: [], totals: undefined, subtotals: undefined, rowsTotal: 0, emptyReason: "no_pay_run" },
    });
    expect(t.state).toBe("empty");
    expect(t.empty).toEqual({ title: "No pay run for this week yet", body: "Build the pay run for this week first." });
  });
});

describe("reportResultOf", () => {
  it("takes only the report that was asked for, in the expected shape", () => {
    expect(reportResultOf("cash_needed", result)).toBe(result);
    expect(reportResultOf("ar_aging", result)).toBeNull();
    expect(reportResultOf("cash_needed", { ...result, rows: "x" })).toBeNull();
    expect(reportResultOf("cash_needed", { error: "not_found" })).toBeNull();
    expect(reportResultOf("cash_needed", null)).toBeNull();
  });
});
