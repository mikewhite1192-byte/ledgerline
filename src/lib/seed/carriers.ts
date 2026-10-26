import type { PayConfigKnobs } from "../data/rows";

// The two invented demo carriers. slug, name and timezone must equal the tenant rows that
// scripts/create-demo-users.ts creates (a unit test compares the two files): the seed refuses a
// tenant whose row differs, so a wrong database fails before anything is written. Driver email
// addresses use the reserved .example domains: no real mailbox.

export type DemoCarrier = {
  slug: "blue-ridge" | "prairie-wind";
  name: string;
  timezone: string;
  // Prefix of every code and number the seed makes (drivers, customers, loads, invoices).
  prefix: "BR" | "PW";
  emailDomain: string;
  // The driver whose open week is the worked example, or null.
  heroCode: string | null;
  // The versions of the pay rules, oldest first. Each takes effect at the start of one of the
  // four seeded weeks (0 is the oldest), so the dates follow the anchor; at the golden anchor
  // Blue Ridge's are 2026-10-05 and 2026-10-19 and Prairie Wind's is 2026-10-04.
  payConfigs: readonly DemoPayConfig[];
};

export type DemoPayConfig = PayConfigKnobs & { from_week: number; note: string };

const BLUE_RIDGE_OPENING: PayConfigKnobs = {
  week_start_dow: 1,
  percent_base: "linehaul",
  empty_miles_paid_bps: 0,
  accessorial_driver_share_bps: 10000,
  insurance_applies_to: "owner_operator",
  insurance_per_day_cents: 1050,
  escrow_target_cents: 200000,
  escrow_per_settlement_cents: 10000,
  net_pay_floor_cents: 30000,
  advance_recovery_cap_cents: null,
  advance_fee_cents: 0,
  advance_limit_default_cents: 50000,
  advance_max_bps_of_earned: 5000,
  advance_min_cents: 5000,
};

// Detention terms by the customer's place in its carrier's list (not drawn at random, so the
// planted detention cases always meet the same terms): $75 an hour for the 4th, 8th and 12th,
// $60 for the 3rd, 7th and 11th, else $50; 90 minutes free for the 2nd and 10th, 180 for the
// 6th, else 120.
export function detentionTermsOf(index: number): { freeMinutes: number; hourlyCents: number } {
  const hourlyCents = [3, 7, 11].includes(index) ? 7500 : [2, 6, 10].includes(index) ? 6000 : 5000;
  const freeMinutes = [1, 9].includes(index) ? 90 : index === 5 ? 180 : 120;
  return { freeMinutes, hourlyCents };
}

export const DEMO_CARRIERS: readonly DemoCarrier[] = [
  {
    slug: "blue-ridge",
    name: "Blue Ridge Freight Lines",
    timezone: "America/New_York",
    prefix: "BR",
    emailDomain: "blueridge.example",
    heroCode: "BR-D07",
    payConfigs: [
      { ...BLUE_RIDGE_OPENING, from_week: 0, note: "Opening pay policy" },
      {
        ...BLUE_RIDGE_OPENING,
        insurance_per_day_cents: 1100,
        from_week: 2,
        note: "Owner-operator insurance to $11.00 per day",
      },
    ],
  },
  {
    slug: "prairie-wind",
    name: "Prairie Wind Transport",
    timezone: "America/Chicago",
    prefix: "PW",
    emailDomain: "prairiewind.example",
    heroCode: null,
    payConfigs: [
      {
        week_start_dow: 0,
        percent_base: "linehaul_fsc",
        empty_miles_paid_bps: 10000,
        accessorial_driver_share_bps: 5000,
        insurance_applies_to: "all",
        insurance_per_day_cents: 900,
        escrow_target_cents: 150000,
        escrow_per_settlement_cents: 7500,
        net_pay_floor_cents: 25000,
        advance_recovery_cap_cents: 25000,
        advance_fee_cents: 500,
        advance_limit_default_cents: 75000,
        advance_max_bps_of_earned: 6000,
        advance_min_cents: 5000,
        from_week: 0,
        note: "Opening pay policy",
      },
    ],
  },
];

export function carrierBySlug(slug: string): DemoCarrier | undefined {
  return DEMO_CARRIERS.find((c) => c.slug === slug);
}
