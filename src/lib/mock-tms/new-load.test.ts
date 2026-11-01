import { describe, expect, it } from "vitest";
import { centsOf, datesFit, parseNewLoad } from "./new-load";

// The New load form's reader: every value checked for shape, money in whole cents by string,
// dates checked against the carrier's today. Pure: no database, no clock.

const GOOD: Record<string, string> = {
  loadNumber: " new-1001 ",
  customer: "CUST-1",
  pickupName: "Sample Dock",
  pickupCity: "Joliet",
  pickupState: "il",
  pickupOn: "2026-10-31",
  deliveryName: "Sample Yard",
  deliveryCity: "Gary",
  deliveryState: "IN",
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
  it("reads a good form: the number and states uppercased, the rate in whole cents, no fuel and no driver", () => {
    expect(parseNewLoad(form())).toEqual({
      loadNumber: "NEW-1001",
      customerCode: "CUST-1",
      pickup: { name: "Sample Dock", city: "Joliet", state: "IL", on: "2026-10-31" },
      delivery: { name: "Sample Yard", city: "Gary", state: "IN", on: "2026-11-01" },
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
      { pickupName: "" },
      { pickupCity: "1 Joliet" },
      { pickupState: "ILL" },
      { deliveryState: "" },
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

  it("takes a pickup from seven days back to fourteen ahead, and a delivery on or after it, at most fourteen days later", () => {
    const today = "2026-11-01";
    expect(datesFit("2026-10-25", "2026-10-25", today)).toBe(true);
    expect(datesFit("2026-10-24", "2026-10-25", today)).toBe(false);
    expect(datesFit("2026-11-15", "2026-11-29", today)).toBe(true);
    expect(datesFit("2026-11-16", "2026-11-16", today)).toBe(false);
    expect(datesFit("2026-10-31", "2026-10-30", today)).toBe(false);
    expect(datesFit("2026-10-31", "2026-11-14", today)).toBe(true);
    expect(datesFit("2026-10-31", "2026-11-15", today)).toBe(false);
  });
});
