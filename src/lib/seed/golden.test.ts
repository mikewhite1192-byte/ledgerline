import { describe, expect, it } from "vitest";
import { HERO_OPEN_WEEK } from "./assert-plan";
import { flags } from "../../config/flags";
import { cashPositionOf, PLANTED_GAP_CENTS } from "./cash-plan";
import { DEMO_CARRIERS, type DemoCarrier } from "./carriers";
import golden from "./golden.json";
import { buildCarrierPlan } from "./plan";
import { summarizePlan } from "./summary";

// golden.json is the reviewed summary of both carriers at one anchor. A change to the seed that
// moves any count, total or hero line fails here first; regenerate it only on purpose.

describe("golden.json", () => {
  it("equals the summary of both plans at the golden anchor", () => {
    const carriers = Object.fromEntries(
      DEMO_CARRIERS.map((c) => [c.slug, summarizePlan(buildCarrierPlan(c, golden.anchor))]),
    );
    expect({ anchor: golden.anchor, carriers }).toEqual(golden);
  });

  it("holds the hero's worked week to the cent", () => {
    const hero = golden.carriers["blue-ridge"].hero;
    expect(hero?.code).toBe("BR-D07");
    expect(hero?.netCents).toBe(HERO_OPEN_WEEK.netCents);
    expect(hero?.grossCents).toBe(HERO_OPEN_WEEK.grossCents);
    expect(hero?.deductionsCents).toBe(HERO_OPEN_WEEK.deductionsCents);
    expect(hero?.lines.map((l) => [l.kind, l.label, l.amountCents])).toEqual([
      ["load_pay", "Load BR-L10247", 82500],
      ["load_pay", "Load BR-L10269", 97500],
      ["load_pay", "Load BR-L10307", 60000],
      ["reimbursement", "Reimbursement (toll)", 4500],
      ["reimbursement", "Reimbursement (toll)", 3500],
      ["reimbursement", "Reimbursement (fuel)", 10000],
      ["insurance", "Insurance, 5 days", -5500],
      ["escrow", "Escrow", -10000],
      ["advance_recovery", "Advance recovery (2026-10-28)", -20000],
    ]);
    const sum = hero?.lines.reduce((n, l) => n + l.amountCents, 0);
    expect(sum).toBe(HERO_OPEN_WEEK.netCents);
  });

  // Cash Friday's demo (design 4.9): both carriers are covered with money in the bank (Blue Ridge
  // by $36,120.00), so neither gets a way out on the page.
  it("plants a covered Friday with no options for both carriers", () => {
    const br = golden.carriers["blue-ridge"].cashFriday;
    expect(br.gapCents).toBe(PLANTED_GAP_CENTS["blue-ridge"]);
    expect(br.gapCents).toBe(3_612_000);
    expect(br.bankBalanceCents).toBeGreaterThan(0);
    expect([br.factoringInvoices, br.deferBillRef, br.chaseCustomers]).toEqual([0, null, 0]);
    const pw = golden.carriers["prairie-wind"].cashFriday;
    expect(pw.gapCents).toBe(PLANTED_GAP_CENTS["prairie-wind"]);
    expect(pw.bankBalanceCents).toBeGreaterThan(0);
    expect([pw.factoringInvoices, pw.deferBillRef, pw.chaseCustomers]).toEqual([0, null, 0]);
  });

  // Some database tests seed a demo carrier under another slug: that copy has no planted gap, so
  // its balance covers Friday exactly and it gets no cards.
  it("covers Friday exactly for a demo carrier copied under another slug", () => {
    const copy = { ...DEMO_CARRIERS[0], slug: "cash-copy-test" } as unknown as DemoCarrier;
    const plan = buildCarrierPlan(copy, golden.anchor);
    const r = cashPositionOf(plan.rows, copy, golden.anchor, flags.cashFridayLimits);
    expect(Number.isSafeInteger(plan.rows.cash_settings[0].bank_balance_cents)).toBe(true);
    expect([r.figures.gapCents, r.options]).toEqual([0, []]);
  });
});
