import { describe, expect, it } from "vitest";
import { advanceEligibility } from "./advances";
import { earnedUnpaid } from "./load-pay";
import { advance, BLUE_RIDGE, c, driver, load, PRAIRIE_WIND } from "./test-records";
import { ConfigError, InputError, type AdvanceInput, type AdvanceRefusal } from "./types";

// One delivered load at $1,000 linehaul and 75%: $750 earned and unpaid, so Blue Ridge's 50%
// share allows up to $375, less what is still open, against a $500 limit.
function request(over: Partial<AdvanceInput> = {}): AdvanceInput {
  return {
    config: BLUE_RIDGE,
    driver: driver(),
    amountCents: c(20_000),
    requestedAt: "2026-10-29T15:00:00Z",
    requestedOn: "2026-10-29",
    loads: [load({ id: "l1" })],
    paidPeriods: [],
    advances: [],
    ...over,
  };
}

describe("advanceEligibility", () => {
  it("approves a request inside every limit and shows the numbers behind it", () => {
    expect(advanceEligibility(request())).toEqual({
      eligible: true,
      approvedCents: 20_000,
      maxCents: 37_500,
      feeCents: 0,
      reasons: [],
      earnedUnpaidCents: 75_000,
      openCents: 0,
      limitCents: 50_000,
      sources: [
        { table: "drivers", id: "drv-1" },
        { table: "loads", id: "l1" },
      ],
    });
  });

  it.each<[string, Partial<AdvanceInput>, AdvanceRefusal[], number]>([
    [
      "a driver who left before the request",
      { driver: driver({ activeTo: "2026-10-20" }) },
      ["driver_inactive"],
      0,
    ],
    [
      "a driver who starts after the request",
      { driver: driver({ activeFrom: "2026-10-30" }) },
      ["driver_inactive"],
      0,
    ],
    ["an amount under the minimum", { amountCents: c(4_999) }, ["below_minimum"], 37_500],
    [
      "a zero amount when the tenant has no minimum",
      { config: { ...BLUE_RIDGE, advanceMinCents: c(0) }, amountCents: c(0) },
      ["below_minimum"],
      37_500,
    ],
    [
      "a driver with no delivered loads",
      { loads: [load({ id: "l1", status: "in_transit", deliveredOn: null })] },
      ["no_unpaid_earnings", "exceeds_earned_share"],
      0,
    ],
    [
      "a driver whose loads a paid settlement already covered",
      { paidPeriods: [{ start: "2026-10-26", end: "2026-11-01" }] },
      ["no_unpaid_earnings", "exceeds_earned_share"],
      0,
    ],
    [
      "a request that would take open advances past the limit",
      {
        driver: driver({ advanceLimitCents: c(30_000) }),
        advances: [advance({ id: "a1" })],
        amountCents: c(15_000),
      },
      ["over_driver_limit"],
      10_000,
    ],
    [
      "more than the share of unpaid earnings",
      { amountCents: c(37_501) },
      ["exceeds_earned_share"],
      37_500,
    ],
    [
      "the same amount as a paid advance 23 hours earlier",
      {
        amountCents: c(15_000),
        advances: [
          advance({ id: "a1", amountCents: c(15_000), requestedAt: "2026-10-28T16:00:00Z" }),
        ],
      },
      ["possible_duplicate"],
      22_500,
    ],
    [
      "the same amount as an approved advance exactly 24 hours later",
      {
        amountCents: c(15_000),
        advances: [
          advance({
            id: "a1",
            status: "approved",
            amountCents: c(15_000),
            requestedAt: "2026-10-30T15:00:00Z",
          }),
        ],
      },
      ["possible_duplicate"],
      22_500,
    ],
    [
      "every refusal at once, in the fixed order",
      {
        driver: driver({ activeTo: "2026-10-01", advanceLimitCents: c(1_000) }),
        amountCents: c(1_500),
        loads: [],
        advances: [
          advance({ id: "a1", amountCents: c(1_500), requestedAt: "2026-10-29T14:00:00Z" }),
        ],
      },
      [
        "driver_inactive",
        "below_minimum",
        "no_unpaid_earnings",
        "over_driver_limit",
        "exceeds_earned_share",
        "possible_duplicate",
      ],
      0,
    ],
  ])("refuses %s", (_name, over, reasons, maxCents) => {
    const decision = advanceEligibility(request(over));
    expect(decision.eligible).toBe(false);
    expect(decision.approvedCents).toBe(0);
    expect(decision.reasons).toEqual(reasons);
    expect(decision.maxCents).toBe(maxCents);
  });

  it("does not call a request 25 hours away, or for another amount, a duplicate", () => {
    const apart = advanceEligibility(
      request({
        amountCents: c(15_000),
        advances: [
          advance({ id: "a1", amountCents: c(15_000), requestedAt: "2026-10-28T14:00:00Z" }),
        ],
      }),
    );
    expect(apart.reasons).toEqual([]);
    const otherAmount = advanceEligibility(
      request({
        amountCents: c(15_000),
        advances: [advance({ id: "a1", amountCents: c(15_001) })],
      }),
    );
    expect(otherAmount.reasons).toEqual([]);
  });

  it("ignores requested, rejected and cancelled advances for the limit and for duplicates", () => {
    const decision = advanceEligibility(
      request({
        advances: (["requested", "rejected", "cancelled"] as const).map((status, i) =>
          advance({ id: `a${i}`, status, amountCents: c(20_000) }),
        ),
      }),
    );
    expect(decision).toMatchObject({ eligible: true, openCents: 0, reasons: [] });
    expect(decision.sources).toEqual([
      { table: "drivers", id: "drv-1" },
      { table: "loads", id: "l1" },
    ]);
  });

  it("counts only what is still owed on a partly recovered advance", () => {
    const decision = advanceEligibility(
      request({
        advances: [advance({ id: "a1", amountCents: c(40_000), recoveredCents: c(30_000) })],
        amountCents: c(15_000),
      }),
    );
    expect(decision).toMatchObject({ eligible: true, openCents: 10_000, maxCents: 27_500 });
  });

  it("cites a fully recovered duplicate even though nothing is owed on it", () => {
    const decision = advanceEligibility(
      request({ advances: [advance({ id: "a1", recoveredCents: c(20_000) })] }),
    );
    expect(decision.reasons).toEqual(["possible_duplicate"]);
    expect(decision.openCents).toBe(0);
    expect(decision.sources).toContainEqual({ table: "advances", id: "a1" });
  });

  it("counts the fee against the limit", () => {
    // Prairie Wind: 75% of $1,000 linehaul + $0 fuel surcharge = $750; 60% share = $450; fee $5.
    const tight = { config: PRAIRIE_WIND, driver: driver({ advanceLimitCents: c(20_000) }) };
    const over = advanceEligibility(request({ ...tight, amountCents: c(19_501) }));
    expect(over.reasons).toEqual(["over_driver_limit"]);
    expect(over.maxCents).toBe(19_500);
    expect(over.feeCents).toBe(500);
    const fits = advanceEligibility(request({ ...tight, amountCents: c(19_500) }));
    expect(fits).toMatchObject({ eligible: true, approvedCents: 19_500, feeCents: 500 });
  });

  it("offers nothing when the room left is under the minimum", () => {
    const decision = advanceEligibility(
      request({
        driver: driver({ advanceLimitCents: c(30_000) }),
        advances: [advance({ id: "a1", amountCents: c(26_000) })],
        amountCents: c(5_000),
      }),
    );
    expect(decision.reasons).toEqual(["over_driver_limit"]);
    expect(decision.maxCents).toBe(0);
  });

  it("counts accessorial pay as earned, and uses the tenant limit when the driver has none", () => {
    const decision = advanceEligibility(
      request({
        loads: [
          load({
            id: "l1",
            accessorials: [
              {
                id: "x1",
                kind: "detention",
                seq: 1,
                amountCents: c(5_000),
                paidByDriver: false,
                description: null,
              },
            ],
          }),
        ],
      }),
    );
    expect(decision).toMatchObject({
      earnedUnpaidCents: 80_000,
      maxCents: 40_000,
      limitCents: 50_000,
    });
    const ownLimit = advanceEligibility(
      request({ driver: driver({ advanceLimitCents: c(30_000) }) }),
    );
    expect(ownLimit).toMatchObject({ limitCents: 30_000, maxCents: 30_000 });
  });

  it("counts earlier open advances against the share, so split requests cannot beat it", () => {
    // $750 earned, $375 share, $500 limit: $300, then $75, then another $75 is past the share.
    const first = advance({
      id: "a1",
      amountCents: c(30_000),
      requestedAt: "2026-10-25T15:00:00Z",
      requestedOn: "2026-10-25",
    });
    const second = advance({
      id: "a2",
      amountCents: c(7_500),
      requestedAt: "2026-10-27T15:00:00Z",
      requestedOn: "2026-10-27",
    });
    const fits = advanceEligibility(request({ advances: [first], amountCents: c(7_500) }));
    expect(fits).toMatchObject({ eligible: true, openCents: 30_000, maxCents: 7_500 });
    const third = advanceEligibility(request({ advances: [first, second], amountCents: c(7_500) }));
    expect(third).toMatchObject({
      eligible: false,
      approvedCents: 0,
      reasons: ["exceeds_earned_share"],
      openCents: 37_500,
      maxCents: 0,
    });
  });

  it("counts only loads delivered on or before the request day", () => {
    const on = { requestedAt: "2026-10-27T15:00:00Z", requestedOn: "2026-10-27" };
    const replayed = advanceEligibility(
      request({ ...on, loads: [load({ id: "l1", deliveredOn: "2026-10-30" })] }),
    );
    expect(replayed).toMatchObject({
      eligible: false,
      earnedUnpaidCents: 0,
      maxCents: 0,
      reasons: ["no_unpaid_earnings", "exceeds_earned_share"],
    });
    const sameDay = advanceEligibility(
      request({
        ...on,
        loads: [
          load({ id: "l1", deliveredOn: "2026-10-27" }),
          load({ id: "l2", deliveredOn: "2026-10-30" }),
        ],
      }),
    );
    expect(sameDay).toMatchObject({ eligible: true, earnedUnpaidCents: 75_000 });
    expect(sameDay.sources).toEqual([
      { table: "drivers", id: "drv-1" },
      { table: "loads", id: "l1" },
    ]);
    // Read on its own, earned-unpaid needs a request day it can compare against.
    const loads = [load({ id: "l1" })];
    expect(() => earnedUnpaid(BLUE_RIDGE, driver(), loads, [], "10/27/2026")).toThrow(InputError);
  });

  it.each<[string, Partial<AdvanceInput>, typeof ConfigError | typeof InputError]>([
    [
      "a config out of range",
      { config: { ...BLUE_RIDGE, advanceMaxBpsOfEarned: 10_001 } },
      ConfigError,
    ],
    ["a fractional amount", { amountCents: 100.5 as never }, InputError],
    ["a negative amount", { amountCents: c(-100) }, InputError],
    ["a request time without a zone", { requestedAt: "2026-10-29T15:00:00" }, InputError],
    ["a request date in another spelling", { requestedOn: "10/29/2026" }, InputError],
    [
      "another driver's advance",
      { advances: [advance({ id: "a1", driverId: "drv-2" })] },
      InputError,
    ],
    ["another driver's load", { loads: [load({ id: "l1", driverId: "drv-2" })] }, InputError],
    ["the same load twice", { loads: [load({ id: "l1" }), load({ id: "l1" })] }, InputError],
    [
      "the same advance twice",
      { advances: [advance({ id: "a1" }), advance({ id: "a1" })] },
      InputError,
    ],
    [
      "a reversed paid period",
      { paidPeriods: [{ start: "2026-11-01", end: "2026-10-26" }] },
      InputError,
    ],
  ])("refuses %s", (_name, over, error) => {
    expect(() => advanceEligibility(request(over))).toThrow(error);
  });
});
