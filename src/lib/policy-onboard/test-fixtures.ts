import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RulesAnswer } from "./map";

// Test-only: the two model answers of a policy run for each sample, hand-written from the
// samples' answer keys (src/lib/seed/policy/*.expected.json). The read answer copies each numbered
// paragraph of the sample's text, lines joined, as a good read of its PDF would. The propose
// answer points at the passages that state each rule. No model is called anywhere.

export type SampleName = "harrow-flats-pay-policy" | "cedar-bend-pay-policy";

const textOf = (name: SampleName) => readFileSync(join(process.cwd(), "src", "lib", "seed", "policy", `${name}.md`), "utf8");

// The sample's numbered paragraphs in order, as {number, text}.
export function sampleSections(name: SampleName): { number: string; text: string }[] {
  return textOf(name)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .flatMap((p) => {
      const m = /^(\d+\.\d+) (.*)$/.exec(p);
      return m ? [{ number: m[1], text: m[2] }] : [];
    });
}

export const readAnswerFor = (name: SampleName): string => JSON.stringify({ sections: sampleSections(name) });

const p = (section: string, quote: string, value_text: string) => ({ section, quote, value_text });

export const HARROW_RULES: RulesAnswer = {
  carrier_name: "Harrow Flats Trucking",
  effective_date: [p("1.1", "takes effect on November 2, 2026", "November 2, 2026")],
  week_start: [p("2.1", "The pay week runs from 12:00 a.m. Monday through 11:59 p.m. Sunday", "Monday")],
  rules: {
    insurance_per_day_cents: [p("5.1", "charges each owner-operator $10.50 for each calendar day", "$10.50")],
    insurance_applies_to: [
      p("5.1", "Leased owner-operators are covered under the carrier's occupational accident policy", "owner-operators"),
    ],
    escrow_target_cents: [p("6.1", "until the escrow balance reaches $2,500", "$2,500")],
    escrow_per_settlement_cents: [p("6.1", "The carrier withholds $125 from each weekly settlement", "$125")],
    net_pay_floor_cents: [
      p("6.2", "weekly net pay under $350", "$350"),
      p("9.4", "No deduction of any kind may take a driver's weekly net pay under $300", "$300"),
    ],
    advance_recovery_cap_cents: [p("9.3", "at most $300 per settlement", "$300")],
    advance_fee_cents: [p("9.1", "Each advance carries a $3 fee.", "$3")],
    advance_limit_default_cents: [p("9.2", "an advance may not exceed $600", "$600")],
    advance_max_bps_of_earned: [p("9.2", "50 percent of the driver's earned and unpaid pay", "50 percent")],
    advance_min_cents: [p("9.2", "The smallest advance is $75.", "$75")],
    empty_miles_paid_bps: [p("3.3", "paid to per-mile drivers at half the loaded rate", "half")],
    accessorial_driver_share_bps: [p("4.1", "receives 75 percent of that charge", "75 percent")],
    percent_base: [p("3.2", "74 percent of the linehaul and fuel surcharge", "linehaul and fuel surcharge")],
  },
  noted: [
    { key: "per_mile", ...p("3.1", "Company drivers on long-haul lanes are paid $0.62 per loaded mile", "$0.62") },
    { key: "per_load", ...p("3.1", "paid a flat $200 per load", "$200") },
    { key: "oo_percent", ...p("3.2", "Leased owner-operators are paid 74 percent", "74 percent") },
    { key: "detention_free_minutes", ...p("8.1", "the carrier allows two hours free at each pickup", "two hours") },
    { key: "detention_hourly", ...p("8.1", "bills detention at $60 per hour", "$60") },
  ],
};

export const CEDAR_RULES: RulesAnswer = {
  carrier_name: "Cedar Bend Carriers",
  effective_date: [p("1.1", "takes effect on December 6, 2026", "December 6, 2026")],
  week_start: [p("2.1", "The pay week runs from 12:00 a.m. Sunday through 11:59 p.m. Saturday", "Sunday")],
  rules: {
    insurance_per_day_cents: [p("5.1", "The carrier charges $11.00 per day, billed as $77.00 per week", "$11.00")],
    insurance_applies_to: [p("5.1", "Every driver, company or leased, is covered", "all drivers")],
    escrow_target_cents: [],
    escrow_per_settlement_cents: [],
    net_pay_floor_cents: [p("6.1", "weekly net pay under $275", "$275")],
    advance_recovery_cap_cents: [p("7.3", "with no cap on the amount taken back from one settlement", "no cap")],
    advance_fee_cents: [p("7.1", "Each advance carries a fee of $3 to $5 depending on the card", "$3 to $5")],
    advance_limit_default_cents: [p("7.2", "A driver may not owe more than $500 in advances at one time", "$500")],
    advance_max_bps_of_earned: [
      p("7.2", "no single advance may be more than 40 percent of the driver's earned and unpaid pay", "40 percent"),
    ],
    advance_min_cents: [p("7.2", "An advance may not be less than $50.", "$50")],
    empty_miles_paid_bps: [p("3.3", "at 80 percent of the loaded rate", "80 percent")],
    accessorial_driver_share_bps: [p("4.1", "receives 60 percent of that charge", "60 percent")],
    percent_base: [
      p("3.2", "70 percent of the linehaul, fuel surcharge and accessorial charges", "linehaul, fuel surcharge and accessorial charges"),
    ],
  },
  noted: [
    { key: "per_mile", ...p("3.1", "Company drivers on long-haul lanes are paid $0.58 per loaded mile", "$0.58") },
    { key: "per_load", ...p("3.1", "paid a flat $185 per load", "$185") },
    { key: "oo_percent", ...p("3.2", "Leased owner-operators are paid 70 percent", "70 percent") },
    { key: "detention_free_minutes", ...p("8.1", "the carrier allows 90 minutes free at each pickup", "90 minutes") },
    { key: "detention_hourly", ...p("8.1", "bills detention at $55 per hour", "$55") },
  ],
};

export const rulesAnswerFor = (name: SampleName): RulesAnswer => (name === "harrow-flats-pay-policy" ? HARROW_RULES : CEDAR_RULES);
