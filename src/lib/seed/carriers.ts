import type { PayConfigRow } from "../data/rows";

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
  payConfig: PayConfigRow;
};

export const DEMO_CARRIERS: readonly DemoCarrier[] = [
  {
    slug: "blue-ridge",
    name: "Blue Ridge Freight Lines",
    timezone: "America/New_York",
    prefix: "BR",
    emailDomain: "blueridge.example",
    heroCode: "BR-D07",
    payConfig: {
      week_start_dow: 1,
      percent_base: "linehaul",
      empty_miles_paid_bps: 0,
      accessorial_driver_share_bps: 10000,
      insurance_applies_to: "owner_operator",
      insurance_per_day_cents: 1100,
      escrow_target_cents: 200000,
      escrow_per_settlement_cents: 10000,
      net_pay_floor_cents: 30000,
      advance_recovery_cap_cents: null,
      advance_fee_cents: 0,
      advance_limit_default_cents: 50000,
      advance_max_bps_of_earned: 5000,
      advance_min_cents: 5000,
    },
  },
  {
    slug: "prairie-wind",
    name: "Prairie Wind Transport",
    timezone: "America/Chicago",
    prefix: "PW",
    emailDomain: "prairiewind.example",
    heroCode: null,
    payConfig: {
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
    },
  },
];

export function carrierBySlug(slug: string): DemoCarrier | undefined {
  return DEMO_CARRIERS.find((c) => c.slug === slug);
}
