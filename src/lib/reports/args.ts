import { z } from "zod";
import { daysBetween, isLocalDate } from "../time/local-date";
import { isReportName, REPORT_FORMATS, type ReportFormat, type ReportName } from "./types";

// The typed args of each report: one strict schema per report, used by the gateway tool (the
// model's args) and the download route (the query string) alike. Dates are YYYY-MM-DD in the
// carrier's time zone; ids are uuids, lowercased.

export const MAX_MARGIN_DAYS = 92;
// The driver insights window: at most a year and a day (366 days, so a leap year fits).
export const MAX_INSIGHT_DAYS = 366;
export const INSIGHT_WINDOW_RULE = "the window must run forward and cover at most 366 days";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateArg = () => z.string().regex(DATE).refine(isLocalDate, { message: "not a calendar date" });
const idArg = () => z.uuid().toLowerCase();

export const MIN_REPORT_YEAR = 2000;
export const MAX_REPORT_YEAR = 2100;

// A calendar year as four digits, like every other report arg a string (the query string and the
// model's args alike).
const yearArg = () =>
  z
    .string()
    .regex(/^\d{4}$/)
    .refine((y) => Number(y) >= MIN_REPORT_YEAR && Number(y) <= MAX_REPORT_YEAR, {
      message: "the year must be 2000 to 2100",
    });

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

// Either end may be left out (the report fills the 28 days ending today); when both are given the
// window must run forward and cover at most 366 days. A one-sided window is checked by the report
// against today in the carrier's zone, which refuses a bad one with ReportArgsError.
const insightArgs = z
  .strictObject({ from: dateArg().optional(), to: dateArg().optional() })
  .refine(
    (a) => {
      if (a.from === undefined || a.to === undefined) return true;
      // A bad date is already reported on its own field.
      if (!isLocalDate(a.from) || !isLocalDate(a.to)) return true;
      const days = daysBetween(a.from, a.to);
      return days >= 0 && days < MAX_INSIGHT_DAYS;
    },
    { message: INSIGHT_WINDOW_RULE, path: ["to"] },
  );

// Args the schema let through that a report refuses once it knows today in the carrier's zone (a
// lone driver insights `from` after today or 366 days or more before it). Thrown before any read;
// the tool answers it as invalid args and the route as a bad request, the way the schema's own
// refusal is answered. A RangeError, so any other caller still reads it as one.
export class ReportArgsError extends RangeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "ReportArgsError";
    this.path = path;
  }
}

export const REPORT_ARGS = {
  ar_aging: z.strictObject({ asOf: dateArg().optional() }),
  driver_pay_summary: z.strictObject({
    periodStart: dateArg().optional(),
    driverId: idArg().optional(),
  }),
  advances_outstanding: z.strictObject({ asOf: dateArg().optional() }),
  cash_needed: z.strictObject({ periodStart: dateArg().optional() }),
  margin_per_load: marginArgs,
  // Any date inside the quarter wanted; default today in the carrier's time zone.
  ifta_quarter: z.strictObject({ asOf: dateArg().optional() }),
  // The calendar year the settlements were paid in; default this year in the carrier's time zone.
  year_end_contractors: z.strictObject({ year: yearArg().optional(), driverId: idArg().optional() }),
  // Any date inside the last pay week wanted; default today in the carrier's time zone.
  trust_meter: z.strictObject({ asOf: dateArg().optional() }),
  // The window of paid paystubs and delivered loads; default the 28 days ending today.
  driver_insights: insightArgs,
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
