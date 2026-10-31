import { advanceLimitOf, assertPayConfig, checkDriver } from "./config";
import { earnedUnpaid } from "./load-pay";
import { assertCents, cents, mulBps, sub, sum } from "./money";
import { byOldest, checkAdvance, DUPLICATE_WINDOW_MS, outstandingCents } from "./recovery";
import {
  assertDate,
  assertId,
  assertUniqueIds,
  instantMs,
  type AdvanceDecision,
  type AdvanceInput,
  type AdvanceRefusal,
  type Cents,
  type SourceRef,
} from "./types";

// Whole dollars at or under the amount: the suggestion never rounds up.
export function floorToDollars(amount: Cents): Cents {
  return cents(amount - (amount % 100));
}

// Can this driver have this advance now? Every refusal that applies is listed, in a fixed order,
// with the numbers behind it. The engine decides nothing about money moving: a person approves,
// and the ledger pays.
//
// earnedUnpaid = load pay on loads delivered on or before the request day that no paid
//                settlement has covered, plus, when the carrier's advanceUnlockStage is
//                picked_up, the named load's pay while it is in transit with its pickup recorded
//                at or before requestedAt (so a trip can be advanced against at pickup)
// open         = outstanding on approved and paid advances (amount + fee - recovered)
// maxCents     = min(limit - open - fee, earnedUnpaid x share - open), or 0 when under the minimum
// The fee counts against the limit, the same way findOverAdvanceLimit counts it. The share is
// cumulative: open advances count against it, so splitting a request does not get past it.
//
// With a load named and a per-load cap set:
// loadCap      = the driver's pay on that load x advancePerLoadBpsOfPay
// openOnLoad   = outstanding on the driver's approved and paid advances for that load
// headroom     = max(0, loadCap - openOnLoad); the amount plus its fee may not exceed it, and
//                maxCents is held to headroom - fee. The fee counts against the cap the same way
//                findAdvanceOverLoadCap counts it. Several advances on one trip are fine while
//                headroom remains.
// A driver nobody has armed gets nothing: driver_not_armed comes first and maxCents is 0.
// suggestedCents = min(amount, maxCents) floored to whole dollars, 0 under the minimum.
export function advanceEligibility(input: AdvanceInput): AdvanceDecision {
  const config = assertPayConfig(input.config);
  const driver = checkDriver(input.driver);
  const amount = assertCents(input.amountCents, "amountCents");
  const requestedMs = instantMs(input.requestedAt, "requestedAt");
  const requestedOn = assertDate(input.requestedOn, "requestedOn");
  const advances = assertUniqueIds(
    input.advances.map((a) => checkAdvance(a, driver.id)),
    "advance",
  ).sort(byOldest);

  const owing = advances.filter((a) => outstandingCents(a) > 0);
  const open = sum(owing.map(outstandingCents));
  const limit = advanceLimitOf(config, driver);
  const fee = config.advanceFeeCents;
  const duplicates = advances.filter(
    (a) =>
      (a.status === "approved" || a.status === "paid") &&
      a.amountCents === amount &&
      Math.abs(instantMs(a.requestedAt, "requestedAt") - requestedMs) <= DUPLICATE_WINDOW_MS,
  );
  const inactive =
    requestedOn < driver.activeFrom || (driver.activeTo !== null && requestedOn > driver.activeTo);
  const load = input.load ?? null;
  if (load !== null) {
    assertId(load.id, "load id");
    assertCents(load.payCents, "load payCents");
  }
  const pickedUpAt = load?.pickedUpAt ?? null;
  const pickedUp = pickedUpAt !== null && instantMs(pickedUpAt, "load pickedUpAt") <= requestedMs;
  const earned = earnedUnpaid(
    config,
    driver,
    input.loads,
    input.paidPeriods,
    requestedOn,
    pickedUp && load !== null ? load.id : null,
  );
  const share = mulBps(earned.cents, config.advanceMaxBpsOfEarned);
  const capped = load !== null && config.advancePerLoadBpsOfPay !== null;
  const onLoad = load === null ? [] : owing.filter((a) => a.loadId === load.id);
  const openOnLoad = sum(onLoad.map(outstandingCents));
  const loadCap = capped ? mulBps(load.payCents, config.advancePerLoadBpsOfPay!) : null;
  const headroom = loadCap === null ? null : cents(Math.max(0, sub(loadCap, openOnLoad)));

  const reasons: AdvanceRefusal[] = [];
  if (!driver.moneyArmed) reasons.push("driver_not_armed");
  if (inactive) reasons.push("driver_inactive");
  if (amount < Math.max(1, config.advanceMinCents)) reasons.push("below_minimum");
  if (earned.cents === 0) reasons.push("no_unpaid_earnings");
  if (sum([open, amount, fee]) > limit) reasons.push("over_driver_limit");
  if (sum([open, amount]) > share) reasons.push("exceeds_earned_share");
  if (duplicates.length > 0) reasons.push("possible_duplicate");
  if (headroom !== null && sum([amount, fee]) > headroom) reasons.push("over_load_cap");

  const minimum = Math.max(1, config.advanceMinCents);
  const onLoadUpTo = headroom === null ? Infinity : sub(headroom, fee);
  const allowed = Math.min(sub(limit, sum([open, fee])), sub(share, open), onLoadUpTo);
  const upTo = Math.max(0, allowed);
  const maxCents = cents(!driver.moneyArmed || inactive || upTo < minimum ? 0 : upTo);
  const suggested = floorToDollars(cents(Math.min(amount, maxCents)));
  const suggestedCents = suggested < minimum ? cents(0) : suggested;
  const eligible = reasons.length === 0;
  const sources: SourceRef[] = [
    { table: "drivers", id: driver.id },
    ...earned.sources,
    ...owing.map((a) => ({ table: "advances" as const, id: a.id })),
    ...duplicates
      .filter((d) => !owing.includes(d))
      .map((a) => ({ table: "advances" as const, id: a.id })),
  ];
  if (load !== null && !sources.some((x) => x.table === "loads" && x.id === load.id)) {
    sources.push({ table: "loads", id: load.id });
  }
  return {
    eligible,
    approvedCents: eligible ? amount : cents(0),
    maxCents,
    feeCents: fee,
    reasons,
    earnedUnpaidCents: earned.cents,
    openCents: open,
    limitCents: limit,
    loadCapCents: loadCap,
    loadHeadroomCents: headroom,
    openOnLoadCents: openOnLoad,
    suggestedCents,
    sources,
  };
}
