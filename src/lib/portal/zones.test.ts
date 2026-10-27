import { describe, expect, it } from "vitest";
import { instantOf, stampText, wallTime } from "./zones";

describe("zones", () => {
  it("prints a stamp in the facility's zone with its label", () => {
    expect(stampText("2026-10-20T14:05:00.000Z", "America/Chicago")).toBe("2026-10-20 09:05 CT");
    expect(stampText("2026-07-01T19:00:00.000Z", "America/Phoenix")).toBe("2026-07-01 12:00 AZ");
    expect(wallTime("2026-01-15T05:30:00.000Z", "America/New_York")).toBe("2026-01-15 00:30");
  });

  it("turns a wall time back into the one instant it names", () => {
    expect(instantOf("2026-10-20 09:05", "America/Chicago")).toBe("2026-10-20T14:05:00.000Z");
    expect(instantOf("2026-01-15 00:30", "America/New_York")).toBe("2026-01-15T05:30:00.000Z");
    expect(instantOf("2026-07-01 12:00", "America/Phoenix")).toBe("2026-07-01T19:00:00.000Z");
  });

  it("refuses a time that names no instant or two, and one that is not a time", () => {
    expect(instantOf("2026-03-08 02:30", "America/Chicago")).toBeNull();
    expect(instantOf("2026-11-01 01:30", "America/Los_Angeles")).toBeNull();
    expect(instantOf("2026-02-30 10:00", "America/Denver")).toBeNull();
    expect(instantOf("2026-10-20 24:00", "America/Denver")).toBeNull();
    expect(instantOf("Oct 20 9:05", "America/Denver")).toBeNull();
  });

  it("round-trips a spread of quarter hours across a year in every zone except the repeated hour", () => {
    for (const zone of ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix"] as const) {
      for (let ms = Date.parse("2026-01-01T00:00:00Z"); ms < Date.parse("2027-01-01T00:00:00Z"); ms += 23 * 3_600_000 + 15 * 60_000) {
        const instant = new Date(ms).toISOString();
        const back = instantOf(wallTime(instant, zone), zone);
        if (back !== null) expect(back).toBe(instant);
      }
    }
  });
});
