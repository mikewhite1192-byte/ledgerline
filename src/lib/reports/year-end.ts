import { formatCents } from "../format/money";
import { sum, type DriverRecord, type SettlementRecord } from "../rules-engine";
import { localDateOf, type Instant, type LocalDate } from "../time/local-date";
import { MAX_REPORT_YEAR, MIN_REPORT_YEAR } from "./args";
import { argsOf, byId, byLargest, driverCell, mustGet, reportOf, WORKER_WORDS } from "./build";
import type { ReportResult, ReportRow } from "./types";

// The year-end 1099 totals (design-year-end 3): per contractor driver, the pay on settlements
// marked paid in one calendar year, by the date each was paid in the carrier's time zone. It reads
// the ledger and never recomputes pay: compensation is the load pay and accessorial pay lines as
// stored, reimbursements are shown apart and not counted. Nothing is filed and no form is made.

// The 1099-NEC reporting threshold for payments made in a year, in cents. Confirm for the tax
// year: $600 for payments through 2025; $2,000 for payments made in 2026 (Public Law 119-21,
// section 70433), indexed for inflation from 2027, so a later year is not known here and its
// contractors are not classified.
export const NEC_THRESHOLDS: readonly { throughYear: number; cents: number }[] = [
  { throughYear: 2025, cents: 60_000 },
  { throughYear: 2026, cents: 200_000 },
];

function assertReportYear(year: number): number {
  if (!Number.isSafeInteger(year) || year < MIN_REPORT_YEAR || year > MAX_REPORT_YEAR) {
    throw new RangeError("the year must be 2000 to 2100");
  }
  return year;
}

// The threshold in a table for a year: the entry with the earliest throughYear on or after it,
// whatever order the table is in. The table is read and never sorted.
export function thresholdCentsIn(table: readonly (typeof NEC_THRESHOLDS)[number][], year: number): number | null {
  let pick: (typeof NEC_THRESHOLDS)[number] | undefined;
  for (const t of table) {
    if (year <= t.throughYear && (pick === undefined || t.throughYear < pick.throughYear)) pick = t;
  }
  return pick?.cents ?? null;
}

export function necThresholdCents(year: number): number | null {
  if (!Number.isSafeInteger(year)) throw new RangeError("the year is not a whole number");
  return thresholdCentsIn(NEC_THRESHOLDS, year);
}

// The instants a carrier-local calendar year can fall in, a day either side so any time zone is
// covered (offsets run from 12 hours behind UTC to 14 ahead). The report keeps only the
// settlements paid on a local date inside the year, so the extra days never reach a total.
export function yearEndWindow(year: number): { start: Instant; end: Instant } {
  assertReportYear(year);
  return { start: `${year - 1}-12-31T00:00:00.000Z`, end: `${year + 1}-01-02T00:00:00.000Z` };
}

export type YearEndLine = { settlementId: string; kind: string; amountCents: number };

export type YearEndInput = {
  settlements: readonly SettlementRecord[];
  lines: readonly YearEndLine[];
  drivers: readonly DriverRecord[];
};

const COMPENSATION_KINDS: readonly string[] = ["load_pay", "accessorial_pay"];

const count = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

type Totals = { settlements: number; compensation: number[]; reimbursements: number[]; paidOn: LocalDate[] };

function thresholdNote(year: string, thresholdCents: number | null, meeting: number, rows: number): string {
  const listed = count(rows, "contractor", "contractors");
  if (thresholdCents === null) {
    return (
      `1099-NEC threshold for payments made in ${year}: not known to this report (confirm for the tax ` +
      `year), so ${listed} ${rows === 1 ? "was" : "were"} not classified.`
    );
  }
  return (
    `1099-NEC threshold for payments made in ${year}: ${formatCents(thresholdCents)} (confirm for the tax ` +
    `year). ${meeting} of ${listed} ${meeting === 1 ? "meets" : "meet"} it.`
  );
}

export function computeYearEnd1099(
  input: YearEndInput,
  args: { year: string; driverId?: string },
  today: LocalDate,
  timeZone: string,
): ReportResult {
  const { year } = args;
  if (!/^\d{4}$/.test(year)) throw new RangeError("the year is not four digits");
  const thresholdCents = necThresholdCents(assertReportYear(Number(year)));
  const drivers = byId(input.drivers, "drivers");
  // Each settlement kept for the year, to the driver it pays.
  const kept = new Map<string, string>();
  const byDriver = new Map<string, Totals>();
  for (const s of input.settlements) {
    if (s.status !== "paid") continue;
    if (s.paidAt === null) throw new Error("a paid settlement has no paid time");
    const paidOn = localDateOf(s.paidAt, timeZone);
    if (paidOn.slice(0, 4) !== year) continue;
    const driver = mustGet(drivers, s.driverId, "driver");
    if (driver.workerType !== "owner_operator") continue;
    if (args.driverId !== undefined && driver.id !== args.driverId) continue;
    if (kept.has(s.id)) throw new Error("two settlements share an id");
    kept.set(s.id, driver.id);
    const t = byDriver.get(driver.id) ?? { settlements: 0, compensation: [], reimbursements: [], paidOn: [] };
    t.settlements += 1;
    t.paidOn.push(paidOn);
    byDriver.set(driver.id, t);
  }
  for (const line of input.lines) {
    const driverId = kept.get(line.settlementId);
    if (driverId === undefined) continue;
    const t = mustGet(byDriver, driverId, "driver");
    // A negative earning line (a pay correction) is counted as stored: it is what was paid.
    if (COMPENSATION_KINDS.includes(line.kind)) t.compensation.push(line.amountCents);
    else if (line.kind === "reimbursement") t.reimbursements.push(line.amountCents);
  }
  const rows: ReportRow[] = [...byDriver].map(([driverId, t]) => {
    const driver = mustGet(drivers, driverId, "driver");
    const compensationCents = sum(t.compensation);
    const paidOn = [...t.paidOn].sort();
    return {
      driver: driverCell(driver),
      workerType: WORKER_WORDS[driver.workerType],
      settlementsPaid: t.settlements,
      compensationCents,
      reimbursementsCents: sum(t.reimbursements),
      meetsThreshold: thresholdCents === null ? "unknown" : compensationCents >= thresholdCents ? "yes" : "no",
      firstPaidOn: paidOn[0],
      lastPaidOn: paidOn[paidOn.length - 1],
    };
  });
  rows.sort(byLargest("compensationCents", "driver"));
  const totals: Record<string, number> = {
    settlementsPaid: sum(rows.map((r) => r.settlementsPaid as number)),
    compensationCents: sum(rows.map((r) => r.compensationCents as number)),
    reimbursementsCents: sum(rows.map((r) => r.reimbursementsCents as number)),
  };
  const meeting = rows.filter((r) => r.meetsThreshold === "yes").length;
  const definition =
    "Nonemployee compensation = load pay + accessorial pay on settlements marked paid, counted by the " +
    `date each was paid in the carrier's time zone (${timeZone}). Reimbursements are shown apart and ` +
    "not counted. Company drivers are not listed.";
  const notFiling = "Not a filing: no form is made or sent, and the app holds no tax id or address for any driver.";
  // An empty result keeps the definition, so an empty list never reads as a driver paid nothing.
  const notes =
    rows.length === 0
      ? [definition, notFiling]
      : [
          definition,
          thresholdNote(year, thresholdCents, meeting, rows.length),
          notFiling,
          ...(year === today.slice(0, 4) ? [`${year} is not over: the totals run through ${today}.`] : []),
        ];
  const result = reportOf("year_end_contractors", {
    asOf: today,
    args: argsOf({ year, driverId: args.driverId }),
    period: { start: `${year}-01-01`, end: `${year}-12-31` },
    rows,
    totals,
    notes,
  });
  // A tool result loses rows from the end, so the threshold and the counts also ride whole at the
  // top level, the threshold under a cents key the agent's figure check reads.
  return {
    ...result,
    form1099: {
      taxYear: Number(year),
      thresholdCents,
      meeting: thresholdCents === null ? null : meeting,
      unclassified: thresholdCents === null ? rows.length : 0,
    },
  };
}
