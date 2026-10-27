import { describe, expect, it } from "vitest";
import { argStrings, parseReportArgs, parseReportQuery } from "./args";
import { capRows, reportOfTool, reportPath, reportToolName, type ReportResult } from "./types";

const ID = "6F1C2B3A-4D5E-4F60-8A7B-9C0D1E2F3A4B";

describe("report args", () => {
  it("allows a 92-day margin window and refuses 93 days or a backward one", () => {
    expect(parseReportArgs("margin_per_load", { periodStart: "2026-08-03", periodEnd: "2026-11-02" })).not.toBeNull();
    expect(parseReportArgs("margin_per_load", { periodStart: "2026-08-02", periodEnd: "2026-11-02" })).toBeNull();
    expect(parseReportArgs("margin_per_load", { periodStart: "2026-11-02", periodEnd: "2026-11-01" })).toBeNull();
    expect(parseReportArgs("margin_per_load", { periodStart: "2026-11-02", periodEnd: "2026-11-02" })).not.toBeNull();
  });

  it("refuses a bad uuid, a date that is not on the calendar and an unknown key", () => {
    expect(parseReportArgs("driver_pay_summary", { driverId: "not-a-uuid" })).toBeNull();
    expect(parseReportArgs("ar_aging", { asOf: "2026-02-30" })).toBeNull();
    expect(parseReportArgs("ar_aging", { asOf: "11/02/2026" })).toBeNull();
    expect(parseReportArgs("ar_aging", { asOf: "2026-11-02", sql: "select 1" })).toBeNull();
    expect(parseReportArgs("advances_outstanding", { asOf: 20261102 })).toBeNull();
  });

  it("lowercases ids and keeps only string values", () => {
    const parsed = parseReportArgs("driver_pay_summary", { driverId: ID });
    expect(parsed?.args).toEqual({ driverId: ID.toLowerCase() });
    expect(argStrings({ a: "x", b: undefined, c: 3 })).toEqual({ a: "x" });
  });
});

describe("report query", () => {
  it("refuses an unknown report name", () => {
    expect(parseReportQuery("payroll_dump", new URLSearchParams())).toBeNull();
    expect(parseReportQuery("__proto__", new URLSearchParams())).toBeNull();
    expect(parseReportQuery(undefined, new URLSearchParams())).toBeNull();
  });

  it("defaults to csv, takes json, and refuses another format or a repeated key", () => {
    expect(parseReportQuery("ar_aging", new URLSearchParams())?.format).toBe("csv");
    expect(parseReportQuery("ar_aging", new URLSearchParams("format=json"))?.format).toBe("json");
    expect(parseReportQuery("ar_aging", new URLSearchParams("format=xlsx"))).toBeNull();
    expect(parseReportQuery("ar_aging", new URLSearchParams("asOf=2026-11-02&asOf=2026-11-01"))).toBeNull();
    expect(parseReportQuery("ar_aging", new URLSearchParams("format=csv&format=json"))).toBeNull();
    expect(parseReportQuery("ar_aging", new URLSearchParams("asOf=2026-11-02&x=1"))).toBeNull();
  });

  it("reads the report's own args from the query", () => {
    const q = parseReportQuery("margin_per_load", new URLSearchParams("periodStart=2026-10-05&periodEnd=2026-11-01"));
    expect(q?.request).toEqual({ name: "margin_per_load", args: { periodStart: "2026-10-05", periodEnd: "2026-11-01" } });
  });

  it("round-trips through the path a link carries", () => {
    const path = reportPath("margin_per_load", { periodEnd: "2026-11-01", periodStart: "2026-10-05" }, "csv");
    expect(path).toBe("/api/reports/margin_per_load?format=csv&periodEnd=2026-11-01&periodStart=2026-10-05");
    const url = new URL(path, "http://localhost");
    expect(parseReportQuery("margin_per_load", url.searchParams)?.request.args).toEqual({
      periodStart: "2026-10-05",
      periodEnd: "2026-11-01",
    });
  });
});

describe("report names and caps", () => {
  it("maps tools to reports by whole name only", () => {
    expect(reportToolName("cash_needed")).toBe("report_cash_needed");
    expect(reportOfTool("report_cash_needed")).toBe("cash_needed");
    expect(reportOfTool("report_cash_needed_x")).toBeNull();
    expect(reportOfTool("cash_needed")).toBeNull();
    expect(reportOfTool(7)).toBeNull();
  });

  it("caps rows and says so", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ n: i }));
    const result = { rows, truncated: false, rowsTotal: 60 } as unknown as ReportResult;
    const capped = capRows(result);
    expect(capped.rows).toHaveLength(50);
    expect(capped.truncated).toBe(true);
    expect(capped.rowsTotal).toBe(60);
    expect(capRows({ ...result, rows: rows.slice(0, 50) })).toEqual({ ...result, rows: rows.slice(0, 50) });
  });
});
