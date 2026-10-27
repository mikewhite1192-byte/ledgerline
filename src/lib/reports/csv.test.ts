import { describe, expect, it } from "vitest";
import { guardText, reportCsv } from "./csv";
import { REPORT_COLUMNS, REPORT_TITLES, type ReportResult } from "./types";

function margin(rows: ReportResult["rows"], extra: Partial<ReportResult> = {}): ReportResult {
  return {
    report: "margin_per_load",
    title: REPORT_TITLES.margin_per_load,
    asOf: "2026-11-02",
    args: { periodStart: "2026-10-05", periodEnd: "2026-11-01" },
    columns: [...REPORT_COLUMNS.margin_per_load],
    rows,
    truncated: false,
    rowsTotal: rows.length,
    ...extra,
  };
}

const LOAD = { table: "loads", id: "11111111-1111-4111-8111-111111111111", label: "L-1" };
const CUSTOMER = { table: "customers", id: "22222222-2222-4222-8222-222222222222", label: "=HYPERLINK(\"x\")" };

describe("guardText", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])("guards %j", (text) => {
    expect(guardText(text)).toBe(`'${text}`);
  });

  it("leaves plain text alone", () => {
    expect(guardText("Acme Freight")).toBe("Acme Freight");
    expect(guardText("")).toBe("");
  });
});

describe("reportCsv", () => {
  it("writes a header with a label and id column per record, rows, and a total, CRLF ended", () => {
    const csv = reportCsv(
      margin(
        [
          {
            load: LOAD,
            deliveredOn: "2026-10-07",
            customer: CUSTOMER,
            driver: null,
            revenueCents: 123456,
            driverPayCents: 150000,
            marginCents: -26544,
            marginBps: -2150,
            note: "No driver; checked, twice",
          },
        ],
        { totals: { revenueCents: 123456, driverPayCents: 150000, marginCents: -26544, marginBps: -2150 } },
      ),
    );
    const lines = csv.split("\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines[0]).toBe(
      "Load,Load id,Delivered,Customer,Customer id,Driver,Driver id,Revenue,Driver pay,Margin,Margin %,Note",
    );
    expect(lines[1]).toBe(
      `L-1,${LOAD.id},2026-10-07,"'=HYPERLINK(""x"")",${CUSTOMER.id},,,1234.56,1500.00,-265.44,-21.50%,"No driver; checked, twice"`,
    );
    expect(lines[2]).toBe("Total,,,,,,,1234.56,1500.00,-265.44,-21.50%,");
    expect(lines[3]).toBe("");
    expect(lines).toHaveLength(4);
  });

  it("guards a note and a label that start like a formula, and never a negative number", () => {
    const csv = reportCsv(
      margin([
        {
          load: { ...LOAD, label: "@L-2" },
          deliveredOn: "2026-10-08",
          customer: null,
          driver: null,
          revenueCents: -5,
          driverPayCents: null,
          marginCents: null,
          marginBps: null,
          note: "-cmd",
        },
      ]),
    );
    const row = csv.split("\r\n")[1];
    expect(row).toBe(`'@L-2,${LOAD.id},2026-10-08,,,,,-0.05,,,,'-cmd`);
  });

  it("writes subtotals before the total, and no sum rows for an empty report", () => {
    const base: ReportResult = {
      report: "cash_needed",
      title: REPORT_TITLES.cash_needed,
      asOf: "2026-11-02",
      args: {},
      columns: [...REPORT_COLUMNS.cash_needed],
      rows: [
        { driver: { table: "drivers", id: "d1", label: "Ann (BR-D01)" }, workerType: "Company driver", status: "Draft", netDueCents: 100 },
      ],
      totals: { netDueCents: 100 },
      subtotals: [{ label: "Company drivers", totals: { netDueCents: 100 } }],
      truncated: false,
      rowsTotal: 1,
    };
    expect(reportCsv(base).split("\r\n").slice(1, 4)).toEqual([
      "Ann (BR-D01),d1,Company driver,Draft,1.00",
      "Company drivers,,,,1.00",
      "Total,,,,1.00",
    ]);
    expect(reportCsv({ ...base, rows: [], rowsTotal: 0 })).toBe("Driver,Driver id,Type,Status,Net due\r\n");
  });

  it("refuses a money value that is not a whole number of cents", () => {
    expect(() =>
      reportCsv(margin([{ load: LOAD, deliveredOn: "2026-10-07", revenueCents: 1.5 }])),
    ).toThrow("not a whole number");
  });
});
