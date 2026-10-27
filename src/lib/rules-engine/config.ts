import { MAX_STORED_CENTS, BPS } from "./money";
import {
  assertDate,
  assertId,
  assertOneOf,
  ConfigError,
  INSURANCE_APPLIES_TO,
  InputError,
  PERCENT_BASES,
  WORKER_TYPES,
  type Cents,
  type DriverRecord,
  type PayConfig,
} from "./types";

// A tenant's pay rules come from its `pay_configs` row. The table's CHECKs enforce the ranges,
// and this re-checks every column at load, so a hand-edited row never reaches the math.

function intIn(value: unknown, lo: number, hi: number, key: string): number {
  if (value === undefined || value === null) throw new ConfigError(`${key} is missing`);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ConfigError(`${key} is not a whole number`);
  }
  if (value < lo || value > hi) throw new ConfigError(`${key} is out of range`);
  return value;
}

function centsIn(value: unknown, key: string): Cents {
  return intIn(value, 0, MAX_STORED_CENTS, key) as Cents;
}

function bpsIn(value: unknown, key: string): number {
  return intIn(value, 0, BPS, key);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  if (value === undefined || value === null) throw new ConfigError(`${key} is missing`);
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${key} is not a known value`);
  }
  return value as T;
}

// The engine's own check, run by every entry point on the config it is handed.
export function assertPayConfig(config: PayConfig | null | undefined): PayConfig {
  if (!config || typeof config !== "object") throw new ConfigError("pay config is missing");
  return {
    weekStartDow: intIn(config.weekStartDow, 0, 6, "weekStartDow"),
    percentBase: oneOf(config.percentBase, PERCENT_BASES, "percentBase"),
    emptyMilesPaidBps: bpsIn(config.emptyMilesPaidBps, "emptyMilesPaidBps"),
    accessorialDriverShareBps: bpsIn(config.accessorialDriverShareBps, "accessorialDriverShareBps"),
    insuranceAppliesTo: oneOf(
      config.insuranceAppliesTo,
      INSURANCE_APPLIES_TO,
      "insuranceAppliesTo",
    ),
    insurancePerDayCents: centsIn(config.insurancePerDayCents, "insurancePerDayCents"),
    escrowTargetCents: centsIn(config.escrowTargetCents, "escrowTargetCents"),
    escrowPerSettlementCents: centsIn(config.escrowPerSettlementCents, "escrowPerSettlementCents"),
    netPayFloorCents: centsIn(config.netPayFloorCents, "netPayFloorCents"),
    advanceRecoveryCapCents:
      config.advanceRecoveryCapCents === null
        ? null
        : centsIn(config.advanceRecoveryCapCents, "advanceRecoveryCapCents"),
    advanceFeeCents: centsIn(config.advanceFeeCents, "advanceFeeCents"),
    advanceLimitDefaultCents: centsIn(config.advanceLimitDefaultCents, "advanceLimitDefaultCents"),
    advanceMaxBpsOfEarned: bpsIn(config.advanceMaxBpsOfEarned, "advanceMaxBpsOfEarned"),
    advanceMinCents: centsIn(config.advanceMinCents, "advanceMinCents"),
    advancePerLoadBpsOfPay:
      config.advancePerLoadBpsOfPay === null
        ? null
        : bpsIn(config.advancePerLoadBpsOfPay, "advancePerLoadBpsOfPay"),
  };
}

// A `pay_configs` row as the database returns it (snake_case columns, bigint as a number).
// Columns the engine does not use (id, tenant_id, created_at) are ignored. A nullable column
// must be present as null: a column that is simply absent is a missing config.
export function parsePayConfig(row: Record<string, unknown> | null | undefined): PayConfig {
  if (!row || typeof row !== "object") throw new ConfigError("pay config is missing");
  for (const key of ["advance_recovery_cap_cents", "advance_per_load_bps_of_pay"]) {
    if (!(key in row)) throw new ConfigError(`${key} is missing`);
  }
  const cap = row.advance_recovery_cap_cents;
  const perLoad = row.advance_per_load_bps_of_pay;
  return assertPayConfig({
    weekStartDow: intIn(row.week_start_dow, 0, 6, "week_start_dow"),
    percentBase: oneOf(row.percent_base, PERCENT_BASES, "percent_base"),
    emptyMilesPaidBps: bpsIn(row.empty_miles_paid_bps, "empty_miles_paid_bps"),
    accessorialDriverShareBps: bpsIn(
      row.accessorial_driver_share_bps,
      "accessorial_driver_share_bps",
    ),
    insuranceAppliesTo: oneOf(
      row.insurance_applies_to,
      INSURANCE_APPLIES_TO,
      "insurance_applies_to",
    ),
    insurancePerDayCents: centsIn(row.insurance_per_day_cents, "insurance_per_day_cents"),
    escrowTargetCents: centsIn(row.escrow_target_cents, "escrow_target_cents"),
    escrowPerSettlementCents: centsIn(
      row.escrow_per_settlement_cents,
      "escrow_per_settlement_cents",
    ),
    netPayFloorCents: centsIn(row.net_pay_floor_cents, "net_pay_floor_cents"),
    advanceRecoveryCapCents: cap === null ? null : centsIn(cap, "advance_recovery_cap_cents"),
    advanceFeeCents: centsIn(row.advance_fee_cents, "advance_fee_cents"),
    advanceLimitDefaultCents: centsIn(
      row.advance_limit_default_cents,
      "advance_limit_default_cents",
    ),
    advanceMaxBpsOfEarned: bpsIn(row.advance_max_bps_of_earned, "advance_max_bps_of_earned"),
    advanceMinCents: centsIn(row.advance_min_cents, "advance_min_cents"),
    advancePerLoadBpsOfPay:
      perLoad === null ? null : bpsIn(perLoad, "advance_per_load_bps_of_pay"),
  });
}

// A driver's rate is pay configuration too: the one matching the pay basis must be present and
// in range, or the driver's pay is not computed.
export type DriverRate =
  | { basis: "per_mile"; perMileCents: Cents }
  | { basis: "percent"; percentBps: number }
  | { basis: "flat"; flatPerLoadCents: Cents };

export function driverRate(driver: DriverRecord): DriverRate {
  const where = `driver ${driver.id}`;
  switch (driver.payBasis) {
    case "per_mile":
      return {
        basis: "per_mile",
        perMileCents: centsIn(driver.perMileCents, `${where} perMileCents`),
      };
    case "percent":
      return { basis: "percent", percentBps: bpsIn(driver.percentBps, `${where} percentBps`) };
    case "flat":
      return {
        basis: "flat",
        flatPerLoadCents: centsIn(driver.flatPerLoadCents, `${where} flatPerLoadCents`),
      };
    default:
      throw new ConfigError(`${where} payBasis is not a known value`);
  }
}

// The driver fields the math reads: id, worker type, the insurance flag, dates and the rate for
// the pay basis.
export function checkDriver(driver: DriverRecord | null | undefined): DriverRecord {
  if (!driver || typeof driver !== "object") throw new InputError("driver is missing");
  assertId(driver.id, "driver id");
  assertOneOf(driver.workerType, WORKER_TYPES, `driver ${driver.id} workerType`);
  if (typeof driver.ownInsurance !== "boolean") {
    throw new InputError(`driver ${driver.id} ownInsurance is not a boolean`);
  }
  assertDate(driver.activeFrom, `driver ${driver.id} activeFrom`);
  if (driver.activeTo !== null) assertDate(driver.activeTo, `driver ${driver.id} activeTo`);
  if (typeof driver.moneyArmed !== "boolean") {
    throw new InputError(`driver ${driver.id} moneyArmed is not true or false`);
  }
  driverRate(driver);
  return driver;
}

// One place, so the paystub's insurance line and the day-not-driven check always agree: a driver
// who carries their own insurance is never charged and never produces that finding.
export function insuranceApplies(config: PayConfig, driver: DriverRecord): boolean {
  if (driver.ownInsurance) return false;
  return config.insuranceAppliesTo === "all" || driver.workerType === "owner_operator";
}

export function advanceLimitOf(config: PayConfig, driver: DriverRecord): Cents {
  return driver.advanceLimitCents === null
    ? config.advanceLimitDefaultCents
    : centsIn(driver.advanceLimitCents, `driver ${driver.id} advanceLimitCents`);
}
