import { describe, expect, it } from "vitest";
import { HERO_OPEN_WEEK } from "./assert-plan";
import { DEMO_CARRIERS } from "./carriers";
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
});
