import { describe, expect, it } from "vitest";
import {
  changeArgsOf,
  changeArgsSchema,
  changeMatches,
  ruleChangeOf,
  type RuleChange,
  type RuleChangeArgs,
  type RuleChangeCheck,
  type RuleChangeRows,
} from "./change";
import { rowsFor, versionFrom } from "./__tests__/rows";
import { helpExample, nextWeekStart } from "./words";

// The shared check at fixed instants, on the seed's two carriers at the golden anchor. Oct 27,
// 2026 is a Tuesday: Blue Ridge (New York, Monday weeks) is in the week of Oct 26, Prairie Wind
// (Chicago, Sunday weeks) in the week of Oct 25.

const TUESDAY = new Date("2026-10-27T15:00:00Z");
const SENTENCE = "Starting Nov 2, owner-operator insurance goes to $12 a day";
const INSURANCE: RuleChangeArgs = { ruleKey: "insurance_per_day_cents", newValue: 1200, askedFrom: "2026-11-02" };

function ok(check: RuleChangeCheck): RuleChange {
  if (!check.ok) throw new Error(`refused: ${check.reason}`);
  return check.change;
}

const reason = (check: RuleChangeCheck) => (check.ok ? "ok" : check.reason);

function check(
  rows: RuleChangeRows,
  args: Partial<RuleChangeArgs> = {},
  text: string | null = SENTENCE,
  now = TUESDAY,
): RuleChangeCheck {
  return ruleChangeOf(rows, { ...INSURANCE, ...args }, { text }, now);
}

describe("the date a change starts", () => {
  it("starts on the asked week start when it is a future week", () => {
    const c = ok(check(rowsFor("blue-ridge")));
    expect(c.effectiveFrom).toBe("2026-11-02");
    expect(c.snapped).toBe(false);
    expect(c.applied).toBe("new_version");
  });

  it("moves an asked date inside a week to the next week start, and says so", () => {
    const c = ok(check(rowsFor("prairie-wind")));
    expect(c.askedFrom).toBe("2026-11-02");
    expect(c.effectiveFrom).toBe("2026-11-08");
    expect(c.snapped).toBe(true);
  });

  it("starts a change asked for today with the next week", () => {
    const c = ok(check(rowsFor("blue-ridge"), { askedFrom: "2026-10-27" }, "from today insurance is $12"));
    expect(c.effectiveFrom).toBe("2026-11-02");
    expect(c.snapped).toBe(true);
  });

  it("refuses this week's start and any past date", () => {
    expect(reason(check(rowsFor("blue-ridge"), { askedFrom: "2026-10-26" }))).toBe("effective_in_past");
    expect(reason(check(rowsFor("blue-ridge"), { askedFrom: "2026-10-25" }))).toBe("effective_in_past");
    expect(reason(check(rowsFor("prairie-wind"), { askedFrom: "2026-10-25" }))).toBe("effective_in_past");
  });

  it("refuses a date more than a year ahead and a date that is not one", () => {
    expect(reason(check(rowsFor("blue-ridge"), { askedFrom: "2027-11-05" }))).toBe("too_far_ahead");
    expect(reason(check(rowsFor("blue-ridge"), { askedFrom: "2026-11-31" }))).toBe("bad_date");
    expect(reason(check(rowsFor("blue-ridge"), { askedFrom: "Nov 2" }))).toBe("bad_date");
  });

  it("reads today in the carrier's own zone across the fall-back night", () => {
    // 04:30Z on Nov 1 is still Oct 31 in Chicago, so Prairie Wind's week of Nov 1 has not begun;
    // an hour later it is Nov 1 there and that week has.
    const before = new Date("2026-11-01T04:30:00Z");
    const after = new Date("2026-11-01T05:30:00Z");
    const pw = rowsFor("prairie-wind");
    const nov1 = { askedFrom: "2026-11-01" };
    const text = "from Nov 1 insurance is $12";
    expect(ok(check(pw, nov1, text, before)).effectiveFrom).toBe("2026-11-01");
    expect(reason(check(pw, nov1, text, after))).toBe("effective_in_past");
    // In New York it is Nov 1 at both instants: Blue Ridge's week of Oct 26 runs to Nov 1.
    expect(ok(check(rowsFor("blue-ridge"), {}, SENTENCE, before)).effectiveFrom).toBe("2026-11-02");
    expect(ok(check(rowsFor("blue-ridge"), {}, SENTENCE, after)).effectiveFrom).toBe("2026-11-02");
  });
});

describe("the rule and the value", () => {
  it("refuses an unknown rule, a bad value and a value out of range", () => {
    const rows = rowsFor("blue-ridge");
    expect(reason(check(rows, { ruleKey: "week_start_dow", newValue: 0 }))).toBe("unknown_rule");
    expect(reason(check(rows, { newValue: "1200" }))).toBe("bad_value");
    expect(reason(check(rows, { newValue: 12.5 }))).toBe("bad_value");
    expect(reason(check(rows, { newValue: 50_001 }, "insurance $500.01 from Nov 2"))).toBe("value_out_of_range");
  });

  it("refuses a value the person's sentence does not hold, and any change outside a turn", () => {
    const rows = rowsFor("blue-ridge");
    expect(reason(check(rows, { newValue: 1250 }))).toBe("value_not_in_message");
    expect(reason(check(rows, {}, null))).toBe("value_not_in_message");
    // The executor and the auditor skip the sentence: it was checked when the change was proposed.
    expect(ruleChangeOf(rows, { ...INSURANCE, newValue: 1250 }, "skip", TUESDAY).ok).toBe(true);
  });

  it("refuses a change to the value already in force", () => {
    expect(reason(check(rowsFor("blue-ridge"), { newValue: 1100 }, "insurance $11 from Nov 2"))).toBe("no_change");
  });

  describe("escrow per week", () => {
    // The engine takes each driver's escrow from their own schedule's amount, never the carrier's
    // escrow per week, so a change to it while any escrow schedule still runs would change nothing.
    const ESCROW: Partial<RuleChangeArgs> = { ruleKey: "escrow_per_settlement_cents", newValue: 7500 };
    const SAID = "From Nov 2, escrow is $75 a week";
    const withEscrowSchedules = (fields: { active_from?: string; active_to: string | null }) => {
      const rows = rowsFor("blue-ridge");
      return {
        ...rows,
        deduction_schedules: rows.deduction_schedules.map((s) => (s.kind === "escrow" ? { ...s, ...fields } : s)),
      };
    };

    it("refuses while a driver's escrow schedule runs in or after the week it would start", () => {
      const rows = rowsFor("blue-ridge");
      expect(rows.deduction_schedules.some((s) => s.kind === "escrow" && s.active_to === null)).toBe(true);
      expect(reason(check(rows, ESCROW, SAID))).toBe("escrow_on_driver_schedules");
      // A schedule that ends on the first day of that week still runs in it.
      expect(reason(check(withEscrowSchedules({ active_to: "2026-11-02" }), ESCROW, SAID))).toBe(
        "escrow_on_driver_schedules",
      );
      // A schedule that only starts after that week would take its own amount then too.
      expect(
        reason(check(withEscrowSchedules({ active_from: "2026-11-16", active_to: null }), ESCROW, SAID)),
      ).toBe("escrow_on_driver_schedules");
      // The executor and the auditor re-check it without the sentence.
      expect(reason(ruleChangeOf(rows, { ...INSURANCE, ...ESCROW }, "skip", TUESDAY))).toBe(
        "escrow_on_driver_schedules",
      );
    });

    it("is not the rule the help under the question box gives as its example; that one is accepted", () => {
      // The example is dated the carrier's first week a change can start, now and after Nov 9
      // (Tuesday Nov 10), when a fixed Nov 9 is already refused on Monday weeks.
      const afterNov9 = new Date("2026-11-10T15:00:00Z");
      for (const slug of ["blue-ridge", "prairie-wind"] as const) {
        const rows = rowsFor(slug);
        for (const now of [TUESDAY, afterNov9]) {
          const next = nextWeekStart(now, rows.tenant.timezone, rows.pay_configs[0].week_start_dow);
          const example = helpExample(next);
          expect(example).not.toMatch(/escrow/i);
          const floor = { ruleKey: "net_pay_floor_cents", newValue: 35_000, askedFrom: next } as const;
          expect(reason(check(rows, floor, example, now))).toBe("ok");
        }
      }
      // A fixed "From Nov 9" is refused by then on Monday weeks, where Nov 9 starts the week under way.
      const nov9 = { ruleKey: "net_pay_floor_cents", newValue: 35_000, askedFrom: "2026-11-09" } as const;
      const fixed = "From Nov 9, the net pay floor is $350 a week.";
      expect(reason(check(rowsFor("blue-ridge"), nov9, fixed, afterNov9))).toBe("effective_in_past");
    });

    it("allows it once every escrow schedule has ended before that week", () => {
      const rows = withEscrowSchedules({ active_to: "2026-11-01" });
      const c = ok(check(rows, ESCROW, SAID));
      expect(c.oldValue).toBe(10_000);
      expect(c.newValue).toBe(7500);
      // The source rows are untouched.
      expect(rowsFor("blue-ridge").deduction_schedules.some((s) => s.active_to === "2026-11-01")).toBe(false);
    });
  });

  it("names the old value from the version in force that week", () => {
    const c = ok(check(rowsFor("blue-ridge")));
    expect(c.oldValue).toBe(1100);
    expect(c.newValue).toBe(1200);
    expect(c.label).toBe("Owner-operator insurance");
    expect(c.appliesTo).toBe("owner_operator");
    const base = rowsFor("blue-ridge").pay_configs.find((v) => v.id === c.baseVersionId);
    expect(base?.effective_from).toBe("2026-10-19");
    expect(c.baseEffectiveFrom).toBe("2026-10-19");
    expect(c.sources[0]).toEqual({ table: "pay_configs", id: c.baseVersionId });
    expect(c.sources.length).toBeLessThanOrEqual(10);
  });
});

describe("versions after today", () => {
  const FUTURE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("edits a version that already starts that week and that no pay names", () => {
    const rows = rowsFor("blue-ridge");
    rows.pay_configs.push(versionFrom(rows, FUTURE, "2026-11-02", { escrow_per_settlement_cents: 7500 }));
    const c = ok(check(rows));
    expect(c.applied).toBe("edited_version");
    expect(c.baseVersionId).toBe(FUTURE);
  });

  it("edits only a version a person made; a seeded one that starts that week is locked", () => {
    const seeded = rowsFor("blue-ridge");
    seeded.pay_configs.push(versionFrom(seeded, FUTURE, "2026-11-02", { source: "seed" }));
    expect(reason(check(seeded))).toBe("locked_version");

    const inApp = rowsFor("blue-ridge");
    inApp.pay_configs.push(versionFrom(inApp, FUTURE, "2026-11-02", { source: "ui" }));
    const c = ok(check(inApp));
    expect(c.applied).toBe("edited_version");
    expect(c.baseVersionId).toBe(FUTURE);
  });

  it("refuses a change that a later saved version would undo", () => {
    const rows = rowsFor("blue-ridge");
    rows.pay_configs.push(versionFrom(rows, FUTURE, "2026-11-09"));
    expect(reason(check(rows))).toBe("later_version");
  });

  it("refuses a version paid under, and any week on or after the date that is approved", () => {
    const named = rowsFor("blue-ridge");
    named.pay_configs.push(versionFrom(named, FUTURE, "2026-11-02"));
    named.settlements = named.settlements.map((s, i) => (i === 0 ? { ...s, pay_config_id: FUTURE, status: "approved" } : s));
    expect(reason(check(named))).toBe("locked_version");

    const later = rowsFor("blue-ridge");
    const open = later.settlement_periods.find((p) => p.status === "open");
    if (!open) throw new Error("the seed has no open week");
    later.settlement_periods.push({
      ...open,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      period_start: "2026-11-02",
      period_end: "2026-11-08",
      status: "approved",
    });
    expect(reason(check(later))).toBe("locked_version");
  });

  it("refuses rules that do not sort, as no rules could be read", () => {
    const rows = rowsFor("blue-ridge");
    rows.pay_configs.push(versionFrom(rows, FUTURE, "2026-11-02", { week_start_dow: 0 }));
    expect(reason(check(rows, { askedFrom: "2026-11-09" }, "insurance $12 from Nov 9"))).toBe("week_shape");
    expect(reason(check({ ...rowsFor("blue-ridge"), pay_configs: [] }))).toBe("no_pay_config");
  });
});

describe("the stored args", () => {
  it("round-trip through the schema and match the engine whole", () => {
    const c = ok(check(rowsFor("blue-ridge")));
    const args = changeArgsOf(c);
    expect(changeArgsSchema.parse(JSON.parse(JSON.stringify(args)))).toEqual(args);
    expect(changeMatches(args, c)).toBe(true);
    // Key order does not matter (jsonb keeps its own).
    const reordered = Object.fromEntries(Object.entries(args).reverse());
    expect(changeMatches(reordered, c)).toBe(true);
  });

  it("rejects any one changed field", () => {
    const c = ok(check(rowsFor("blue-ridge")));
    const args = changeArgsOf(c);
    const changes: Record<string, unknown>[] = [
      { oldValue: 1050 },
      { newValue: 1300 },
      { askedFrom: "2026-11-03" },
      { effectiveFrom: "2026-11-09" },
      { snapped: true },
      { applied: "edited_version" },
      { baseVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { baseEffectiveFrom: "2026-10-05" },
      { appliesTo: "all" },
      { impact: { ...args.impact, netDeltaCents: args.impact.netDeltaCents + 1 } },
      { impact: { ...args.impact, driversChanged: args.impact.driversChanged + 1 } },
      { impact: { ...args.impact, top: args.impact.top.slice(1) } },
      { extra: 1 },
    ];
    for (const over of changes) expect(changeMatches({ ...args, ...over }, c)).toBe(false);
    expect(changeMatches(null, c)).toBe(false);
  });
});
