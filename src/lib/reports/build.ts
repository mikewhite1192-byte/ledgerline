import { compareText, mul, roundHalfUp, type DriverRecord, type SettlementPeriodRecord } from "../rules-engine";
import {
  REPORT_COLUMNS,
  REPORT_TITLES,
  type EmptyReason,
  type RefCell,
  type ReportName,
  type ReportResult,
  type ReportRow,
  type ReportSubtotal,
} from "./types";

// Pieces every report shares: the result shape, record labels, fixed words and the one ratio.

export function reportOf(
  name: ReportName,
  parts: {
    asOf: string;
    args: Record<string, string>;
    rows: ReportRow[];
    period?: { start: string; end: string };
    totals?: Record<string, number>;
    subtotals?: ReportSubtotal[];
    emptyReason?: EmptyReason;
  },
): ReportResult {
  const { rows } = parts;
  return {
    report: name,
    title: REPORT_TITLES[name],
    asOf: parts.asOf,
    args: { ...parts.args },
    ...(parts.period ? { period: { ...parts.period } } : {}),
    columns: REPORT_COLUMNS[name].map((c) => ({ ...c })),
    rows,
    ...(parts.totals && rows.length > 0 ? { totals: parts.totals } : {}),
    ...(parts.subtotals && rows.length > 0 ? { subtotals: parts.subtotals } : {}),
    truncated: false,
    rowsTotal: rows.length,
    ...(rows.length === 0 ? { emptyReason: parts.emptyReason ?? "no_rows" } : {}),
  };
}

// The args a result records: the ones that have a value.
export function argsOf(parts: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parts)) if (v !== undefined) out[k] = v;
  return out;
}

export function driverCell(driver: DriverRecord): RefCell {
  return {
    table: "drivers",
    id: driver.id,
    label: `${driver.firstName} ${driver.lastName} (${driver.code})`,
  };
}

export function labelOf(cell: unknown): string {
  return cell && typeof cell === "object" && "label" in cell ? String(cell.label) : "";
}

// Rows by the named cents column, largest first, then by the first column's label.
export function byLargest(key: string, first: string) {
  return (a: ReportRow, b: ReportRow): number =>
    Number(b[key] ?? 0) - Number(a[key] ?? 0) || compareText(labelOf(a[first]), labelOf(b[first]));
}

export const WORKER_WORDS: Readonly<Record<DriverRecord["workerType"], string>> = {
  company: "Company driver",
  owner_operator: "Owner-operator",
};

export const SETTLEMENT_WORDS: Readonly<Record<"draft" | "approved" | "paid", string>> = {
  draft: "Draft",
  approved: "Approved",
  paid: "Paid",
};

// part / whole in basis points, rounded half away from zero, on integers only. Null when the
// whole is not positive.
export function ratioBps(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  const magnitude = roundHalfUp(mul(Math.abs(part), 10_000, "part x 10000"), whole);
  return part < 0 ? -magnitude : magnitude;
}

// The pay week that holds a carrier-local day (start to end inclusive), or null when no week
// does. Two weeks holding the same day is refused, never guessed between.
export function periodHolding(
  periods: readonly SettlementPeriodRecord[],
  day: string,
): SettlementPeriodRecord | null {
  const found = periods.filter((p) => p.periodStart <= day && day <= p.periodEnd);
  if (found.length > 1) throw new Error("two pay weeks hold the same day");
  return found[0] ?? null;
}

// Records by id, refusing a list that names one id twice.
export function byId<T extends { id: string }>(list: readonly T[], what: string): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of list) {
    if (out.has(item.id)) throw new Error(`two ${what} share an id`);
    out.set(item.id, item);
  }
  return out;
}

// The record an id names, or a refusal: a report never shows a row it cannot label.
export function mustGet<T>(map: Map<string, T>, id: string, what: string): T {
  const found = map.get(id);
  if (found === undefined) throw new Error(`a row names a ${what} that is not on file`);
  return found;
}
