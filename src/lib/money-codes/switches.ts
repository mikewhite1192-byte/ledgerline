import { flags } from "../../config/flags";
import { isLocalDate, type LocalDate } from "../time/local-date";

// The money-code switches, read fresh on every call (never cached), so a switch turned off stops
// the next request. The issue gate is asked before the gate approves (the precheck), again in the
// executor's transaction, and once more right before the money executor; the money executor and
// the simulated issuer then check payoutsEnabled and moneyCodes again at the write.

// Each word is the money code's own, so an approval card can say it without taking an advance's
// sentence for the same idea.
export type IssueRefusal =
  | "codes_off"
  | "codes_payouts_off"
  | "codes_not_armed"
  | "over_code_cap"
  | "codes_before_start";

export function moneyCodesOn(): boolean {
  return flags.moneyCodes?.enabled === true;
}

// today: the tenant's local date of the request instant. The cap is the most one code may be
// (inclusive), as the advance payout cap is; startDate gates issuing, never proposing.
export function issueGate(amountCents: number, today: LocalDate): IssueRefusal | null {
  const m = flags.moneyCodes;
  if (m?.enabled !== true) return "codes_off";
  if (flags.payoutsEnabled !== true) return "codes_payouts_off";
  if (m.armed !== true) return "codes_not_armed";
  if (!Number.isSafeInteger(m.capCents) || !Number.isSafeInteger(amountCents) || amountCents > m.capCents) {
    return "over_code_cap";
  }
  // A start date that is not a real calendar date is unknown, so closed.
  if (!isLocalDate(m.startDate) || today < m.startDate) return "codes_before_start";
  return null;
}
