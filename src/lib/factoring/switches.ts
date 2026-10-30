import { flags } from "../../config/flags";
import { isLocalDate, type LocalDate } from "../time/local-date";

// The factoring switches, read fresh on every call (never cached), so a switch turned off stops
// the next request. The submit gate is asked before the gate approves (the precheck), again in
// the executor's transaction, and once more right before each invoice's money executor; the money
// executor and the simulated partner then check payoutsEnabled and factoring again at the write.

// Each word is factoring's own, so a card can say it without taking another feature's sentence.
export type SubmitRefusal =
  | "factoring_off"
  | "factoring_payouts_off"
  | "factoring_not_armed"
  | "over_factoring_cap"
  | "factoring_before_start";

export function factoringOn(): boolean {
  return flags.factoring?.enabled === true;
}

// netCents: what the whole request would pay out (the sum of every invoice's advance less its
// fee). today: the tenant's local date of the request instant. The cap is the most one request
// may pay out (inclusive); startDate gates submitting, never proposing.
export function submitGate(netCents: number, today: LocalDate): SubmitRefusal | null {
  const f = flags.factoring;
  if (f?.enabled !== true) return "factoring_off";
  if (flags.payoutsEnabled !== true) return "factoring_payouts_off";
  if (f.armed !== true) return "factoring_not_armed";
  if (!Number.isSafeInteger(f.maxNetCents) || !Number.isSafeInteger(netCents) || netCents > f.maxNetCents) {
    return "over_factoring_cap";
  }
  // A start date that is not a real calendar date is unknown, so closed.
  if (!isLocalDate(f.startDate) || today < f.startDate) return "factoring_before_start";
  return null;
}
