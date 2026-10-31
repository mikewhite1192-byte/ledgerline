import { flags } from "../../config/flags";
import { cashPositionOf } from "./cash-plan";
import type { CarrierPlan } from "./plan";

// A seed plan with a short Friday, for the tests of the moves that answer one (factoring, a bill
// delay, a collections chase). The demo seed covers Friday for both carriers, so those moves have
// nothing to act on in the plan as seeded. This copies a plan and lowers only its bank balance,
// the same way the seed plants it, so the engine's gap is exactly the short asked for and its
// options come back; every other row is the plan's own. Tests only.

export const TEST_SHORT_CENTS = 680_000;

export function withShortFriday(plan: CarrierPlan, shortCents: number = TEST_SHORT_CENTS): CarrierPlan {
  if (!Number.isSafeInteger(shortCents) || shortCents <= 0) throw new Error("a short Friday needs a positive whole-cent short");
  const limits = flags.cashFridayLimits;
  const rows = structuredClone(plan.rows);
  const [settings] = rows.cash_settings;
  if (!settings || rows.cash_settings.length !== 1) throw new Error("the plan has no single cash settings row");
  const gap = cashPositionOf(rows, plan.carrier, plan.anchor, limits).figures.gapCents;
  settings.bank_balance_cents -= gap + shortCents;
  if (settings.bank_balance_cents < 0) throw new Error("the short asked for is more than the plan's bank balance");
  const after = cashPositionOf(rows, plan.carrier, plan.anchor, limits);
  if (after.figures.gapCents !== -shortCents || after.options.length === 0) {
    throw new Error("the lowered balance does not give the short asked for");
  }
  return { ...plan, rows };
}
