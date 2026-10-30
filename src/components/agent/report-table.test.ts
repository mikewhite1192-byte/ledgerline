import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REPORT_COLUMNS, REPORT_TITLES, type ReportResult } from "@/lib/reports/types";
import { formatBps, formatMilli, reportResultOf, reportTable } from "./report-table";

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

describe("reportTable captions and cells", () => {
  const aging: ReportResult = {
    report: "ar_aging",
    title: REPORT_TITLES.ar_aging,
    asOf: "2026-10-15",
    args: { asOf: "2026-10-15" },
    columns: [...REPORT_COLUMNS.ar_aging],
    rows: [{ customer: { table: "customers", id: "c1", label: "Harbor Foods" }, currentCents: 100, totalCents: 100 }],
    totals: { currentCents: 100, totalCents: 100 },
    truncated: false,
    rowsTotal: 1,
  };

  it("says the open balances are today's, counted late as of the date asked", () => {
    const t = reportTable("ar_aging", { state: "ready", result: aging });
    expect(t.caption).toBe("Open balances today, by how late they are as of Oct 15, 2026");
  });

  it("keeps the plain as-of caption for a report with no week", () => {
    const advances: ReportResult = {
      ...aging,
      report: "advances_outstanding",
      title: REPORT_TITLES.advances_outstanding,
      columns: [...REPORT_COLUMNS.advances_outstanding],
      rows: [],
      totals: undefined,
      rowsTotal: 0,
    };
    const t = reportTable("advances_outstanding", { state: "ready", result: advances });
    expect(t.caption).toBe("Advances outstanding, as of Oct 15, 2026");
  });

  it("shows a malformed date cell as not known instead of breaking the chat", () => {
    const html = (node: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node));
    const advances = (oldestRequestedOn: string): ReportResult => ({
      ...aging,
      report: "advances_outstanding",
      title: REPORT_TITLES.advances_outstanding,
      columns: [...REPORT_COLUMNS.advances_outstanding],
      rows: [{ driver: { table: "drivers", id: "d1", label: "Ann" }, advances: 1, outstandingCents: 5000, oldestRequestedOn }],
      totals: undefined,
    });
    const cellFor = (value: string) => {
      const t = reportTable("advances_outstanding", { state: "ready", result: advances(value) });
      const column = t.columns.find((c) => c.key === "oldestRequestedOn");
      if (!column) throw new Error("date column missing");
      return html(column.cell(t.rows[0]));
    };
    expect(cellFor("2026-10-12")).toBe("Oct 12, 2026");
    for (const bad of ["2026-02-30", "10/12/2026", "", "2026-1-2"]) {
      expect(() => cellFor(bad), bad).not.toThrow();
      expect(cellFor(bad), bad).toContain("Not known");
    }
  });
});

describe("the IFTA quarter in the chat", () => {
  const html = (node: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node));
  const ifta: ReportResult = {
    report: "ifta_quarter",
    title: REPORT_TITLES.ifta_quarter,
    asOf: "2026-11-02",
    args: { asOf: "2026-11-02" },
    period: { start: "2026-10-01", end: "2026-12-31" },
    columns: [...REPORT_COLUMNS.ifta_quarter],
    rows: [
      {
        state: "NC",
        miles: 1600,
        taxPaidGallonsMilli: 300000,
        taxableGallonsMilli: 240276,
        netGallonsMilli: -59724,
        sampleRate: "$0.3630",
        taxDueCents: -2168,
      },
    ],
    totals: { miles: 1600, taxPaidGallonsMilli: 300000, taxableGallonsMilli: 240276, netGallonsMilli: -59724, taxDueCents: -2168 },
    truncated: false,
    rowsTotal: 1,
    notes: ["SAMPLE rates: placeholders.", "No data gaps."],
  };

  it("writes gallons in thousandths to three places from the integer", () => {
    expect(formatMilli(450500)).toBe("450.500");
    expect(formatMilli(-59724)).toBe("-59.724");
    expect(formatMilli(17)).toBe("0.017");
    expect(formatMilli(-1)).toBe("-0.001");
    expect(formatMilli(0)).toBe("0.000");
  });

  it("refuses gallons that are not a whole number of thousandths, and the table shows them as not known", () => {
    expect(() => formatMilli(1.5)).toThrow("not a whole number");
    expect(() => formatMilli(Number.MAX_SAFE_INTEGER + 1)).toThrow("not a whole number");
    for (const odd of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const bad: ReportResult = { ...ifta, rows: [{ ...ifta.rows[0], netGallonsMilli: odd }] };
      const t = reportTable("ifta_quarter", { state: "ready", result: bad });
      const net = t.columns.find((c) => c.key === "netGallonsMilli");
      if (!net) throw new Error("net gallons column missing");
      const cell = html(net.cell(t.rows[0]));
      expect(cell, String(odd)).toContain("Not known");
      expect(cell, String(odd)).not.toContain("0.1.5");
    }
  });

  it("right-aligns the gallons and shows them, and the total, to three places", () => {
    const t = reportTable("ifta_quarter", { state: "ready", result: ifta });
    const net = t.columns.find((c) => c.key === "netGallonsMilli");
    if (!net) throw new Error("net gallons column missing");
    expect(net.align).toBe("right");
    expect(t.rows.map((l) => l.kind)).toEqual(["row", "total"]);
    expect(html(net.cell(t.rows[0]))).toContain("-59.724");
    expect(html(net.cell(t.rows[1]))).toContain("-59.724");
  });

  it("puts the notes after the title as plain sentences, and leaves out anything that is not text", () => {
    const t = reportTable("ifta_quarter", { state: "ready", result: ifta });
    expect(t.caption).toBe("IFTA quarter summary (SAMPLE rates), Oct 1 to Dec 31, 2026. SAMPLE rates: placeholders. No data gaps.");
    const odd = { ...ifta, notes: ["Kept.", 7, null] as unknown as string[] };
    expect(reportTable("ifta_quarter", { state: "ready", result: odd }).caption).toMatch(/\. Kept\.$/);
    const none: ReportResult = { ...ifta };
    delete none.notes;
    expect(reportTable("ifta_quarter", { state: "ready", result: none }).caption).not.toContain("SAMPLE rates:");
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

  it("refuses a body whose caption dates are not calendar dates, so the chat never throws on them", () => {
    expect(reportResultOf("cash_needed", { ...result, asOf: "2026-02-30" })).toBeNull();
    expect(reportResultOf("cash_needed", { ...result, period: { start: "2026-10-26", end: "soon" } })).toBeNull();
    expect(reportResultOf("cash_needed", { ...result, period: { start: "2026-11-01", end: "2026-10-26" } })).toBeNull();
    expect(reportResultOf("cash_needed", { ...result, period: null })).toBeNull();
    const noPeriod: ReportResult = { ...result };
    delete noPeriod.period;
    expect(reportResultOf("cash_needed", noPeriod)).toEqual(noPeriod);
  });
});
