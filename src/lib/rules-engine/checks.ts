import { advanceLimitOf, assertPayConfig, checkDriver, insuranceApplies } from "./config";
import { checkDay, checkItem } from "./deductions";
import { byLoadNumber, checkLoad, isDelivered } from "./load-pay";
import { assertCents, cents, sub, sum } from "./money";
import { byOldest, checkAdvance, DUPLICATE_WINDOW_MS, outstandingCents } from "./recovery";
import {
  assertDate,
  assertId,
  assertOneOf,
  compareText,
  FUEL_PAID_WITH,
  InputError,
  instantMs,
  type AdvanceRecord,
  type CheckInput,
  type DriverRecord,
  type Finding,
  type FuelPurchaseRecord,
  type LoadRecord,
  type SourceRef,
} from "./types";

// The six money problems the agent looks for, each a pure function over one tenant's records.
// Findings carry categories, ids and amounts, never prose from the data, and sources[0] is the
// record at fault. Output order is fixed, whatever order the records arrive in.

function checkPurchase(p: FuelPurchaseRecord): FuelPurchaseRecord {
  const id = assertId(p?.id, "fuel purchase id");
  assertId(p.driverId, `fuel purchase ${id} driverId`);
  assertOneOf(p.paidWith, FUEL_PAID_WITH, `fuel purchase ${id} paidWith`);
  assertDate(p.purchasedOn, `fuel purchase ${id} purchasedOn`);
  assertCents(p.amountCents, `fuel purchase ${id} amountCents`);
  return p;
}

function driversById(input: CheckInput): Map<string, DriverRecord> {
  return new Map(input.drivers.map((d) => [checkDriver(d).id, d]));
}

// A record for a driver the tenant does not have is a broken read, not a clean result.
function driverOf(drivers: Map<string, DriverRecord>, id: string): DriverRecord {
  const driver = drivers.get(id);
  if (!driver) throw new InputError(`driver ${id} is not in the check input`);
  return driver;
}

const advanceRef = (a: AdvanceRecord): SourceRef => ({ table: "advances", id: a.id });
const loadRef = (l: LoadRecord): SourceRef => ({ table: "loads", id: l.id });

// Same driver and amount, approved or paid, requested within 24 hours of each other: one finding
// per pair, the newer named as the duplicate.
export function findDuplicateAdvances(input: CheckInput): Finding[] {
  const counted = input.advances
    .map((a) => checkAdvance(a))
    .filter((a) => a.status === "approved" || a.status === "paid")
    .sort((a, b) => compareText(a.driverId, b.driverId) || byOldest(a, b));
  const out: Finding[] = [];
  for (let i = 0; i < counted.length; i++) {
    for (let j = i + 1; j < counted.length; j++) {
      const older = counted[i];
      const newer = counted[j];
      if (older.driverId !== newer.driverId) break;
      const gap =
        instantMs(newer.requestedAt, "requestedAt") - instantMs(older.requestedAt, "requestedAt");
      if (older.amountCents === newer.amountCents && gap <= DUPLICATE_WINDOW_MS) {
        out.push({
          check: "duplicate_advance",
          category: "newer_is_duplicate",
          driverId: newer.driverId,
          amountCents: newer.amountCents,
          sources: [advanceRef(newer), advanceRef(older)],
        });
      }
    }
  }
  return out;
}

// A company-card fuel deduction whose purchase was made by, or on a load hauled by, another
// driver. A fuel item that names no purchase the tenant has cannot be proven right, so it is a
// finding too.
export function findFuelOnWrongDriver(input: CheckInput): Finding[] {
  const purchases = new Map(input.fuelPurchases.map((p) => [checkPurchase(p).id, p]));
  const loads = new Map(input.loads.map((l) => [checkLoad(l).id, l]));
  const items = input.items
    .map((i) => checkItem(i))
    .filter((i) => i.kind === "fuel")
    .sort((a, b) => compareText(a.itemRef, b.itemRef) || compareText(a.id, b.id));
  const out: Finding[] = [];
  for (const item of items) {
    const itemRef: SourceRef = { table: "pay_items", id: item.id };
    const base = {
      check: "fuel_on_wrong_driver" as const,
      driverId: item.driverId,
      amountCents: item.amountCents,
    };
    const purchase =
      item.refTable === "fuel_purchases" && item.refId !== null
        ? purchases.get(item.refId)
        : undefined;
    if (!purchase) {
      out.push({ ...base, category: "purchase_not_found", sources: [itemRef] });
      continue;
    }
    const load = purchase.loadId === null ? undefined : loads.get(purchase.loadId);
    const sources: SourceRef[] = [
      itemRef,
      { table: "fuel_purchases", id: purchase.id },
      ...(load ? [loadRef(load)] : []),
    ];
    if (purchase.driverId !== item.driverId) {
      out.push({ ...base, category: "purchase_on_other_driver", sources });
    } else if (load && load.driverId !== item.driverId) {
      out.push({ ...base, category: "load_on_other_driver", sources });
    }
  }
  return out;
}

// A day row for an insured driver with no load of theirs on the road that day: picked up on or
// before it and delivered on or after it, or picked up and still in transit. Each one is an
// insurance charge for a day not driven.
export function findInsuranceDaysNotDriven(input: CheckInput): Finding[] {
  const config = assertPayConfig(input.config);
  const drivers = driversById(input);
  const loadsByDriver = new Map<string, LoadRecord[]>();
  for (const load of input.loads.map((l) => checkLoad(l))) {
    if (load.driverId === null) continue;
    loadsByDriver.set(load.driverId, [...(loadsByDriver.get(load.driverId) ?? []), load]);
  }
  const onTheRoad = (load: LoadRecord, day: string) =>
    load.pickupOn <= day &&
    ((isDelivered(load) && load.deliveredOn !== null && day <= load.deliveredOn) ||
      load.status === "in_transit");
  const days = input.days
    .map((d) => checkDay(d))
    .sort(
      (a, b) =>
        compareText(a.day, b.day) || compareText(a.driverId, b.driverId) || compareText(a.id, b.id),
    );
  const out: Finding[] = [];
  for (const day of days) {
    if (!insuranceApplies(config, driverOf(drivers, day.driverId))) continue;
    if ((loadsByDriver.get(day.driverId) ?? []).some((l) => onTheRoad(l, day.day))) continue;
    out.push({
      check: "insurance_day_not_driven",
      category: "no_load_that_day",
      driverId: day.driverId,
      amountCents: config.insurancePerDayCents,
      sources: [{ table: "driver_days", id: day.id }],
    });
  }
  return out;
}

// A lumper the driver paid on a delivered load with no reimbursement item pointing at it.
export function findMissingReimbursements(input: CheckInput): Finding[] {
  const reimbursed = new Set(
    input.items
      .map((i) => checkItem(i))
      .filter((i) => i.kind === "reimbursement" && i.refTable === "load_accessorials")
      .map((i) => i.refId),
  );
  const loads = input.loads
    .map((l) => checkLoad(l))
    .filter(isDelivered)
    .sort(byLoadNumber);
  const out: Finding[] = [];
  for (const load of loads) {
    const owed = load.accessorials
      .filter((a) => a.paidByDriver && !reimbursed.has(a.id))
      .sort((a, b) => compareText(a.kind, b.kind) || a.seq - b.seq || compareText(a.id, b.id));
    for (const a of owed) {
      out.push({
        check: "missing_reimbursement",
        category: "no_reimbursement",
        driverId: load.driverId ?? undefined,
        amountCents: a.amountCents,
        sources: [{ table: "load_accessorials", id: a.id }, loadRef(load)],
      });
    }
  }
  return out;
}

// A delivered or invoiced load with no linehaul rate: the customer cannot be invoiced and a
// percent or flat driver's pay cannot be computed.
export function findDeliveredWithoutRate(input: CheckInput): Finding[] {
  return input.loads
    .map((l) => checkLoad(l))
    .filter((l) => isDelivered(l) && l.linehaulCents === null)
    .sort(byLoadNumber)
    .map((l) => ({
      check: "delivered_without_rate" as const,
      category: "rate_missing" as const,
      driverId: l.driverId ?? undefined,
      sources: [loadRef(l)],
    }));
}

// Outstanding advances (approved: amount + fee; paid: amount + fee - recovered) over the
// driver's limit. The amount is how far over.
export function findOverAdvanceLimit(input: CheckInput): Finding[] {
  const config = assertPayConfig(input.config);
  const drivers = driversById(input);
  const byDriver = new Map<string, AdvanceRecord[]>();
  for (const a of input.advances.map((x) => checkAdvance(x))) {
    driverOf(drivers, a.driverId);
    if (outstandingCents(a) > 0) byDriver.set(a.driverId, [...(byDriver.get(a.driverId) ?? []), a]);
  }
  const out: Finding[] = [];
  const ordered = [...drivers.values()].sort(
    (a, b) => compareText(a.code, b.code) || compareText(a.id, b.id),
  );
  for (const driver of ordered) {
    const open = (byDriver.get(driver.id) ?? []).sort(byOldest);
    const owed = sum(open.map(outstandingCents));
    const limit = advanceLimitOf(config, driver);
    if (owed <= limit) continue;
    out.push({
      check: "over_advance_limit",
      category: "over_limit",
      driverId: driver.id,
      amountCents: cents(sub(owed, limit)),
      sources: [{ table: "drivers", id: driver.id }, ...open.map(advanceRef)],
    });
  }
  return out;
}

export function runAllChecks(input: CheckInput): Finding[] {
  return [
    ...findDuplicateAdvances(input),
    ...findFuelOnWrongDriver(input),
    ...findInsuranceDaysNotDriven(input),
    ...findMissingReimbursements(input),
    ...findDeliveredWithoutRate(input),
    ...findOverAdvanceLimit(input),
  ];
}
