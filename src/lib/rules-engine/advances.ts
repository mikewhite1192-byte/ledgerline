import { advanceLimitOf, assertPayConfig, checkDriver } from "./config";
import { earnedUnpaid } from "./load-pay";
import { assertCents, cents, mulBps, sub, sum } from "./money";
import { byOldest, checkAdvance, DUPLICATE_WINDOW_MS, outstandingCents } from "./recovery";
import {
  assertDate,
  instantMs,
  type AdvanceDecision,
  type AdvanceInput,
  type AdvanceRefusal,
  type SourceRef,
} from "./types";

// Can this driver have this advance now? Every refusal that applies is listed, in a fixed order,
// with the numbers behind it. The engine decides nothing about money moving: a person approves,
// and the ledger pays.
//
// earnedUnpaid = load pay on loads delivered on or before the request day that no paid
//                settlement has covered
// open         = outstanding on approved and paid advances (amount + fee - recovered)
// maxCents     = min(limit - open - fee, earnedUnpaid x share - open), or 0 when under the minimum
// The fee counts against the limit, the same way findOverAdvanceLimit counts it. The share is
// cumulative: open advances count against it, so splitting a request does not get past it.
export function advanceEligibility(input: AdvanceInput): AdvanceDecision {
  const config = assertPayConfig(input.config);
  const driver = checkDriver(input.driver);
  const amount = assertCents(input.amountCents, "amountCents");
  const requestedMs = instantMs(input.requestedAt, "requestedAt");
  const requestedOn = assertDate(input.requestedOn, "requestedOn");
  const advances = input.advances.map((a) => checkAdvance(a, driver.id)).sort(byOldest);

  const earned = earnedUnpaid(config, driver, input.loads, input.paidPeriods, requestedOn);
  const owing = advances.filter((a) => outstandingCents(a) > 0);
  const open = sum(owing.map(outstandingCents));
  const limit = advanceLimitOf(config, driver);
  const fee = config.advanceFeeCents;
  const share = mulBps(earned.cents, config.advanceMaxBpsOfEarned);
  const duplicates = advances.filter(
    (a) =>
      (a.status === "approved" || a.status === "paid") &&
      a.amountCents === amount &&
      Math.abs(instantMs(a.requestedAt, "requestedAt") - requestedMs) <= DUPLICATE_WINDOW_MS,
  );
  const inactive =
    requestedOn < driver.activeFrom || (driver.activeTo !== null && requestedOn > driver.activeTo);

  const reasons: AdvanceRefusal[] = [];
  if (inactive) reasons.push("driver_inactive");
  if (amount < Math.max(1, config.advanceMinCents)) reasons.push("below_minimum");
  if (earned.cents === 0) reasons.push("no_unpaid_earnings");
  if (sum([open, amount, fee]) > limit) reasons.push("over_driver_limit");
  if (sum([open, amount]) > share) reasons.push("exceeds_earned_share");
  if (duplicates.length > 0) reasons.push("possible_duplicate");

  const upTo = Math.max(0, Math.min(sub(limit, sum([open, fee])), sub(share, open)));
  const maxCents = cents(inactive || upTo < Math.max(1, config.advanceMinCents) ? 0 : upTo);
  const eligible = reasons.length === 0;
  const sources: SourceRef[] = [
    { table: "drivers", id: driver.id },
    ...earned.sources,
    ...owing.map((a) => ({ table: "advances" as const, id: a.id })),
    ...duplicates
      .filter((d) => !owing.includes(d))
      .map((a) => ({ table: "advances" as const, id: a.id })),
  ];
  return {
    eligible,
    approvedCents: eligible ? amount : cents(0),
    maxCents,
    feeCents: fee,
    reasons,
    earnedUnpaidCents: earned.cents,
    openCents: open,
    limitCents: limit,
    sources,
  };
}
