// The seven reports: their names, titles, columns and result shape. Plain data with no imports, so
// the chat, the turn view and the download route can all use it without reaching the records or
// the rules engine. The numbers themselves are computed in the files next to this one, from the
// records and the engine's own functions; a model only picks a report and fills its typed args.

export const REPORT_NAMES = [
  "ar_aging",
  "driver_pay_summary",
  "advances_outstanding",
  "cash_needed",
  "margin_per_load",
  "ifta_quarter",
  "year_end_contractors",
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export function isReportName(value: unknown): value is ReportName {
  return typeof value === "string" && (REPORT_NAMES as readonly string[]).includes(value);
}

// The gateway tool for each report is its name with this prefix.
export const REPORT_TOOL_PREFIX = "report_";

export function reportToolName(name: ReportName): string {
  return `${REPORT_TOOL_PREFIX}${name}`;
}

// The report a tool name stands for, by whole-name match only.
export function reportOfTool(tool: unknown): ReportName | null {
  return REPORT_NAMES.find((n) => reportToolName(n) === tool) ?? null;
}

export const REPORT_TITLES: Readonly<Record<ReportName, string>> = {
  ar_aging: "Receivables aging",
  driver_pay_summary: "Driver pay summary",
  advances_outstanding: "Advances outstanding",
  cash_needed: "Cash needed for the pay run",
  margin_per_load: "Margin per load",
  ifta_quarter: "IFTA quarter summary (SAMPLE rates)",
  year_end_contractors: "Year-end 1099 contractor totals (not a filing)",
};

// cents: integer cents. int: a count. pct: basis points (1234 is 12.34%). milli: thousandths
// (450500 is 450.500 gallons). date: YYYY-MM-DD in the carrier's time zone. ref: a record
// ({ table, id, label }). text: fixed words.
export type ColumnKind = "text" | "cents" | "int" | "pct" | "milli" | "date" | "ref";
export type ReportColumn = { key: string; header: string; kind: ColumnKind };

export type RefCell = { table: string; id: string; label: string };
export type ReportCell = string | number | null | RefCell;
export type ReportRow = Record<string, ReportCell>;

// Why a report has no rows: no pay run for the week asked about, or nothing matched.
export type EmptyReason = "no_pay_run" | "no_rows";

export type ReportSubtotal = { label: string; totals: Record<string, number> };

export type ReportResult = {
  report: ReportName;
  title: string;
  // The carrier-local date the report was computed on (or the date asked for).
  asOf: string;
  // The args after defaults were filled in, so the same report can be computed again.
  args: Record<string, string>;
  // The pay week or date window the rows cover, when the report has one.
  period?: { start: string; end: string };
  columns: ReportColumn[];
  rows: ReportRow[];
  // Keyed by column key; summed by the code, never by a model.
  totals?: Record<string, number>;
  subtotals?: ReportSubtotal[];
  // True when rows holds fewer than rowsTotal rows.
  truncated: boolean;
  rowsTotal: number;
  emptyReason?: EmptyReason;
  // Fixed sentences the report code writes from its own numbers (never model text): how a figure
  // was worked out and what the totals leave out. Shown under the table and after the CSV total.
  notes?: string[];
  // The IFTA quarter only: the state with the largest tax due, in integer cents. Kept beside the
  // rows, so a tool result cut to fit still holds the figure the note names.
  largestTaxDue?: { state: string; taxCents: number };
  // The year-end 1099 only: the tax year, the 1099-NEC threshold for payments made in it (null
  // when the code does not know it), how many contractors meet it (null when unknown) and how
  // many could not be classified. Kept beside the rows for the same reason.
  form1099?: { taxYear: number; thresholdCents: number | null; meeting: number | null; unclassified: number };
};

// Every cents column key ends in "Cents", so the agent's figure check accepts what a report says.
export const REPORT_COLUMNS: Readonly<Record<ReportName, readonly ReportColumn[]>> = {
  ar_aging: [
    { key: "customer", header: "Customer", kind: "ref" },
    { key: "currentCents", header: "Current", kind: "cents" },
    { key: "days1To30Cents", header: "1 to 30 days", kind: "cents" },
    { key: "days31To60Cents", header: "31 to 60 days", kind: "cents" },
    { key: "days61To90Cents", header: "61 to 90 days", kind: "cents" },
    { key: "over90Cents", header: "Over 90 days", kind: "cents" },
    { key: "totalCents", header: "Total", kind: "cents" },
  ],
  driver_pay_summary: [
    { key: "driver", header: "Driver", kind: "ref" },
    { key: "workerType", header: "Type", kind: "text" },
    { key: "status", header: "Status", kind: "text" },
    { key: "grossCents", header: "Gross", kind: "cents" },
    { key: "deductionsCents", header: "Deductions", kind: "cents" },
    { key: "netCents", header: "Net pay", kind: "cents" },
    { key: "carryForwardCents", header: "Carried forward", kind: "cents" },
    { key: "exceptions", header: "Exceptions", kind: "int" },
  ],
  advances_outstanding: [
    { key: "driver", header: "Driver", kind: "ref" },
    { key: "advances", header: "Advances", kind: "int" },
    { key: "outstandingCents", header: "Outstanding", kind: "cents" },
    { key: "oldestRequestedOn", header: "Oldest request", kind: "date" },
    { key: "limitCents", header: "Limit", kind: "cents" },
    { key: "headroomCents", header: "Room left", kind: "cents" },
  ],
  cash_needed: [
    { key: "driver", header: "Driver", kind: "ref" },
    { key: "workerType", header: "Type", kind: "text" },
    { key: "status", header: "Status", kind: "text" },
    { key: "netDueCents", header: "Net due", kind: "cents" },
  ],
  margin_per_load: [
    { key: "load", header: "Load", kind: "ref" },
    { key: "deliveredOn", header: "Delivered", kind: "date" },
    { key: "customer", header: "Customer", kind: "ref" },
    { key: "driver", header: "Driver", kind: "ref" },
    { key: "revenueCents", header: "Revenue", kind: "cents" },
    { key: "driverPayCents", header: "Driver pay", kind: "cents" },
    { key: "marginCents", header: "Margin", kind: "cents" },
    { key: "marginBps", header: "Margin %", kind: "pct" },
    { key: "note", header: "Note", kind: "text" },
  ],
  ifta_quarter: [
    { key: "state", header: "State", kind: "text" },
    { key: "miles", header: "Miles", kind: "int" },
    { key: "taxPaidGallonsMilli", header: "Tax-paid gallons", kind: "milli" },
    { key: "taxableGallonsMilli", header: "Taxable gallons", kind: "milli" },
    { key: "netGallonsMilli", header: "Net gallons", kind: "milli" },
    { key: "sampleRate", header: "SAMPLE rate per gallon", kind: "text" },
    { key: "taxDueCents", header: "Tax due at SAMPLE rates", kind: "cents" },
  ],
  year_end_contractors: [
    { key: "driver", header: "Contractor", kind: "ref" },
    { key: "workerType", header: "Type", kind: "text" },
    { key: "settlementsPaid", header: "Settlements paid", kind: "int" },
    { key: "compensationCents", header: "Nonemployee compensation", kind: "cents" },
    { key: "reimbursementsCents", header: "Reimbursements (not counted)", kind: "cents" },
    { key: "meetsThreshold", header: "Meets 1099-NEC threshold", kind: "text" },
    { key: "firstPaidOn", header: "First paid", kind: "date" },
    { key: "lastPaidOn", header: "Last paid", kind: "date" },
  ],
};

// What an empty report says, in plain words.
export const EMPTY_TEXT: Readonly<Record<EmptyReason, { title: string; body: string }>> = {
  no_pay_run: {
    title: "No pay run for this week yet",
    body: "Build the pay run for this week first.",
  },
  no_rows: { title: "Nothing to show", body: "No records match this report." },
};

// Rows a tool result or the chat table carries; the download has every row.
export const REPORT_ROW_CAP = 50;

// The same result with at most `cap` rows, saying when rows were left out.
export function capRows(result: ReportResult, cap: number = REPORT_ROW_CAP): ReportResult {
  if (result.rows.length <= cap) return result;
  return { ...result, rows: result.rows.slice(0, cap), truncated: true };
}

export function isRefCell(value: unknown): value is RefCell {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.table === "string" && typeof v.id === "string" && typeof v.label === "string";
}

// The download route serves CSV (every row) or JSON (the chat's table, capped like a tool result).
export const REPORT_FORMATS = ["csv", "json"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

// The route path for a report: the same args, as a query string, in a fixed order.
export function reportPath(name: ReportName, args: Record<string, string>, format: ReportFormat): string {
  const params = new URLSearchParams({ format });
  for (const key of Object.keys(args).sort()) {
    if (key !== "format") params.set(key, args[key]);
  }
  return `/api/reports/${name}?${params.toString()}`;
}

// A report path is a file from the download route, not a page: link to it with a plain <a>, never
// the router's Link. The router prefetches a Link and adds its own query key to the request, which
// the route's strict args refuse with a 400.
export function isReportPath(href: string): boolean {
  return href.startsWith("/api/reports/");
}
