import { checkDriver } from "./config";
import { checkDay, checkItem } from "./deductions";
import { checkLoad } from "./load-pay";
import { assertCents, assertCount, cents, floorDiv, mul } from "./money";
import {
  assertDate,
  assertId,
  assertOneOf,
  assertUniqueIds,
  compareText,
  FUEL_PAID_WITH,
  InputError,
  instantMs,
  type Cents,
  type CheckInput,
  type DriverRecord,
  type FuelPaidWith,
  type FuelPurchaseRecord,
  type LoadRecord,
  type LocalDate,
  type PayItemRecord,
  type SourceRef,
} from "./types";

// The four fuel checks (FUEL-ANOMALY design 3.1): every fill-up is held against the truck's tank,
// the load's route and the driver's day. Pure: no clock, no zone, no database. Whole values only:
// dates are the tenant-local purchase dates the caller read, states are two-letter codes, gallons
// are thousandths. A finding carries ids, categories and the engine's numbers, never prose from
// the data; sources[0] is the fill-up at fault. Output order is fixed, whatever order the records
// arrive in.
//
// The engine's suggested correction is signed (negative takes money back from the driver's pay):
//   off the route, company card     -> the whole fill-up back (owner's default D1)
//   off the route, the driver paid  -> none (the driver's own money)
//   over the tank                   -> none; the excess is shown (owner's default D2)
//   on a day off (company card)     -> the whole fill-up back (D1)
//   either of those two, when a fuel deduction already takes the fill-up from the driver's
//   pay                             -> none (taking it again would charge the driver twice)
//   the same fill-up twice          -> the second payback back, naming its pay line, when the
//                                      driver was paid back for it; otherwise none
// runFuelChecks then caps it at the correction limit and drops fill-ups before the start date.

export const FUEL_CHECK_NAMES = [
  "fuel_off_route",
  "fuel_over_tank",
  "fuel_while_parked",
  "fuel_duplicate",
] as const;
export type FuelCheckName = (typeof FUEL_CHECK_NAMES)[number];

export const FUEL_CATEGORY_OF = {
  fuel_off_route: "state_not_on_route",
  fuel_over_tank: "gallons_over_tank",
  fuel_while_parked: "no_load_or_day",
  fuel_duplicate: "same_fill_twice",
} as const satisfies Record<FuelCheckName, string>;
export type FuelCategory = (typeof FUEL_CATEGORY_OF)[FuelCheckName];

// Why a finding has no suggested correction.
export const NO_SUGGESTION_REASONS = [
  "driver_paid",
  "already_deducted",
  "over_tank",
  "card_double_charge",
  "not_paid_back",
  "over_limit",
] as const;
export type NoSuggestionReason = (typeof NO_SUGGESTION_REASONS)[number];

export type FuelLimits = {
  // Tenant-local: fill-ups before it are never listed.
  from: LocalDate;
  duplicateWindowMinutes: number;
  chargebackMaxCents: number;
};

export type FuelFinding = {
  check: FuelCheckName;
  category: FuelCategory;
  driverId: string;
  // The fill-up at fault's whole amount.
  amountCents: Cents;
  sources: SourceRef[];
  // check:purchase (the duplicate adds :older), the dedupe key a rerun upserts on.
  findingKey: string;
  fuelPurchaseId: string;
  otherPurchaseId: string | null;
  loadId: string | null;
  payItemId: string | null;
  purchasedOn: LocalDate;
  state: string;
  gallonsMilli: number;
  tankGallons: number;
  paidWith: FuelPaidWith;
  // Over the tank only: the share of the price that bought the gallons over the tank, rounded down.
  excessCents: Cents | null;
  // Exactly one of the two is set.
  suggestedCents: Cents | null;
  noSuggestion: NoSuggestionReason | null;
};

const STATE = /^[A-Z]{2}$/;
const MS_PER_MINUTE = 60_000;

function checkPurchase(p: FuelPurchaseRecord): FuelPurchaseRecord {
  const id = assertId(p?.id, "fuel purchase id");
  const where = `fuel purchase ${id}`;
  assertId(p.driverId, `${where} driverId`);
  if (p.loadId !== null) assertId(p.loadId, `${where} loadId`);
  assertOneOf(p.paidWith, FUEL_PAID_WITH, `${where} paidWith`);
  assertDate(p.purchasedOn, `${where} purchasedOn`);
  instantMs(p.purchasedAt, `${where} purchasedAt`);
  if (assertCents(p.amountCents, `${where} amountCents`) === 0) {
    throw new InputError(`${where} amountCents is zero`);
  }
  if (assertCount(p.gallonsMilli, `${where} gallonsMilli`) === 0) {
    throw new InputError(`${where} gallonsMilli is zero`);
  }
  if (typeof p.state !== "string" || !STATE.test(p.state)) {
    throw new InputError(`${where} state is not a two-letter code`);
  }
  assertId(p.purchaseRef, `${where} purchaseRef`);
  return p;
}

function checkTank(driver: DriverRecord): number {
  const tank = assertCount(driver.tankGallons, `driver ${driver.id} tankGallons`);
  if (tank === 0) throw new InputError(`driver ${driver.id} tankGallons is zero`);
  return tank;
}

type Read = {
  drivers: Map<string, DriverRecord>;
  loads: Map<string, LoadRecord>;
  loadsByDriver: Map<string, LoadRecord[]>;
  dayKeys: Set<string>;
  items: PayItemRecord[];
  purchases: FuelPurchaseRecord[];
};

// Every record the four rules read, checked once. A record for a driver the tenant does not have
// is a broken read, not a clean result.
function readInput(input: CheckInput): Read {
  const drivers = new Map<string, DriverRecord>();
  for (const d of assertUniqueIds(input.drivers, "driver")) {
    checkDriver(d);
    checkTank(d);
    drivers.set(d.id, d);
  }
  const driverKnown = (id: string, what: string) => {
    if (!drivers.has(id)) throw new InputError(`${what} names a driver not in the check input`);
  };
  const loads = new Map<string, LoadRecord>();
  const loadsByDriver = new Map<string, LoadRecord[]>();
  for (const l of assertUniqueIds(input.loads, "load")) {
    checkLoad(l);
    loads.set(l.id, l);
    if (l.driverId === null) continue;
    loadsByDriver.set(l.driverId, [...(loadsByDriver.get(l.driverId) ?? []), l]);
  }
  const dayKeys = new Set<string>();
  for (const d of input.days) {
    checkDay(d);
    dayKeys.add(`${d.driverId}:${d.day}`);
  }
  const items = input.items
    .map((i) => checkItem(i))
    .sort((a, b) => compareText(a.itemRef, b.itemRef) || compareText(a.id, b.id));
  const purchases = assertUniqueIds(input.fuelPurchases, "fuel purchase")
    .map((p) => checkPurchase(p))
    .sort(byPurchase);
  for (const p of purchases) driverKnown(p.driverId, `fuel purchase ${p.id}`);
  return { drivers, loads, loadsByDriver, dayKeys, items, purchases };
}

function byPurchase(a: FuelPurchaseRecord, b: FuelPurchaseRecord): number {
  return (
    compareText(a.purchasedOn, b.purchasedOn) ||
    compareText(a.purchaseRef, b.purchaseRef) ||
    compareText(a.id, b.id)
  );
}

// A load is on the road on a day from its pickup to its delivery, or to that day while it has
// none. A cancelled load never drove.
function onTheRoad(load: LoadRecord, day: LocalDate): boolean {
  return load.status !== "cancelled" && load.pickupOn <= day && day <= (load.deliveredOn ?? day);
}

const purchaseRef = (p: FuelPurchaseRecord): SourceRef => ({ table: "fuel_purchases", id: p.id });
const driverRef = (id: string): SourceRef => ({ table: "drivers", id });
const itemRefOf = (i: PayItemRecord): SourceRef => ({ table: "pay_items", id: i.id });

function base(
  check: FuelCheckName,
  p: FuelPurchaseRecord,
  driver: DriverRecord,
  sources: SourceRef[],
): Omit<FuelFinding, "suggestedCents" | "noSuggestion"> {
  return {
    check,
    category: FUEL_CATEGORY_OF[check],
    driverId: p.driverId,
    amountCents: p.amountCents,
    sources,
    findingKey: `${check}:${p.id}`,
    fuelPurchaseId: p.id,
    otherPurchaseId: null,
    loadId: null,
    payItemId: null,
    purchasedOn: p.purchasedOn,
    state: p.state,
    gallonsMilli: p.gallonsMilli,
    tankGallons: driver.tankGallons,
    paidWith: p.paidWith,
    excessCents: null,
  };
}

const chargeBack = (p: FuelPurchaseRecord) => ({
  suggestedCents: cents(-p.amountCents),
  noSuggestion: null,
});
const none = (why: NoSuggestionReason) => ({ suggestedCents: null, noSuggestion: why });

// The fuel deduction that already takes this fill-up from a driver's pay, if any. Any driver's:
// a deduction on the wrong driver is the wrong-driver check's to fix, never a reason to charge
// the fill-up a second time.
function deductionOf(r: Read, p: FuelPurchaseRecord): PayItemRecord | undefined {
  return r.items.find((i) => i.kind === "fuel" && i.refTable === "fuel_purchases" && i.refId === p.id);
}

// A company-card fill-up's charge-back (D1), unless a fuel deduction already takes it.
function chargeBackUnlessDeducted(p: FuelPurchaseRecord, deducted: PayItemRecord | undefined) {
  return deducted ? none("already_deducted") : chargeBack(p);
}

// A fill-up on a load, on a day that load was on the road, in a state the load never crossed.
// A purchase whose load is not in the input is skipped, never guessed.
export function findFuelOffRoute(input: CheckInput): FuelFinding[] {
  const r = readInput(input);
  const out: FuelFinding[] = [];
  for (const p of r.purchases) {
    if (p.loadId === null) continue;
    const load = r.loads.get(p.loadId);
    if (!load || !onTheRoad(load, p.purchasedOn)) continue;
    if (load.stateMiles.some((m) => m.state === p.state)) continue;
    const driver = r.drivers.get(p.driverId)!;
    const deducted = deductionOf(r, p);
    out.push({
      ...base("fuel_off_route", p, driver, [
        purchaseRef(p),
        { table: "loads", id: load.id },
        driverRef(p.driverId),
        ...(deducted ? [itemRefOf(deducted)] : []),
      ]),
      loadId: load.id,
      payItemId: deducted?.id ?? null,
      ...(p.paidWith === "company_card" ? chargeBackUnlessDeducted(p, deducted) : none("driver_paid")),
    });
  }
  return out;
}

// The tank's gallons, in thousandths, and the share of the price that bought what is over it.
export function overTankExcessCents(amountCents: number, gallonsMilli: number, tankGallons: number): Cents {
  const tankMilli = mul(tankGallons, 1000, "tank");
  if (gallonsMilli <= tankMilli) return cents(0);
  return cents(floorDiv(mul(amountCents, gallonsMilli - tankMilli, "excess"), gallonsMilli));
}

// More gallons in one fill-up than the truck's tanks hold. Listed with the excess, never a
// suggested correction (D2).
export function findFuelOverTank(input: CheckInput): FuelFinding[] {
  const r = readInput(input);
  const out: FuelFinding[] = [];
  for (const p of r.purchases) {
    const driver = r.drivers.get(p.driverId)!;
    if (p.gallonsMilli <= mul(driver.tankGallons, 1000, "tank")) continue;
    const item = deductionOf(r, p);
    out.push({
      ...base("fuel_over_tank", p, driver, [
        purchaseRef(p),
        driverRef(p.driverId),
        ...(item ? [itemRefOf(item)] : []),
      ]),
      payItemId: item?.id ?? null,
      excessCents: overTankExcessCents(p.amountCents, p.gallonsMilli, driver.tankGallons),
      ...none("over_tank"),
    });
  }
  return out;
}

// A company-card fill-up on a day the driver had no load on the road and no day row.
export function findFuelWhileParked(input: CheckInput): FuelFinding[] {
  const r = readInput(input);
  const out: FuelFinding[] = [];
  for (const p of r.purchases) {
    if (p.paidWith !== "company_card") continue;
    if ((r.loadsByDriver.get(p.driverId) ?? []).some((l) => onTheRoad(l, p.purchasedOn))) continue;
    if (r.dayKeys.has(`${p.driverId}:${p.purchasedOn}`)) continue;
    const driver = r.drivers.get(p.driverId)!;
    const deducted = deductionOf(r, p);
    out.push({
      ...base("fuel_while_parked", p, driver, [
        purchaseRef(p),
        driverRef(p.driverId),
        ...(deducted ? [itemRefOf(deducted)] : []),
      ]),
      payItemId: deducted?.id ?? null,
      ...chargeBackUnlessDeducted(p, deducted),
    });
  }
  return out;
}

// Two fill-ups by one driver with the same gallons, amount and state, the second within the
// window of the first: the newer one is at fault. Each (older, newer) pair is one finding.
export function findFuelDuplicate(input: CheckInput, windowMinutes: number): FuelFinding[] {
  const window = assertCount(windowMinutes, "duplicate window minutes");
  const windowMs = mul(window, MS_PER_MINUTE, "window");
  const r = readInput(input);
  const timed = r.purchases
    .map((p) => ({ p, at: instantMs(p.purchasedAt, `fuel purchase ${p.id} purchasedAt`) }))
    .sort((a, b) => compareText(a.p.driverId, b.p.driverId) || a.at - b.at || compareText(a.p.id, b.p.id));
  const out: FuelFinding[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const older = timed[i];
      const newer = timed[j];
      if (older.p.driverId !== newer.p.driverId || newer.at - older.at > windowMs) break;
      if (
        older.p.gallonsMilli !== newer.p.gallonsMilli ||
        older.p.amountCents !== newer.p.amountCents ||
        older.p.state !== newer.p.state
      ) {
        continue;
      }
      const p = newer.p;
      const payback = r.items.find(
        (it) =>
          it.kind === "reimbursement" &&
          it.subkind === "fuel" &&
          it.refTable === "fuel_purchases" &&
          it.refId === p.id &&
          it.driverId === p.driverId,
      );
      const driver = r.drivers.get(p.driverId)!;
      const found = base("fuel_duplicate", p, driver, [
        purchaseRef(p),
        purchaseRef(older.p),
        ...(payback ? [itemRefOf(payback)] : []),
      ]);
      out.push({
        ...found,
        findingKey: `${found.findingKey}:${older.p.id}`,
        otherPurchaseId: older.p.id,
        payItemId: payback?.id ?? null,
        ...(payback
          ? chargeBack(p)
          : none(p.paidWith === "company_card" ? "card_double_charge" : "not_paid_back")),
      });
    }
  }
  return out.sort(
    (a, b) =>
      compareText(a.purchasedOn, b.purchasedOn) ||
      compareText(a.fuelPurchaseId, b.fuelPurchaseId) ||
      compareText(a.otherPurchaseId ?? "", b.otherPurchaseId ?? ""),
  );
}

// The engine's suggestion inside the correction limit: above it the finding says so and offers
// none, so a person handles it by hand.
export function suggestedCorrection(
  finding: Pick<FuelFinding, "suggestedCents" | "noSuggestion">,
  limits: Pick<FuelLimits, "chargebackMaxCents">,
): Pick<FuelFinding, "suggestedCents" | "noSuggestion"> {
  const max = limits.chargebackMaxCents;
  if (!Number.isSafeInteger(max) || max <= 0) throw new InputError("chargebackMaxCents is not positive");
  if (finding.suggestedCents === null) return { suggestedCents: null, noSuggestion: finding.noSuggestion };
  if (Math.abs(finding.suggestedCents) > max) return none("over_limit");
  return { suggestedCents: finding.suggestedCents, noSuggestion: null };
}

// The four rules over one tenant's records, capped, from the start date on. Order: the four
// checks in turn, each in its own fixed order.
export function runFuelChecks(input: CheckInput, limits: FuelLimits): FuelFinding[] {
  const from = assertDate(limits.from, "fuel checks start date");
  return [
    ...findFuelOffRoute(input),
    ...findFuelOverTank(input),
    ...findFuelWhileParked(input),
    ...findFuelDuplicate(input, limits.duplicateWindowMinutes),
  ]
    .filter((f) => f.purchasedOn >= from)
    .map((f) => ({ ...f, ...suggestedCorrection(f, limits) }));
}
