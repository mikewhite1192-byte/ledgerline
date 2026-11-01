import { describe, expect, it } from "vitest";
import { pickupWindowHolds, podWindowHolds } from "../loads/paperwork";
import { addDays } from "../time/local-date";
import { centsOf, datesFit, NEW_LOAD_PLACES, parseNewLoad, PICKUP_DAYS_AHEAD, PICKUP_DAYS_BACK, placeLabel } from "./new-load";

// The New load form's reader: every value checked for shape, each place from the fixed list, money
// in whole cents by string, dates checked against the carrier's today. Pure: no database, no clock.

const GOOD: Record<string, string> = {
  loadNumber: " new-1001 ",
  customer: "CUST-1",
  pickupPlace: "Joliet, IL",
  pickupOn: "2026-10-31",
  deliveryPlace: " Gary, IN ",
  deliveryOn: "2026-11-01",
  miles: "420",
  rate: "1850.5",
  fuel: "",
  driver: "",
};

const form = (over: Record<string, string | null> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ ...GOOD, ...over })) if (v !== null) f.set(k, v);
  return f;
};

describe("the new load form", () => {
  it("reads a good form: the number uppercased, each place from the list, the rate in whole cents, no fuel and no driver", () => {
    expect(parseNewLoad(form())).toEqual({
      loadNumber: "NEW-1001",
      customerCode: "CUST-1",
      pickup: { name: "Joliet Yard", city: "Joliet", state: "IL", on: "2026-10-31" },
      delivery: { name: "Gary Dock", city: "Gary", state: "IN", on: "2026-11-01" },
      loadedMiles: 420,
      linehaulCents: 185050,
      fuelSurchargeCents: 0,
      driverExternalId: null,
    });
    expect(parseNewLoad(form({ fuel: "$95.25", driver: "drv-1" }))).toMatchObject({ fuelSurchargeCents: 9525, driverExternalId: "drv-1" });
  });

  it("keeps money whole cents by string, never a float", () => {
    expect(centsOf("0.29")).toBe(29);
    expect(centsOf("1.10")).toBe(110);
    expect(centsOf("999999.99")).toBe(99_999_999);
    expect(centsOf("$12")).toBe(1200);
    for (const bad of ["", "1.234", "-5", "1e3", "1,000", "1000000", "12.", ".5", "$$1"]) expect(centsOf(bad), bad).toBeNull();
  });

  it("refuses anything outside the shapes", () => {
    const shapes: Record<string, string | null>[] = [
      { loadNumber: "X" },
      { loadNumber: "NEW 1001" },
      { loadNumber: "N".repeat(41) },
      { customer: "" },
      { customer: "cust 1" },
      { pickupPlace: "" },
      { pickupPlace: null },
      { pickupPlace: "Joliet" },
      { pickupPlace: "Joliet, IL, US" },
      { pickupPlace: "joliet, il" },
      { deliveryPlace: "Springfield, IL" },
      { deliveryPlace: "Sample Dock" },
      { pickupOn: "2026-02-30" },
      { deliveryOn: "11/01/2026" },
      { miles: "0" },
      { miles: "10000" },
      { miles: "4.5" },
      { rate: "0" },
      { rate: "" },
      { rate: "1000000" },
      { fuel: "abc" },
      { driver: "drv 1" },
      { miles: null },
    ];
    for (const over of shapes) {
      expect(parseNewLoad(form(over)), JSON.stringify(over)).toBeNull();
    }
  });

  it("offers each place once, by a label the parser reads back to that place", () => {
    const labels = NEW_LOAD_PLACES.map(placeLabel);
    expect(new Set(labels).size).toBe(NEW_LOAD_PLACES.length);
    for (const [i, label] of labels.entries()) {
      expect(parseNewLoad(form({ pickupPlace: label }))?.pickup, label).toMatchObject(NEW_LOAD_PLACES[i]);
    }
  });

  it("takes a pickup from two days back to today, and a delivery on or after it, at most fourteen days later", () => {
    const today = "2026-11-01";
    expect(datesFit("2026-10-30", "2026-10-30", today)).toBe(true);
    expect(datesFit("2026-10-29", "2026-10-30", today)).toBe(false);
    expect(datesFit("2026-11-01", "2026-11-15", today)).toBe(true);
    expect(datesFit("2026-11-02", "2026-11-02", today)).toBe(false);
    expect(datesFit("2026-10-31", "2026-10-30", today)).toBe(false);
    expect(datesFit("2026-10-31", "2026-11-14", today)).toBe(true);
    expect(datesFit("2026-10-31", "2026-11-15", today)).toBe(false);
  });

  it("keeps every pickup date it takes inside the desk's windows for a pickup and a delivery completed today", () => {
    const today = "2026-11-01";
    for (let back = -PICKUP_DAYS_AHEAD; back <= PICKUP_DAYS_BACK; back += 1) {
      const pickupOn = addDays(today, -back);
      expect(datesFit(pickupOn, pickupOn, today), pickupOn).toBe(true);
      const load = { id: "load-1", pickup_on: pickupOn, linehaul_cents: null };
      expect(pickupWindowHolds(load, today), pickupOn).toBe(true);
      expect(podWindowHolds(load, today), pickupOn).toBe(true);
    }
  });
});
