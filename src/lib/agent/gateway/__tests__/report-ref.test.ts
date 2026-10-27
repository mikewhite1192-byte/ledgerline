import { describe, expect, it } from "vitest";
import { reportRefOf } from "../report-ref";

const ID = "6F1C2B3A-4D5E-4F60-8A7B-9C0D1E2F3A4B";

describe("reportRefOf", () => {
  it("keeps the report name and its parsed args only", () => {
    const ref = reportRefOf("report_driver_pay_summary", {
      report: "driver_pay_summary",
      args: { periodStart: "2026-10-19", driverId: ID },
      rows: [{ driver: { label: "Ann" } }],
    });
    expect(ref).toEqual({ name: "driver_pay_summary", args: { periodStart: "2026-10-19", driverId: ID.toLowerCase() } });
  });

  it("refuses a tool that is not a report, a near name, or a result for another report", () => {
    const body = { report: "ar_aging", args: { asOf: "2026-11-02" } };
    expect(reportRefOf("get_pay_items", body)).toBeNull();
    expect(reportRefOf("report_ar_aging_v2", body)).toBeNull();
    expect(reportRefOf("report_cash_needed", body)).toBeNull();
  });

  it("refuses args the report's schema would not take", () => {
    expect(reportRefOf("report_ar_aging", { report: "ar_aging", args: { asOf: "soon" } })).toBeNull();
    expect(reportRefOf("report_ar_aging", { report: "ar_aging", args: { asOf: "2026-11-02", note: "x" } })).toBeNull();
    expect(reportRefOf("report_ar_aging", { report: "ar_aging", args: ["2026-11-02"] })).toBeNull();
    expect(reportRefOf("report_ar_aging", { report: "ar_aging" })).toBeNull();
  });
});
