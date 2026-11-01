import {
  deficitOwedCents,
  isDelivered,
  outstandingCents,
  scheduleActive,
  sub,
  type AdvanceRecord,
  type DeficitRecord,
  type LoadRecord,
  type PayItemRecord,
  type Period,
  type ScheduleRecord,
  type SourceRef,
} from "../rules-engine";
import { sourceKey } from "./hash";

// The pre-pay reconcile (pure, no reads, no clock). Before a draft is approved, alone or in a
// batch, the stored paystub is compared whole with a fresh run of the engine, and every record its
// lines cite is checked as it stands now. Any difference parks the draft: it is never paid on
// numbers nobody re-checked. Only "Run the week" clears a park, by recomputing the draft.

export const MISMATCH_CATEGORIES = [
  "line_amount_changed",
  "line_missing",
  "line_added",
  "line_sources_changed",
  "total_changed",
] as const;
export type MismatchCategory = (typeof MISMATCH_CATEGORIES)[number];

export const SOURCE_PROBLEMS = [
  "source_missing",
  "source_settled_elsewhere",
  "source_changed",
  "advance_overrecovered",
  "schedule_inactive",
  "deficit_overrecovered",
] as const;
export type SourceProblemCategory = (typeof SOURCE_PROBLEMS)[number];

export const PARK_REASONS = [...MISMATCH_CATEGORIES, ...SOURCE_PROBLEMS] as const;
export type ParkReason = (typeof PARK_REASONS)[number];

export function isParkReason(value: unknown): value is ParkReason {
  return typeof value === "string" && (PARK_REASONS as readonly string[]).includes(value);
}

export type ReconcileLine = {
  kind: string;
  label: string;
  amountCents: number;
  sources: readonly SourceRef[];
};

export type ReconcileTotals = {
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  carryForwardCents: number;
};

export type Mismatch = {
  category: MismatchCategory;
  kind?: string;
  field?: keyof ReconcileTotals;
  storedCents?: number;
  freshCents?: number;
  sources: SourceRef[];
};

export type ReconcileResult = { ok: true } | { ok: false; mismatches: Mismatch[] };

const TOTALS: readonly (keyof ReconcileTotals)[] = [
  "grossCents",
  "deductionsCents",
  "netCents",
  "carryForwardCents",
];

const pairKey = (l: ReconcileLine) => `${l.kind}|${sourceKey(l.sources)}`;

function groupByKey(lines: readonly ReconcileLine[]): Map<string, ReconcileLine[]> {
  const out = new Map<string, ReconcileLine[]>();
  for (const l of lines) {
    const k = pairKey(l);
    out.set(k, [...(out.get(k) ?? []), l]);
  }
  return out;
}

const byAmount = (a: ReconcileLine, b: ReconcileLine) => a.amountCents - b.amountCents;

// Lines pair by kind and their whole, sorted list of sources, never by seq, so a reorder is not a
// mismatch and every other change is. Line mismatches come first (the first one names the park),
// then each total that differs.
export function reconcileSettlement(
  stored: ReconcileTotals & { lines: readonly ReconcileLine[] },
  fresh: ReconcileTotals & { lines: readonly ReconcileLine[] },
): ReconcileResult {
  const mismatches: Mismatch[] = [];
  const storedByKey = groupByKey(stored.lines);
  const freshByKey = groupByKey(fresh.lines);
  const missing: ReconcileLine[] = [];
  const added: ReconcileLine[] = [];
  const keys = [...new Set([...storedByKey.keys(), ...freshByKey.keys()])].sort();
  for (const k of keys) {
    const s = [...(storedByKey.get(k) ?? [])].sort(byAmount);
    const f = [...(freshByKey.get(k) ?? [])].sort(byAmount);
    const n = Math.min(s.length, f.length);
    for (let i = 0; i < n; i += 1) {
      if (s[i].amountCents !== f[i].amountCents) {
        mismatches.push({
          category: "line_amount_changed",
          kind: s[i].kind,
          storedCents: s[i].amountCents,
          freshCents: f[i].amountCents,
          sources: [...s[i].sources],
        });
      }
    }
    missing.push(...s.slice(n));
    added.push(...f.slice(n));
  }
  // A line of the same kind and label whose cited records changed is one mismatch, not two.
  const unpairedAdded = [...added];
  for (const m of missing) {
    const i = unpairedAdded.findIndex((a) => a.kind === m.kind && a.label === m.label);
    if (i >= 0) {
      const [a] = unpairedAdded.splice(i, 1);
      mismatches.push({
        category: "line_sources_changed",
        kind: m.kind,
        storedCents: m.amountCents,
        freshCents: a.amountCents,
        sources: [...m.sources, ...a.sources],
      });
    } else {
      mismatches.push({
        category: "line_missing",
        kind: m.kind,
        storedCents: m.amountCents,
        sources: [...m.sources],
      });
    }
  }
  for (const a of unpairedAdded) {
    mismatches.push({ category: "line_added", kind: a.kind, freshCents: a.amountCents, sources: [...a.sources] });
  }
  for (const field of TOTALS) {
    if (stored[field] !== fresh[field]) {
      mismatches.push({
        category: "total_changed",
        field,
        storedCents: stored[field],
        freshCents: fresh[field],
        sources: [],
      });
    }
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}

// One cited record as it stands now, mapped to the engine's record; null when it is gone.
export type SourceRow =
  | { table: "loads"; record: LoadRecord }
  | { table: "pay_items"; record: PayItemRecord }
  | { table: "advances"; record: AdvanceRecord }
  | { table: "deduction_schedules"; record: ScheduleRecord }
  | { table: "driver_deficits"; record: DeficitRecord }
  | { table: "other" };

// Keyed `${table}:${id}`. The server fills it for every cited record; a key it lacks counts as
// missing (unknown is not zero).
export type SourceRows = ReadonlyMap<string, SourceRow | null>;

export type SourceProblem = { category: SourceProblemCategory; source: SourceRef };

export const rowKey = (s: SourceRef) => `${s.table}:${s.id.toLowerCase()}`;

const inPeriod = (date: string | null, period: Period) =>
  date !== null && date >= period.start && date <= period.end;

// Every record the lines cite, checked as it stands now. One problem per record and category, in
// line order.
export function checkLineSources(
  lines: readonly ReconcileLine[],
  settlementId: string,
  period: Period,
  rows: SourceRows,
): SourceProblem[] {
  const problems: SourceProblem[] = [];
  const seen = new Set<string>();
  const add = (category: SourceProblemCategory, source: SourceRef) => {
    const k = `${category}|${rowKey(source)}`;
    if (seen.has(k)) return;
    seen.add(k);
    problems.push({ category, source: { table: source.table, id: source.id } });
  };
  // What the lines take from each advance and each deficit, so two lines on one record are checked
  // together.
  const taken = new Map<string, number>();
  for (const l of lines) {
    const table = l.kind === "advance_recovery" ? "advances" : l.kind === "deficit_recovery" ? "driver_deficits" : null;
    if (table === null) continue;
    for (const s of l.sources) {
      if (s.table !== table) continue;
      taken.set(rowKey(s), (taken.get(rowKey(s)) ?? 0) + sub(0, l.amountCents));
    }
  }
  for (const l of lines) {
    for (const s of l.sources) {
      const row = rows.get(rowKey(s)) ?? null;
      if (row === null) {
        add("source_missing", s);
        continue;
      }
      if (row.table === "pay_items") {
        const other = row.record.settlementId;
        if (other !== null && other.toLowerCase() !== settlementId.toLowerCase()) {
          add("source_settled_elsewhere", s);
        }
      } else if (row.table === "loads") {
        if (!isDelivered(row.record) || !inPeriod(row.record.deliveredOn, period)) add("source_changed", s);
      } else if (row.table === "advances") {
        const take = taken.get(rowKey(s)) ?? 0;
        if (row.record.status !== "paid" || outstandingCents(row.record) < take) {
          add("advance_overrecovered", s);
        }
      } else if (row.table === "deduction_schedules") {
        if (!scheduleActive(row.record, period)) add("schedule_inactive", s);
      } else if (row.table === "driver_deficits") {
        if (deficitOwedCents(row.record) < (taken.get(rowKey(s)) ?? 0)) add("deficit_overrecovered", s);
      }
    }
  }
  return problems;
}

// The first reason a draft is parked, or null when it may be paid.
export function parkReasonOf(
  reconcile: ReconcileResult,
  problems: readonly SourceProblem[],
): ParkReason | null {
  if (!reconcile.ok) return reconcile.mismatches[0].category;
  return problems[0]?.category ?? null;
}
