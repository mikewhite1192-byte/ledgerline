import { describe, expect, it } from "vitest";
import type { DeductionScheduleRow, PayConfigRow } from "../data/rows";
import { rowsFor, versionFrom } from "../pay-rules/__tests__/rows";
import { RULE_KEYS, valueOf, valueText, type RuleKey } from "../pay-rules/rules";
import {
  checkStart,
  chooseStart,
  escrowOnSchedules,
  needsAdmin,
  parseStoredValue,
  planVersion,
  type FieldPlan,
  type PlanRows,
} from "./plan";

// Where a version from a policy starts and what it changes, on the seed's two carriers at fixed
// instants. Oct 27, 2026 is a Tuesday: Blue Ridge (New York, Monday weeks) is in the week of Oct
// 26, Prairie Wind (Chicago, Sunday weeks) in the week of Oct 25. No database, no clock.

const TUESDAY = new Date("2026-10-27T15:00:00Z");
const NEW_ID = "77777777-7777-4777-8777-777777777777";

function planRows(slug: "blue-ridge" | "prairie-wind"): PlanRows {
  const r = rowsFor(slug);
  return {
    timezone: r.tenant.timezone,
    pay_configs: r.pay_configs,
    settlement_periods: r.settlement_periods,
    settlements: r.settlements,
    deduction_schedules: [...r.deduction_schedules],
  };
}

const newestOf = (rows: PlanRows): PayConfigRow =>
  [...rows.pay_configs].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];

// Every rule Not in document at the base's own value, then the given fields.
function fieldsOver(base: PayConfigRow, over: Partial<Record<RuleKey, FieldPlan>> = {}): Record<RuleKey, FieldPlan> {
  const out = {} as Record<RuleKey, FieldPlan>;
  for (const key of RULE_KEYS) out[key] = over[key] ?? { value: valueText(valueOf(base, key)), state: "not_in_document" };
  return out;
}

const placed = (p: ReturnType<typeof chooseStart>) => {
  if (!p.ok) throw new Error(`refused: ${p.reason}`);
  return p;
};

describe("the week a policy's version starts", () => {
  it("starts on the document's own date when it is a week start after this week", () => {
    const rows = planRows("blue-ridge");
    const p = placed(chooseStart(rows, "2026-11-02", TUESDAY));
    expect(p).toMatchObject({ effectiveFrom: "2026-11-02", askedFrom: "2026-11-02", moved: false });
    expect(p.base.id).toBe(newestOf(rows).id);
  });

  it("starts next week, asked from today, when the document names no date", () => {
    expect(placed(chooseStart(planRows("blue-ridge"), null, TUESDAY))).toMatchObject({
      effectiveFrom: "2026-11-02",
      askedFrom: "2026-10-27",
      moved: false,
    });
  });

  it("moves a date inside a week to the next week start, and says so", () => {
    expect(placed(chooseStart(planRows("blue-ridge"), "2026-11-04", TUESDAY))).toMatchObject({
      effectiveFrom: "2026-11-09",
      askedFrom: "2026-11-04",
      moved: true,
    });
  });

  it("moves a date in this week or the past to next week, asked from today", () => {
    for (const date of ["2026-10-26", "2026-10-01"]) {
      expect(placed(chooseStart(planRows("blue-ridge"), date, TUESDAY))).toMatchObject({
        effectiveFrom: "2026-11-02",
        askedFrom: "2026-10-27",
        moved: true,
      });
    }
  });

  it("follows the carrier's own week start and time zone", () => {
    const rows = planRows("prairie-wind");
    expect(placed(chooseStart(rows, null, TUESDAY))).toMatchObject({ effectiveFrom: "2026-11-01", moved: false });
    expect(placed(chooseStart(rows, "2026-11-02", TUESDAY))).toMatchObject({ effectiveFrom: "2026-11-08", moved: true });
  });

  it("starts after the newest saved version, and refuses a start before it", () => {
    const rows = planRows("blue-ridge");
    rows.pay_configs = [...rows.pay_configs, versionFrom(rowsFor("blue-ridge"), NEW_ID, "2026-11-09")];
    const p = placed(chooseStart(rows, "2026-11-02", TUESDAY));
    expect(p).toMatchObject({ effectiveFrom: "2026-11-16", moved: true });
    expect(p.base.id).toBe(NEW_ID);
    expect(checkStart(rows, "2026-11-02", null, TUESDAY)).toEqual({ ok: false, reason: "later_version" });
  });

  it("refuses a carrier with no pay rules", () => {
    const rows = { ...planRows("blue-ridge"), pay_configs: [] };
    expect(chooseStart(rows, null, TUESDAY)).toEqual({ ok: false, reason: "no_pay_config" });
    expect(checkStart(rows, "2026-11-02", null, TUESDAY)).toEqual({ ok: false, reason: "no_pay_config" });
  });
});

describe("the stored start, checked again", () => {
  const rows = planRows("blue-ridge");
  const base = newestOf(rows);

  it("passes the start and base the card stored", () => {
    expect(checkStart(rows, "2026-11-02", base.id, TUESDAY)).toEqual({ ok: true, base });
  });

  it("refuses a day that is not a week start, this week's start, the past and too far ahead", () => {
    expect(checkStart(rows, "2026-11-03", null, TUESDAY)).toEqual({ ok: false, reason: "stale" });
    expect(checkStart(rows, "2026-10-26", null, TUESDAY)).toEqual({ ok: false, reason: "effective_in_past" });
    expect(checkStart(rows, "2026-10-19", null, TUESDAY)).toEqual({ ok: false, reason: "effective_in_past" });
    expect(checkStart(rows, "2027-11-01", null, TUESDAY)).toEqual({ ok: false, reason: "too_far_ahead" });
    expect(checkStart(rows, "not-a-date", null, TUESDAY)).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses once the week the card named has begun", () => {
    expect(checkStart(rows, "2026-11-02", base.id, new Date("2026-11-02T15:00:00Z"))).toEqual({
      ok: false,
      reason: "effective_in_past",
    });
  });

  it("refuses a base that is no longer the version in force", () => {
    expect(checkStart(rows, "2026-11-02", NEW_ID, TUESDAY)).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a start with approved or paid pay on or after it", () => {
    const period = rows.settlement_periods[0];
    const paid = { ...period, id: NEW_ID, period_start: "2026-11-02", period_end: "2026-11-08", status: "paid" as const };
    const locked = { ...rows, settlement_periods: [...rows.settlement_periods, paid] };
    expect(checkStart(locked, "2026-11-02", base.id, TUESDAY)).toEqual({ ok: false, reason: "locked_version" });
  });
});

describe("the version a policy's fields make", () => {
  const base = newestOf(planRows("blue-ridge"));
  const floor = Number(valueOf(base, "net_pay_floor_cents"));
  const limit = Number(valueOf(base, "advance_limit_default_cents"));

  it("sets each Found value over the base and keeps every rule Not in document", () => {
    const plan = planVersion(
      base,
      fieldsOver(base, { net_pay_floor_cents: { value: String(floor + 5_000), state: "found" } }),
      {},
    );
    expect(plan).toMatchObject({ ok: true, adminRequired: false });
    if (!plan.ok) return;
    expect(plan.changes).toEqual([
      { key: "net_pay_floor_cents", oldValue: floor, newValue: floor + 5_000, edited: false },
    ]);
    expect(plan.knobs.net_pay_floor_cents).toBe(floor + 5_000);
  });

  it("needs a person's choice for a rule that Needs you, and takes their edit", () => {
    const fields = fieldsOver(base, { net_pay_floor_cents: { value: String(floor), state: "needs_you" } });
    expect(planVersion(base, fields, {})).toEqual({ ok: false, reason: "needs_choice" });
    const plan = planVersion(base, fields, { net_pay_floor_cents: String(floor + 100) });
    expect(plan.ok && plan.changes).toEqual([
      { key: "net_pay_floor_cents", oldValue: floor, newValue: floor + 100, edited: true },
    ]);
  });

  it("lets an edit replace a Found value or a rule Not in document", () => {
    const fields = fieldsOver(base, { net_pay_floor_cents: { value: String(floor + 5_000), state: "found" } });
    const plan = planVersion(base, fields, { net_pay_floor_cents: String(floor + 1), insurance_applies_to: "all" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.changes.find((c) => c.key === "net_pay_floor_cents")).toMatchObject({ newValue: floor + 1, edited: true });
  });

  it("refuses an edit to a key that is not a rule, or a value the rule's parser refuses", () => {
    const fields = fieldsOver(base, { net_pay_floor_cents: { value: String(floor + 5_000), state: "found" } });
    expect(planVersion(base, fields, { week_start_dow: "1" })).toEqual({ ok: false, reason: "bad_edit" });
    expect(planVersion(base, fields, { insurance_applies_to: "everyone" })).toEqual({ ok: false, reason: "bad_edit" });
    expect(planVersion(base, fields, { net_pay_floor_cents: "null" })).toEqual({ ok: false, reason: "bad_edit" });
  });

  it("refuses a stored Found value the rule's parser refuses", () => {
    const fields = fieldsOver(base, { insurance_applies_to: { value: "everyone", state: "found" } });
    expect(planVersion(base, fields, {})).toEqual({ ok: false, reason: "bad_value" });
  });

  it("refuses a version that changes nothing", () => {
    const same = fieldsOver(base, { net_pay_floor_cents: { value: String(floor), state: "found" } });
    expect(planVersion(base, same, {})).toEqual({ ok: false, reason: "no_change" });
  });

  it("needs an admin to raise the advance limit, and not to lower it", () => {
    const up = fieldsOver(base, { advance_limit_default_cents: { value: String(limit + 10_000), state: "found" } });
    expect(planVersion(base, up, {})).toMatchObject({ ok: true, adminRequired: true });
    const down = fieldsOver(base, { advance_limit_default_cents: { value: String(limit - 10_000), state: "found" } });
    expect(planVersion(base, down, {})).toMatchObject({ ok: true, adminRequired: false });
  });
});

describe("which changes need an admin", () => {
  const c = (key: RuleKey, oldValue: number | null, newValue: number | null) => ({ key, oldValue, newValue, edited: false });

  it("counts raising the advance limit or the weekly recovery, and lowering the net pay floor", () => {
    expect(needsAdmin([c("advance_limit_default_cents", 50_000, 60_000)])).toBe(true);
    expect(needsAdmin([c("advance_recovery_cap_cents", 30_000, 40_000)])).toBe(true);
    expect(needsAdmin([c("advance_recovery_cap_cents", 30_000, null)])).toBe(true);
    expect(needsAdmin([c("net_pay_floor_cents", 30_000, 25_000)])).toBe(true);
  });

  it("does not count lowering the limit or recovery, raising the floor, or another rule", () => {
    expect(needsAdmin([c("advance_limit_default_cents", 60_000, 50_000)])).toBe(false);
    expect(needsAdmin([c("advance_recovery_cap_cents", null, 30_000)])).toBe(false);
    expect(needsAdmin([c("net_pay_floor_cents", 25_000, 30_000)])).toBe(false);
    expect(needsAdmin([c("insurance_per_day_cents", 1_000, 2_000)])).toBe(false);
  });
});

describe("stored values and escrow schedules", () => {
  it("reads a stored value with the rule's own parser", () => {
    expect(parseStoredValue("advance_recovery_cap_cents", "null")).toBeNull();
    expect(parseStoredValue("insurance_per_day_cents", "1050")).toBe(1050);
    expect(parseStoredValue("insurance_applies_to", "owner_operator")).toBe("owner_operator");
    expect(() => parseStoredValue("insurance_per_day_cents", "null")).toThrow();
  });

  it("sees a driver's escrow schedule that runs in or after the week", () => {
    const rows = { ...planRows("blue-ridge"), deduction_schedules: [] as DeductionScheduleRow[] };
    expect(escrowOnSchedules(rows, "2026-11-02")).toBe(false);
    const open = { kind: "escrow", active_to: null } as unknown as DeductionScheduleRow;
    const ended = { kind: "escrow", active_to: "2026-10-31" } as unknown as DeductionScheduleRow;
    const other = { kind: "insurance", active_to: null } as unknown as DeductionScheduleRow;
    expect(escrowOnSchedules({ ...rows, deduction_schedules: [ended, other] }, "2026-11-02")).toBe(false);
    expect(escrowOnSchedules({ ...rows, deduction_schedules: [open] }, "2026-11-02")).toBe(true);
  });
});
