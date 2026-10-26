import { isWithin } from "../time/local-date";
import { driverRate } from "./config";
import { assertCents, assertCount, cents, mul, mulBps, sum } from "./money";
import {
  ACCESSORIAL_KINDS,
  assertDate,
  assertId,
  assertOneOf,
  assertPeriod,
  compareText,
  ConfigError,
  InputError,
  LOAD_STATUSES,
  type AccessorialKind,
  type Cents,
  type DriverRecord,
  type ExceptionLine,
  type LoadRecord,
  type LoadStatus,
  type LocalDate,
  type PayConfig,
  type PayLine,
  type Period,
  type SourceRef,
} from "./types";

// Step 1 of the pay math: one line per load delivered in the period, then one accessorial line
// per load with payable accessorials. Rounded per load, never on a total.

export type LineDraft = Omit<PayLine, "seq">;

// A load in either status has been delivered and is paid to its driver.
export const PAID_STATUSES: readonly LoadStatus[] = ["delivered", "invoiced"];
// Lumper is a pass-through cost the driver is reimbursed for, never paid on.
export const PAYABLE_ACCESSORIALS: readonly AccessorialKind[] = ["detention", "layover", "stop"];

const STATE = /^[A-Z]{2}$/;

export function isDelivered(load: LoadRecord): boolean {
  return PAID_STATUSES.includes(load.status);
}

// The shape of one load. With `driverId`, the load must be that driver's.
export function checkLoad(load: LoadRecord, driverId?: string): LoadRecord {
  const id = assertId(load?.id, "load id");
  const where = `load ${id}`;
  assertOneOf(load.status, LOAD_STATUSES, `${where} status`);
  if (driverId !== undefined && load.driverId !== driverId) {
    throw new InputError(`${where} is not this driver's`);
  }
  assertDate(load.pickupOn, `${where} pickupOn`);
  if (load.deliveredOn !== null) assertDate(load.deliveredOn, `${where} deliveredOn`);
  if (isDelivered(load) && (load.deliveredOn === null || load.driverId === null)) {
    throw new InputError(`${where} is delivered without a date or a driver`);
  }
  assertCount(load.loadedMiles, `${where} loadedMiles`);
  assertCount(load.emptyMiles, `${where} emptyMiles`);
  if (load.linehaulCents !== null) assertCents(load.linehaulCents, `${where} linehaulCents`);
  assertCents(load.fuelSurchargeCents, `${where} fuelSurchargeCents`);
  if (!Array.isArray(load.accessorials) || !Array.isArray(load.stateMiles)) {
    throw new InputError(`${where} has no accessorial or state-mile list`);
  }
  for (const a of load.accessorials) {
    assertId(a?.id, `${where} accessorial id`);
    assertOneOf(a.kind, ACCESSORIAL_KINDS, `accessorial ${a.id} kind`);
    assertCount(a.seq, `accessorial ${a.id} seq`);
    assertCents(a.amountCents, `accessorial ${a.id} amountCents`);
    if (typeof a.paidByDriver !== "boolean") {
      throw new InputError(`accessorial ${a.id} paidByDriver is not a boolean`);
    }
  }
  for (const s of load.stateMiles) {
    assertId(s?.id, `${where} state-mile id`);
    if (typeof s.state !== "string" || !STATE.test(s.state)) {
      throw new InputError(`state-mile ${s.id} state is not two capital letters`);
    }
    if (assertCount(s.miles, `state-mile ${s.id} miles`) === 0) {
      throw new InputError(`state-mile ${s.id} miles is zero`);
    }
  }
  return load;
}

// The IFTA invariant: the per-state miles of a load add up to its loaded plus empty miles.
export function assertStateMiles(load: LoadRecord): void {
  const total = sum(load.stateMiles.map((s) => s.miles));
  if (total !== sum([load.loadedMiles, load.emptyMiles])) {
    throw new InputError(`load ${load.id} state miles do not add up to its miles`);
  }
}

function payable(load: LoadRecord) {
  return load.accessorials
    .filter((a) => PAYABLE_ACCESSORIALS.includes(a.kind))
    .sort((a, b) => compareText(a.kind, b.kind) || a.seq - b.seq || compareText(a.id, b.id));
}

// The amount a percent driver's share is taken from; null when the load has no rate.
export function percentBaseCents(config: PayConfig, load: LoadRecord): Cents | null {
  if (load.linehaulCents === null) return null;
  switch (config.percentBase) {
    case "linehaul":
      return load.linehaulCents;
    case "linehaul_fsc":
      return sum([load.linehaulCents, load.fuelSurchargeCents]);
    case "linehaul_fsc_accessorials":
      return sum([
        load.linehaulCents,
        load.fuelSurchargeCents,
        ...payable(load).map((a) => a.amountCents),
      ]);
    default:
      throw new ConfigError("percentBase is not a known value");
  }
}

// Per mile pays from the miles, so a missing rate does not stop it. Percent and flat pay on a
// load with no rate is an exception at 0 cents, never a guess.
export function loadPay(
  config: PayConfig,
  driver: DriverRecord,
  load: LoadRecord,
): { line: LineDraft; exception: ExceptionLine | null } {
  assertStateMiles(load);
  const rate = driverRate(driver);
  const sources: SourceRef[] = [{ table: "loads", id: load.id }];
  const label = `Load ${load.loadNumber}`;
  if (rate.basis === "per_mile") {
    const loaded = mul(load.loadedMiles, rate.perMileCents, "loaded miles x rate");
    const emptyAll = mul(load.emptyMiles, rate.perMileCents, "empty miles x rate");
    const empty = mulBps(emptyAll, config.emptyMilesPaidBps);
    return {
      line: {
        kind: "load_pay",
        label,
        amountCents: sum([loaded, empty]),
        sources,
        meta: {
          basis: "per_mile",
          loadedMiles: load.loadedMiles,
          emptyMiles: load.emptyMiles,
          perMileCents: rate.perMileCents,
          emptyMilesPaidBps: config.emptyMilesPaidBps,
        },
      },
      exception: null,
    };
  }
  const base = percentBaseCents(config, load);
  if (base === null) {
    return {
      line: {
        kind: "load_pay",
        label: `${label} (rate missing)`,
        amountCents: cents(0),
        sources,
        meta: { basis: rate.basis, exception: "load_rate_missing" },
      },
      exception: {
        kind: "load_pay",
        category: "load_rate_missing",
        sources,
        amountCents: cents(0),
      },
    };
  }
  if (rate.basis === "percent") {
    return {
      line: {
        kind: "load_pay",
        label,
        amountCents: mulBps(base, rate.percentBps),
        sources,
        meta: {
          basis: "percent",
          percentBase: config.percentBase,
          baseCents: base,
          percentBps: rate.percentBps,
        },
      },
      exception: null,
    };
  }
  return {
    line: {
      kind: "load_pay",
      label,
      amountCents: rate.flatPerLoadCents,
      sources,
      meta: { basis: "flat", flatPerLoadCents: rate.flatPerLoadCents },
    },
    exception: null,
  };
}

// The driver's share of detention, layover and stop pay on one load. None when the percent base
// already includes accessorials (that would pay them twice), when the load has none, or when the
// share comes to zero.
export function accessorialPay(
  config: PayConfig,
  driver: DriverRecord,
  load: LoadRecord,
): LineDraft | null {
  if (driver.payBasis === "percent" && config.percentBase === "linehaul_fsc_accessorials") {
    return null;
  }
  const rows = payable(load);
  if (rows.length === 0) return null;
  const total = sum(rows.map((a) => a.amountCents));
  const amount = mulBps(total, config.accessorialDriverShareBps);
  if (amount === 0) return null;
  return {
    kind: "accessorial_pay",
    label: `Accessorials, load ${load.loadNumber}`,
    amountCents: amount,
    sources: rows.map((a) => ({ table: "load_accessorials", id: a.id })),
    meta: { accessorialCents: total, shareBps: config.accessorialDriverShareBps },
  };
}

export function byLoadNumber(a: LoadRecord, b: LoadRecord): number {
  return compareText(a.loadNumber, b.loadNumber) || compareText(a.id, b.id);
}

// Load pay for the driver's loads delivered on or before `requestedOn` that no paid settlement
// has covered yet: what an advance requested that day can be drawn against, so a replayed request
// is never credited with later loads. A percent or flat load with no rate adds no load pay here,
// never a guess, but its detention, layover and stop share still counts: that money is known.
export function earnedUnpaid(
  config: PayConfig,
  driver: DriverRecord,
  loads: readonly LoadRecord[],
  paidPeriods: readonly Period[],
  requestedOn: LocalDate,
): { cents: Cents; sources: SourceRef[] } {
  const asOf = assertDate(requestedOn, "requestedOn");
  const periods = paidPeriods.map((p) => assertPeriod(p));
  const amounts: number[] = [];
  const sources: SourceRef[] = [];
  const unpaid = loads
    .map((l) => checkLoad(l, driver.id))
    .filter((l) => isDelivered(l) && l.deliveredOn !== null && l.deliveredOn <= asOf)
    .filter((l) => !periods.some((p) => isWithin(l.deliveredOn ?? "", p)))
    .sort(byLoadNumber);
  for (const load of unpaid) {
    const pay = loadPay(config, driver, load).line.amountCents;
    const extra = accessorialPay(config, driver, load)?.amountCents ?? 0;
    const total = sum([pay, extra]);
    if (total > 0) {
      amounts.push(total);
      sources.push({ table: "loads", id: load.id });
    }
  }
  return { cents: sum(amounts), sources };
}
