import { z } from "zod";
import { daysBetween, isLocalDate } from "../time/local-date";
import { isReportName, REPORT_FORMATS, type ReportFormat, type ReportName } from "./types";

// The typed args of each report: one strict schema per report, used by the gateway tool (the
// model's args) and the download route (the query string) alike. Dates are YYYY-MM-DD in the
// carrier's time zone; ids are uuids, lowercased.

export const MAX_MARGIN_DAYS = 92;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateArg = () => z.string().regex(DATE).refine(isLocalDate, { message: "not a calendar date" });
const idArg = () => z.uuid().toLowerCase();

const marginArgs = z
  .strictObject({ periodStart: dateArg(), periodEnd: dateArg(), customerId: idArg().optional() })
  .refine(
    (a) => {
      // A bad date is already reported on its own field.
      if (!isLocalDate(a.periodStart) || !isLocalDate(a.periodEnd)) return true;
      const days = daysBetween(a.periodStart, a.periodEnd);
      return days >= 0 && days < MAX_MARGIN_DAYS;
    },
    { message: "the window must run forward and cover at most 92 days", path: ["periodEnd"] },
  );

export const REPORT_ARGS = {
  ar_aging: z.strictObject({ asOf: dateArg().optional() }),
  driver_pay_summary: z.strictObject({
    periodStart: dateArg().optional(),
    driverId: idArg().optional(),
  }),
  advances_outstanding: z.strictObject({ asOf: dateArg().optional() }),
  cash_needed: z.strictObject({ periodStart: dateArg().optional() }),
  margin_per_load: marginArgs,
} as const satisfies Record<ReportName, z.ZodType>;

export type ReportArgs = { [K in ReportName]: z.infer<(typeof REPORT_ARGS)[K]> };

// One report and its parsed args.
export type ReportRequest = { [K in ReportName]: { name: K; args: ReportArgs[K] } }[ReportName];

export function parseReportArgs(name: ReportName, value: unknown): ReportRequest | null {
  const parsed = REPORT_ARGS[name].safeParse(value);
  return parsed.success ? ({ name, args: parsed.data } as ReportRequest) : null;
}

// Only the string values of parsed args: what a result records and a link carries.
export function argStrings(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) if (typeof v === "string") out[k] = v;
  return out;
}

export type ReportQuery = { request: ReportRequest; format: ReportFormat };

// The download route's query: a known report name, at most one value per key, an optional
// format (csv by default), and the report's own args. Anything else is refused whole.
export function parseReportQuery(name: unknown, params: URLSearchParams): ReportQuery | null {
  if (!isReportName(name)) return null;
  const values: Record<string, string> = {};
  let format: ReportFormat = "csv";
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === "format") {
      const f = REPORT_FORMATS.find((x) => x === value);
      if (!f) return null;
      format = f;
    } else {
      values[key] = value;
    }
  }
  const request = parseReportArgs(name, values);
  return request ? { request, format } : null;
}
