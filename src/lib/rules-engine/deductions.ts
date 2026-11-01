import { isWithin } from "../time/local-date";
import { insuranceApplies } from "./config";
import type { LineDraft } from "./load-pay";
import { assertCents, cents, mul, sub } from "./money";
import {
  assertDate,
  assertId,
  assertOneOf,
  compareText,
  DAY_SOURCES,
  InputError,
  PAY_ITEM_KINDS,
  SCHEDULE_KINDS,
  type Cents,
  type DriverDayRecord,
  type DriverRecord,
  type PayConfig,
  type PayItemRecord,
  type PayItemKind,
  type Period,
  type ScheduleKind,
  type ScheduleRecord,
  type SettlementNote,
} from "./types";

// Steps 2, 4 and 6 of the pay math: reimbursements, the hard deductions that are always taken,
// and escrow, the first of the two discretionary deductions the net pay floor can limit.

export function checkDay(day: DriverDayRecord, driverId?: string): DriverDayRecord {
  const id = assertId(day?.id, "driver day id");
  if (driverId !== undefined && day.driverId !== driverId) {
    throw new InputError(`driver day ${id} is not this driver's`);
  }
  assertId(day.driverId, `driver day ${id} driverId`);
  assertDate(day.day, `driver day ${id} day`);
  assertOneOf(day.source, DAY_SOURCES, `driver day ${id} source`);
  return day;
}

export function checkItem(item: PayItemRecord, driverId?: string): PayItemRecord {
  const id = assertId(item?.id, "pay item id");
  if (driverId !== undefined && item.driverId !== driverId) {
    throw new InputError(`pay item ${id} is not this driver's`);
  }
  assertId(item.driverId, `pay item ${id} driverId`);
  assertOneOf(item.kind, PAY_ITEM_KINDS, `pay item ${id} kind`);
  if (assertCents(item.amountCents, `pay item ${id} amountCents`) === 0) {
    throw new InputError(`pay item ${id} amountCents is zero`);
  }
  assertDate(item.itemDate, `pay item ${id} itemDate`);
  return item;
}

export function checkSchedule(schedule: ScheduleRecord, driverId?: string): ScheduleRecord {
  const id = assertId(schedule?.id, "schedule id");
  if (driverId !== undefined && schedule.driverId !== driverId) {
    throw new InputError(`schedule ${id} is not this driver's`);
  }
  assertId(schedule.driverId, `schedule ${id} driverId`);
  assertOneOf(schedule.kind, SCHEDULE_KINDS, `schedule ${id} kind`);
  assertCents(schedule.amountCents, `schedule ${id} amountCents`);
  if (schedule.targetCents !== null)
    assertCents(schedule.targetCents, `schedule ${id} targetCents`);
  assertDate(schedule.activeFrom, `schedule ${id} activeFrom`);
  if (schedule.activeTo !== null) assertDate(schedule.activeTo, `schedule ${id} activeTo`);
  return schedule;
}

export function scheduleActive(schedule: ScheduleRecord, period: Period): boolean {
  return (
    schedule.activeFrom <= period.end &&
    (schedule.activeTo === null || schedule.activeTo >= period.start)
  );
}

function bySchedule(a: ScheduleRecord, b: ScheduleRecord): number {
  return compareText(a.activeFrom, b.activeFrom) || compareText(a.id, b.id);
}

// The one lease or escrow schedule active in the period. Two at once is ambiguous (a lease that
// changed mid-week would charge twice), so it refuses rather than pick one.
export function activeSchedule(
  schedules: readonly ScheduleRecord[],
  kind: Exclude<ScheduleKind, "other">,
  period: Period,
): ScheduleRecord | null {
  const active = schedules.filter((s) => s.kind === kind && scheduleActive(s, period));
  if (active.length > 1) throw new InputError(`more than one ${kind} schedule is active`);
  return active[0] ?? null;
}

const ITEM_LINES: Record<PayItemKind, { label: string; sign: 1 | -1 }> = {
  reimbursement: { label: "Reimbursement", sign: 1 },
  fuel: { label: "Fuel, company card", sign: -1 },
  other_deduction: { label: "Deduction", sign: -1 },
  carried_shortfall: { label: "Shortfall carried from last week", sign: -1 },
};

function byItem(a: PayItemRecord, b: PayItemRecord): number {
  return (
    compareText(a.itemDate, b.itemDate) ||
    compareText(a.itemRef, b.itemRef) ||
    compareText(a.id, b.id)
  );
}

// One line per pay item of this kind dated in the period. The kind gives the sign. An item a person
// typed carries their name and its record onto the line (0084).
export function itemLines(
  items: readonly PayItemRecord[],
  kind: PayItemKind,
  period: Period,
): LineDraft[] {
  const { label, sign } = ITEM_LINES[kind];
  return items
    .filter((i) => i.kind === kind && isWithin(i.itemDate, period))
    .sort(byItem)
    .map((i) => ({
      kind,
      label: i.subkind ? `${label} (${i.subkind})` : label,
      amountCents: sign === 1 ? i.amountCents : sub(0, i.amountCents),
      sources: [{ table: "pay_items", id: i.id }],
      ...(i.enteredBy
        ? {
            enteredBy: i.enteredBy,
            sourceRef: i.refTable && i.refId ? `${i.refTable}:${i.refId}` : null,
          }
        : {}),
    }));
}

// Distinct days driven in the period times the per-day rate, for the drivers the tenant charges.
// Days are distinct rows, and the count is of distinct dates, so a day is charged once. The line
// cites every day row it counted.
export function insuranceLine(
  config: PayConfig,
  driver: DriverRecord,
  days: readonly DriverDayRecord[],
  period: Period,
): { line: LineDraft | null; insuredDays: number } {
  if (!insuranceApplies(config, driver)) return { line: null, insuredDays: 0 };
  const rows = days
    .filter((d) => isWithin(d.day, period))
    .sort((a, b) => compareText(a.day, b.day) || compareText(a.id, b.id));
  const insuredDays = new Set(rows.map((d) => d.day)).size;
  const amount = mul(insuredDays, config.insurancePerDayCents, "days x insurance rate");
  if (amount === 0) return { line: null, insuredDays };
  return {
    line: {
      kind: "insurance",
      label: `Insurance, ${insuredDays} ${insuredDays === 1 ? "day" : "days"}`,
      amountCents: sub(0, amount),
      sources: rows.map((d) => ({ table: "driver_days", id: d.id })),
      meta: { days: insuredDays, perDayCents: config.insurancePerDayCents },
    },
    insuredDays,
  };
}

export function leaseLine(schedules: readonly ScheduleRecord[], period: Period): LineDraft | null {
  const lease = activeSchedule(schedules, "lease", period);
  if (!lease || lease.amountCents === 0) return null;
  return {
    kind: "lease",
    label: "Truck lease",
    amountCents: sub(0, lease.amountCents),
    sources: [{ table: "deduction_schedules", id: lease.id }],
  };
}

function otherScheduleLines(schedules: readonly ScheduleRecord[], period: Period): LineDraft[] {
  return schedules
    .filter((s) => s.kind === "other" && s.amountCents > 0 && scheduleActive(s, period))
    .sort(bySchedule)
    .map((s) => ({
      kind: "other_deduction",
      label: "Scheduled deduction",
      amountCents: sub(0, s.amountCents),
      sources: [{ table: "deduction_schedules", id: s.id }],
    }));
}

// Step 4, in paystub order: company-card fuel, other deductions, last period's shortfall, the
// lease, any other scheduled deduction, insurance. Always taken, even past gross.
export function hardDeductionLines(
  config: PayConfig,
  driver: DriverRecord,
  period: Period,
  items: readonly PayItemRecord[],
  schedules: readonly ScheduleRecord[],
  days: readonly DriverDayRecord[],
): { lines: LineDraft[]; insuredDays: number } {
  const insurance = insuranceLine(config, driver, days, period);
  const lease = leaseLine(schedules, period);
  const lines = [
    ...itemLines(items, "fuel", period),
    ...itemLines(items, "other_deduction", period),
    ...itemLines(items, "carried_shortfall", period),
    ...(lease ? [lease] : []),
    ...otherScheduleLines(schedules, period),
    ...(insurance.line ? [insurance.line] : []),
  ];
  return { lines, insuredDays: insurance.insuredDays };
}

// Step 6. With an active escrow schedule and the balance under target, take
// min(scheduled, target - balance, max(0, afterHard - floor)). Anything less than scheduled
// leaves a note saying which limit applied.
export function escrowLine(
  config: PayConfig,
  schedules: readonly ScheduleRecord[],
  period: Period,
  balanceCents: Cents,
  afterHardCents: Cents,
): { line: LineDraft | null; note: SettlementNote | null; deltaCents: Cents } {
  const none = { line: null, note: null, deltaCents: cents(0) };
  const schedule = activeSchedule(schedules, "escrow", period);
  if (!schedule || schedule.amountCents === 0) return none;
  const sources = [{ table: "deduction_schedules" as const, id: schedule.id }];
  const target = schedule.targetCents ?? config.escrowTargetCents;
  const toTarget = Math.max(0, sub(target, balanceCents));
  const room = Math.max(0, sub(afterHardCents, config.netPayFloorCents));
  const taken = cents(Math.min(schedule.amountCents, toTarget, room));
  const note: SettlementNote | null =
    taken < schedule.amountCents
      ? {
          kind: "escrow",
          category: toTarget <= room ? "at_target" : "floor",
          sources,
          amountCents: sub(schedule.amountCents, taken),
        }
      : null;
  if (taken === 0) return { line: null, note, deltaCents: cents(0) };
  return {
    line: {
      kind: "escrow",
      label: "Escrow",
      amountCents: sub(0, taken),
      sources,
      meta: { balanceBeforeCents: balanceCents, targetCents: target },
    },
    note,
    deltaCents: taken,
  };
}
