import { describe, expect, it } from "vitest";
import { localDateOf } from "../time/local-date";
import {
  detentionCents,
  detentionStops,
  findUnbilledDetention,
  lastFullMonthBefore,
} from "./detention";
import { c } from "./test-records";
import { InputError, type CustomerRecord, type LoadStopsRecord } from "./types";

const OCTOBER = { start: "2026-10-01", end: "2026-10-31" };

function customer(over: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: "cust-a",
    code: "C01",
    name: "Example Customer",
    termsDays: 30,
    city: "Example City",
    state: "OH",
    detentionFreeMinutes: 120,
    detentionHourlyCents: c(7_500),
    ...over,
  };
}

// The instant `minutes` after 2026-10-14 08:00 UTC.
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 14, 8, minutes)).toISOString();

// A delivered load whose pickup takes 60 minutes and whose delivery takes `deliveryMinutes`.
function load(id: string, deliveryMinutes: number, over: Partial<LoadStopsRecord> = {}) {
  return {
    id,
    loadNumber: `L-${id}`,
    customerId: "cust-a",
    deliveredOn: "2026-10-14",
    pickupArrivedAt: at(0),
    pickupDepartedAt: at(60),
    deliveryArrivedAt: at(300),
    deliveryDepartedAt: at(300 + deliveryMinutes),
    ...over,
  };
}

describe("detentionStops", () => {
  it("bills nothing at the free time and one quarter for the first minute past it", () => {
    const [pickup, atFree] = detentionStops(load("l1", 120), customer())!;
    expect(pickup).toEqual({
      stop: "pickup",
      dwellMinutes: 60,
      overMinutes: 0,
      quarters: 0,
      cents: 0,
    });
    expect(atFree).toMatchObject({ dwellMinutes: 120, overMinutes: 0, quarters: 0, cents: 0 });
    const [, oneOver] = detentionStops(load("l1", 121), customer())!;
    expect(oneOver).toMatchObject({ overMinutes: 1, quarters: 1, cents: 1_875 });
  });

  it("counts whole minutes, so seconds short of a minute earn nothing", () => {
    const short = load("l1", 120, { deliveryDepartedAt: "2026-10-14T15:00:59.000Z" });
    expect(detentionStops(short, customer())![1]).toMatchObject({ dwellMinutes: 120, cents: 0 });
  });

  it("rounds a started quarter hour up: 320 minutes over is 22 quarters", () => {
    const [, delivery] = detentionStops(load("l1", 440), customer())!;
    expect(delivery).toMatchObject({ overMinutes: 320, quarters: 22, cents: 41_250 });
    const fifty = customer({ detentionHourlyCents: c(5_000) });
    expect(detentionCents(load("l1", 480), fifty)).toBe(30_000);
  });

  it("uses each customer's own free time and rounds a part cent half up", () => {
    const short = customer({ detentionFreeMinutes: 90, detentionHourlyCents: c(6_002) });
    // Pickup 60 minutes: free. Delivery 91 minutes: one quarter of $60.02 is 1,500.5 cents.
    expect(detentionCents(load("l1", 91), short)).toBe(1_501);
  });

  it("adds both stops together", () => {
    const slowPickup = load("l1", 135, { pickupDepartedAt: at(150) });
    // Pickup 150 minutes: 30 over, two quarters. Delivery 135 minutes: 15 over, one quarter.
    expect(detentionCents(slowPickup, customer())).toBe(5_625);
  });

  it("leaves a load with unknown times out instead of reading it as zero", () => {
    const unknown = load("l1", 440, { deliveryArrivedAt: null, deliveryDepartedAt: null });
    expect(detentionStops(unknown, customer())).toBeNull();
    expect(detentionCents(unknown, customer())).toBeNull();
  });

  it("refuses a stop with one time, a departure before arrival and another customer", () => {
    const one = load("l1", 440, { pickupDepartedAt: null });
    expect(() => detentionStops(one, customer())).toThrow(InputError);
    const backwards = load("l1", 440, { deliveryDepartedAt: at(299) });
    expect(() => detentionStops(backwards, customer())).toThrow(InputError);
    expect(() => detentionStops(load("l1", 440), customer({ id: "cust-b" }))).toThrow(InputError);
    const badTime = load("l1", 440, { deliveryArrivedAt: "2026-10-14 13:00" });
    expect(() => detentionStops(badTime, customer())).toThrow(InputError);
  });

  it("refuses customer terms out of range", () => {
    const long = customer({ detentionFreeMinutes: 601 });
    expect(() => detentionStops(load("l1", 440), long)).toThrow(InputError);
    const negative = customer({ detentionHourlyCents: c(-1) });
    expect(() => detentionStops(load("l1", 440), negative)).toThrow(InputError);
  });
});

describe("findUnbilledDetention", () => {
  it("finds earning loads with no detention charge, in load number order", () => {
    const loads = [
      load("l3", 440),
      load("l1", 121),
      load("l2", 90),
      load("l4", 440),
      load("l5", 440, { deliveryArrivedAt: null, deliveryDepartedAt: null }),
      load("l6", 440, { deliveredOn: null }),
      load("l7", 440, { customerId: null }),
    ];
    const accessorials = [
      { loadId: "l4", kind: "detention" },
      { loadId: "l3", kind: "lumper" },
    ];
    const found = findUnbilledDetention(loads, [customer()], accessorials, OCTOBER);
    expect(found.map((f) => [f.loadNumber, f.amountCents])).toEqual([
      ["L-l1", 1_875],
      ["L-l3", 41_250],
    ]);
    expect(found[1]).toMatchObject({
      loadId: "l3",
      customerId: "cust-a",
      deliveredOn: "2026-10-14",
      sources: [
        { table: "loads", id: "l3" },
        { table: "customers", id: "cust-a" },
      ],
    });
    // Only the stop that earns is listed.
    expect(found[1].stops.map((s) => s.stop)).toEqual(["delivery"]);
  });

  it("keeps the window's first and last days and nothing outside them", () => {
    const loads = ["2026-09-30", "2026-10-01", "2026-10-31", "2026-11-01"].map((on, i) =>
      load(`l${i}`, 440, { deliveredOn: on }),
    );
    const found = findUnbilledDetention(loads, [customer()], [], OCTOBER);
    expect(found.map((f) => f.deliveredOn)).toEqual(["2026-10-01", "2026-10-31"]);
  });

  it("reads the window in each tenant's own dates", () => {
    // 04:30 UTC on Nov 1 is 00:30 Nov 1 in New York and 23:30 Oct 31 in Chicago.
    const deliveredAt = "2026-11-01T04:30:00.000Z";
    const inZone = (zone: string) =>
      findUnbilledDetention(
        [load("l1", 440, { deliveredOn: localDateOf(deliveredAt, zone) })],
        [customer()],
        [],
        OCTOBER,
      ).length;
    expect(inZone("America/New_York")).toBe(0);
    expect(inZone("America/Chicago")).toBe(1);
  });

  it("refuses a load whose customer is not in the list", () => {
    const stray = load("l1", 440, { customerId: "cust-z" });
    expect(() => findUnbilledDetention([stray], [customer()], [], OCTOBER)).toThrow(InputError);
  });
});

describe("lastFullMonthBefore", () => {
  it("is the calendar month before the date's month", () => {
    expect(lastFullMonthBefore("2026-11-01")).toEqual(OCTOBER);
    expect(lastFullMonthBefore("2026-11-02")).toEqual(OCTOBER);
    expect(lastFullMonthBefore("2026-11-30")).toEqual(OCTOBER);
    expect(lastFullMonthBefore("2026-01-15")).toEqual({ start: "2025-12-01", end: "2025-12-31" });
    expect(lastFullMonthBefore("2028-03-01")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("refuses a date that is not a date", () => {
    expect(() => lastFullMonthBefore("2026-11")).toThrow(InputError);
  });
});
