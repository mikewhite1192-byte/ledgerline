import { describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { cashPositionOf } from "../seed/cash-plan";
import { DEMO_CARRIERS } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan } from "../seed/plan";
import { withShortFriday } from "../seed/test-short-friday";
import {
  billDeferArgsSchema,
  chaseArgsSchema,
  factoringArgsSchema,
  optionArgs,
  optionReasons,
  parseArgsText,
  sameArgs,
} from "./args";

// The card args built from the engine's options for Blue Ridge at the golden anchor, its bank
// balance lowered so Friday is short by $6,800.00 (the seed covers Friday): each
// kind round-trips its strict schema, carries the fixed reason categories, and compares as a whole
// value. Pure: no clock, no database.

const carrier = DEMO_CARRIERS.find((c) => c.slug === "blue-ridge");
if (!carrier) throw new Error("no blue-ridge carrier");
const plan = withShortFriday(buildCarrierPlan(carrier, golden.anchor));
const r = cashPositionOf(plan.rows, carrier, golden.anchor, flags.cashFridayLimits);
const short = -r.figures.gapCents;
const of = (kind: string) => r.options.filter((o) => o.kind === kind);

describe("Cash Friday card args", () => {
  it("builds args each kind's strict schema accepts, with no days late in them", () => {
    const [factoring] = of("factoring_request");
    const [defer] = of("bill_defer");
    const chases = of("collections_chase");
    expect(factoring && defer && chases.length === 2).toBe(true);
    const f = factoringArgsSchema.parse(optionArgs(factoring, r.payDay, short));
    expect(f).toMatchObject({ payDay: "2026-11-06", shortCents: 680_000, periodId: factoring.subjectId });
    expect(f.invoices).toHaveLength(3);
    expect(f.amountCents).toBe(f.invoices.reduce((n, i) => n + i.netCents, 0));
    const d = billDeferArgsSchema.parse(optionArgs(defer, r.payDay, short));
    expect(d).toMatchObject({ billId: defer.subjectId, payDay: "2026-11-06", coversShort: true });
    expect(d.deferredTo > d.dueOn).toBe(true);
    for (const c of chases) {
      const a = chaseArgsSchema.parse(optionArgs(c, r.payDay, short));
      expect(a.customerId).toBe(c.subjectId);
      expect(JSON.stringify(a)).not.toMatch(/daysLate|days_late/);
    }
  });

  it("refuses an extra field or a negative amount", () => {
    const [defer] = of("bill_defer");
    const args = optionArgs(defer, r.payDay, short);
    expect(billDeferArgsSchema.safeParse({ ...args, note: "pay later" }).success).toBe(false);
    expect(billDeferArgsSchema.safeParse({ ...args, amountCents: -1 }).success).toBe(false);
    expect(billDeferArgsSchema.safeParse({ ...args, revision: 2 }).success).toBe(true);
  });

  it("gives each kind its fixed reason categories", () => {
    const [factoring] = of("factoring_request");
    const [defer] = of("bill_defer");
    expect(optionReasons(factoring)).toEqual([
      factoring.kind === "factoring_request" && factoring.coversShort ? "covers_short" : "narrows_short",
      "factoring_test_mode",
    ]);
    expect(optionReasons(defer)).toEqual(["bill_flexible", "due_before_pay_day", "covers_short"]);
    for (const c of of("collections_chase")) {
      const reasons = optionReasons(c);
      expect(reasons.slice(-2)).toEqual(["past_due_balance", "collections_test_mode"]);
      expect(reasons.includes("repeat_late_payer")).toBe(c.kind === "collections_chase" && c.label === "repeat_late");
    }
  });

  it("compares stored and fresh args as whole values, the revision aside", () => {
    const [factoring] = of("factoring_request");
    const fresh = optionArgs(factoring, r.payDay, short);
    const stored = JSON.parse(JSON.stringify({ ...fresh, revision: 3 })) as Record<string, unknown>;
    expect(sameArgs(stored, fresh)).toBe(true);
    // Any one field differing is a different card, even a nested invoice's cents.
    expect(sameArgs({ ...stored, shortCents: short + 1 }, fresh)).toBe(false);
    const invoices = (stored.invoices as Record<string, unknown>[]).map((i, n) =>
      n === 0 ? { ...i, feeCents: (i.feeCents as number) + 1 } : i,
    );
    expect(sameArgs({ ...stored, invoices }, fresh)).toBe(false);
  });

  it("reads stored args text, and an unreadable text as nothing", () => {
    expect(parseArgsText('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgsText("{not json")).toBeNull();
    expect(parseArgsText({ a: 1 })).toEqual({ a: 1 });
  });
});
