import { describe, expect, it } from "vitest";
import { advanceLimitOf, assertPayConfig, checkDriver, driverRate, parsePayConfig } from "./config";
import { BLUE_RIDGE, c, companyDriver, driver, PRAIRIE_WIND } from "./test-records";
import { ConfigError, InputError, type PayConfig } from "./types";

// A pay_configs row as the database returns it, with the columns the engine ignores.
const ROW: Record<string, unknown> = {
  tenant_id: "5b0c7d9e-1f2a-4b3c-8d4e-6f7a8b9c0d1e",
  week_start_dow: 1,
  percent_base: "linehaul",
  empty_miles_paid_bps: 0,
  accessorial_driver_share_bps: 10_000,
  insurance_applies_to: "owner_operator",
  insurance_per_day_cents: 1_100,
  escrow_target_cents: 200_000,
  escrow_per_settlement_cents: 10_000,
  net_pay_floor_cents: 30_000,
  advance_recovery_cap_cents: null,
  advance_fee_cents: 0,
  advance_limit_default_cents: 50_000,
  advance_max_bps_of_earned: 5_000,
  advance_min_cents: 5_000,
  created_at: "2026-10-26 12:00:00+00",
};

const without = (key: string) => Object.fromEntries(Object.entries(ROW).filter(([k]) => k !== key));

describe("parsePayConfig", () => {
  it("reads a row into the typed config", () => {
    expect(parsePayConfig(ROW)).toEqual(BLUE_RIDGE);
    expect(
      parsePayConfig({ ...ROW, advance_recovery_cap_cents: 25_000 }).advanceRecoveryCapCents,
    ).toBe(25_000);
  });

  it("refuses a missing row", () => {
    expect(() => parsePayConfig(null)).toThrow(ConfigError);
    expect(() => parsePayConfig(undefined)).toThrow(ConfigError);
  });

  it.each(Object.keys(ROW).filter((k) => k !== "tenant_id" && k !== "created_at"))(
    "refuses a row without %s",
    (key) => {
      expect(() => parsePayConfig(without(key))).toThrow(ConfigError);
      expect(() => parsePayConfig(without(key))).toThrow(`${key} is missing`);
    },
  );

  it.each([
    ["week_start_dow", 7],
    ["week_start_dow", -1],
    ["empty_miles_paid_bps", 10_001],
    ["accessorial_driver_share_bps", -1],
    ["advance_max_bps_of_earned", 2.5],
    ["insurance_per_day_cents", -100],
    ["net_pay_floor_cents", 1_000_000_000],
    ["escrow_target_cents", "200000"],
    ["advance_recovery_cap_cents", -1],
    ["percent_base", "gross"],
    ["insurance_applies_to", "company"],
    ["percent_base", 1],
  ])("refuses %s = %j", (key, value) => {
    expect(() => parsePayConfig({ ...ROW, [key]: value })).toThrow(ConfigError);
  });

  it("refuses a required column that is null", () => {
    expect(() => parsePayConfig({ ...ROW, advance_fee_cents: null })).toThrow(/advance_fee_cents/);
  });
});

describe("assertPayConfig", () => {
  it("accepts both demo carriers' settings", () => {
    expect(assertPayConfig(BLUE_RIDGE)).toEqual(BLUE_RIDGE);
    expect(assertPayConfig(PRAIRIE_WIND)).toEqual(PRAIRIE_WIND);
  });

  it("refuses a missing config or a field out of range", () => {
    expect(() => assertPayConfig(null)).toThrow(ConfigError);
    const bad = { ...BLUE_RIDGE, accessorialDriverShareBps: 20_000 } as PayConfig;
    expect(() => assertPayConfig(bad)).toThrow(/accessorialDriverShareBps is out of range/);
    const partial = { ...BLUE_RIDGE } as Partial<PayConfig>;
    delete partial.advanceRecoveryCapCents;
    expect(() => assertPayConfig(partial as PayConfig)).toThrow(
      /advanceRecoveryCapCents is missing/,
    );
  });
});

describe("driver rates", () => {
  it("reads the rate that matches the pay basis", () => {
    expect(driverRate(driver())).toEqual({ basis: "percent", percentBps: 7_500 });
    expect(driverRate(companyDriver())).toEqual({ basis: "per_mile", perMileCents: 62 });
    expect(
      driverRate(driver({ payBasis: "flat", percentBps: null, flatPerLoadCents: c(20_000) })),
    ).toEqual({ basis: "flat", flatPerLoadCents: 20_000 });
  });

  it("refuses a driver whose rate is missing or out of range", () => {
    expect(() => driverRate(driver({ percentBps: null }))).toThrow(ConfigError);
    expect(() => driverRate(driver({ percentBps: 10_001 }))).toThrow(ConfigError);
    expect(() => driverRate(companyDriver({ perMileCents: null }))).toThrow(ConfigError);
    const unknown = driver({ payBasis: "hourly" as never });
    expect(() => driverRate(unknown)).toThrow(ConfigError);
  });

  it("refuses a driver with an unknown worker type or a bad date", () => {
    expect(() => checkDriver(driver({ workerType: "contractor" as never }))).toThrow(InputError);
    expect(() => checkDriver(driver({ activeFrom: "2026-1-5" }))).toThrow(InputError);
    expect(() => checkDriver(null)).toThrow(InputError);
  });

  it("uses the driver's own advance limit, else the tenant default", () => {
    expect(advanceLimitOf(BLUE_RIDGE, driver())).toBe(50_000);
    expect(advanceLimitOf(BLUE_RIDGE, driver({ advanceLimitCents: c(30_000) }))).toBe(30_000);
  });
});
