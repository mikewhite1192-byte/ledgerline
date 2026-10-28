// The worked week the "How trucking pay works" page tells, as plain constants: the page is public
// and reads no carrier's records. hero-week.test.ts holds every number here equal to the seed (the
// hero lines in src/lib/seed/golden.json, HERO_OPEN_WEEK, and the demo plan's own rows), so the
// page fails a test before it can drift from the demo.

export type HeroLineKind = "load_pay" | "reimbursement" | "insurance" | "escrow" | "advance_recovery";

export type HeroLine = {
  seq: number;
  kind: HeroLineKind;
  // The label the rules engine writes for this line, exactly as golden.json holds it.
  engineLabel: string;
  amountCents: number;
};

export const HERO_CARRIER = "Blue Ridge Freight Lines";

export const HERO_DRIVER = {
  name: "Monique Vasquez",
  firstName: "Monique",
  code: "BR-D07",
  workerType: "owner_operator",
  // An owner-operator's share of each load's linehaul, in percent.
  percentOfLinehaul: 75,
} as const;

// The open week in the demo: Monday to Sunday.
export const HERO_PERIOD = { start: "2026-10-26", end: "2026-11-01" } as const;

// The three loads she hauled that week, by the linehaul each paid.
export const HERO_LOADS = [
  { loadNumber: "BR-L10247", linehaulCents: 110_000 },
  { loadNumber: "BR-L10269", linehaulCents: 130_000 },
  { loadNumber: "BR-L10307", linehaulCents: 80_000 },
] as const;

export const HERO_LINES: readonly HeroLine[] = [
  { seq: 1, kind: "load_pay", engineLabel: "Load BR-L10247", amountCents: 82_500 },
  { seq: 2, kind: "load_pay", engineLabel: "Load BR-L10269", amountCents: 97_500 },
  { seq: 3, kind: "load_pay", engineLabel: "Load BR-L10307", amountCents: 60_000 },
  { seq: 4, kind: "reimbursement", engineLabel: "Reimbursement (toll)", amountCents: 4_500 },
  { seq: 5, kind: "reimbursement", engineLabel: "Reimbursement (toll)", amountCents: 3_500 },
  { seq: 6, kind: "reimbursement", engineLabel: "Reimbursement (fuel)", amountCents: 10_000 },
  { seq: 7, kind: "insurance", engineLabel: "Insurance, 5 days", amountCents: -5_500 },
  { seq: 8, kind: "escrow", engineLabel: "Escrow", amountCents: -10_000 },
  { seq: 9, kind: "advance_recovery", engineLabel: "Advance recovery (2026-10-28)", amountCents: -20_000 },
];

export const HERO_TOTALS = { grossCents: 258_000, deductionsCents: 35_500, netCents: 222_500 } as const;

// Insurance is charged per day driven, at the pay rules' daily rate for that week.
export const HERO_INSURANCE = { days: 5, perDayCents: 1_100 } as const;

// The day she asked for the advance the last line takes back.
export const HERO_ADVANCE = { requestedOn: "2026-10-28", weekday: "Wednesday", amountCents: 20_000 } as const;

// Money in: one delivered load, as the customer is billed for it.
export const EXAMPLE_LOAD = {
  loadNumber: "BR-L10247",
  origin: "Raleigh, NC",
  destination: "Philadelphia, PA",
  loadedMiles: 405,
  linehaulCents: 110_000,
  fuelSurchargeCents: 14_000,
  invoiceCents: 124_000,
} as const;

// The README and the page tell the same short story; these sums are what it quotes.
export const HERO_STORY = {
  loadPayCents: 240_000,
  reimbursedCents: 18_000,
} as const;
