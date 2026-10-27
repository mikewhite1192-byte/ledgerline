import { describe, expect, it } from "vitest";
import { buildCarrierPlan } from "../seed/plan";
import { DEMO_ANCHOR } from "../seed/anchor";
import { DEMO_CARRIERS } from "../seed/carriers";
import { planCollections } from "../rules-engine/collections";
import { receivablesInputOf } from "../data/records";
import { buildReminderPack, figuresOf, packText, parseFigures, type ReminderFigures } from "./pack";

// The reminder pack holds only the invoice's own figures, the two names and the tone; the check's
// allowed lists come from exactly those.

const FIGURES: ReminderFigures = {
  invoiceNumber: "BRF-INV-10012",
  amountCents: 245_000,
  balanceCents: 222_500,
  dueOn: "2026-09-23",
  daysLate: 34,
  asOf: "2026-10-27",
  profileLabel: "repeat_late",
};

describe("figuresOf and parseFigures", () => {
  it("stores a planned invoice's figures and reads them back exactly", () => {
    const plan = buildCarrierPlan(DEMO_CARRIERS[0], DEMO_ANCHOR);
    const [first] = planCollections(receivablesInputOf(plan.rows, DEMO_ANCHOR), null, 30);
    const figures = figuresOf(first, DEMO_ANCHOR);
    expect(figures).toEqual({
      invoiceNumber: first.invoiceNumber,
      amountCents: first.amountCents,
      balanceCents: first.balanceCents,
      dueOn: first.dueOn,
      daysLate: first.daysLate,
      asOf: DEMO_ANCHOR,
      profileLabel: first.profile.label,
    });
    expect(parseFigures(figures)).toEqual(figures);
    expect(parseFigures(JSON.stringify(figures))).toEqual(figures);
  });

  it("refuses figures with a missing or extra key, a wrong type, or an impossible value", () => {
    const bad: unknown[] = [
      null,
      "not json",
      [],
      { ...FIGURES, extra: 1 },
      Object.fromEntries(Object.entries(FIGURES).filter(([k]) => k !== "asOf")),
      { ...FIGURES, amountCents: 1.5 },
      { ...FIGURES, balanceCents: 0 },
      { ...FIGURES, balanceCents: FIGURES.amountCents + 1 },
      { ...FIGURES, dueOn: "2026-02-30" },
      { ...FIGURES, asOf: "Oct 27" },
      { ...FIGURES, daysLate: -1 },
      { ...FIGURES, profileLabel: "great" },
      { ...FIGURES, invoiceNumber: "INV 1" },
      { ...FIGURES, invoiceNumber: "-INV" },
      { ...FIGURES, invoiceNumber: "x".repeat(41) },
    ];
    for (const value of bad) expect(parseFigures(value), JSON.stringify(value)).toBeNull();
  });
});

describe("buildReminderPack", () => {
  it("allows the total and the balance, the balance first, and only the figures' own numbers", () => {
    const pack = buildReminderPack(FIGURES, "direct", "Cobble Ridge Furniture", "Example Freight 2 Lines");
    expect(pack.netCents).toBe(222_500);
    expect([...pack.allowedCents].sort()).toEqual([222_500, 245_000]);
    expect([...pack.allowedNumbers].sort()).toEqual(["10012", "2", "2026", "23", "34"].sort());
    expect(pack.seqs).toEqual([]);
    expect(pack.language).toBe("en");
  });

  it("lists one amount once when nothing has been paid", () => {
    const pack = buildReminderPack({ ...FIGURES, balanceCents: 245_000 }, "friendly", "Cobble Ridge Furniture", "Example Freight Lines");
    expect(pack.allowedCents).toEqual([245_000]);
  });

  it("writes the facts in the words a person reads, with no record id or address", () => {
    const pack = buildReminderPack(FIGURES, "firm", "Cobble Ridge Furniture", "Example Freight Lines");
    const text = packText(pack);
    expect(text).toContain("Invoice number: BRF-INV-10012");
    expect(text).toContain("Invoice total: $2,450.00");
    expect(text).toContain("Balance due: $2,225.00");
    expect(text).toContain("Due date: Sep 23, 2026");
    expect(text).toContain("Days past due: 34");
    expect(text).toContain("Tone: firm");
    expect(text).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
