import { describe, expect, it } from "vitest";
import {
  formatCents,
  formatGallons,
  formatPricePerGallon,
  localStamp,
  localStampText,
  mmddyyyy,
  receiptLines,
  timeZoneOf,
} from "./documents";
import { SAMPLE_DOCS, isPhoto, type PhotoDoc } from "./manifest";

const photo = (id: string) => SAMPLE_DOCS.find((d) => d.id === id) as PhotoDoc;

describe("document text", () => {
  it("formats cents, gallons, prices and dates exactly", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(17500)).toBe("$175.00");
    expect(formatCents(28640)).toBe("$286.40");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatGallons(71600)).toBe("71.600");
    expect(formatGallons(95005)).toBe("95.005");
    expect(formatPricePerGallon(400)).toBe("$4.000");
    expect(formatPricePerGallon(385)).toBe("$3.850");
    expect(mmddyyyy("2026-10-27")).toBe("10/27/2026");
    expect(() => formatCents(1.5)).toThrow();
    expect(() => formatCents(-1)).toThrow();
    expect(() => mmddyyyy("10/27/2026")).toThrow();
  });

  it("shows an instant in the carrier's zone, with plain spaces", () => {
    // 2026-10-27 is still daylight time in New York (EDT, UTC-4).
    expect(localStamp("2026-10-27T18:20:00.000Z", "America/New_York")).toEqual({
      date: "10/27/2026",
      time: "2:20 PM",
      zone: "EDT",
    });
    expect(localStampText("2026-10-21T11:40:00.000Z", "America/New_York")).toBe(
      "10/21/2026 7:40 AM EDT",
    );
    // Midnight UTC is the evening before in New York.
    expect(localStampText("2026-10-14T00:05:00.000Z", "America/New_York")).toBe(
      "10/13/2026 8:05 PM EDT",
    );
    expect(localStampText("2026-10-25T15:00:00.000Z", "America/Chicago")).toBe(
      "10/25/2026 10:00 AM CDT",
    );
    // After the change back on November 1, 2026.
    expect(localStampText("2026-11-02T13:00:00.000Z", "America/New_York")).toBe(
      "11/02/2026 8:00 AM EST",
    );
    expect(localStampText("2026-10-27T18:20:00.000Z", "America/New_York")).toMatch(
      /^[\x20-\x7e]+$/,
    );
    expect(() => localStamp("2026-10-27T18:20:00", "America/New_York")).toThrow();
    expect(timeZoneOf("prairie-wind")).toBe("America/Chicago");
  });

  it("builds each receipt's lines, SAMPLE first", () => {
    expect(receiptLines(photo("br-l10262-lumper"))).toEqual([
      "SAMPLE",
      "Dock Services",
      "Lumper service",
      "Load BR-L10262",
      "Truck BR-T124",
      "Date 10/27/2026",
      "Total $175.00",
      "Paid by driver",
    ]);
    expect(receiptLines(photo("br-l10247-toll"))).toEqual([
      "SAMPLE",
      "Sample Turnpike Authority",
      "Plaza 12",
      "Date 10/26/2026",
      "Truck BR-T107",
      "Toll $45.00",
    ]);
    expect(receiptLines(photo("br-item-218-fuel"))).toEqual([
      "SAMPLE",
      "Roadside Fuel Stop",
      "Date 10/29/2026",
      "Truck BR-T107",
      "Diesel prepaid",
      "Total $100.00",
    ]);
    expect(receiptLines(photo("br-fuel-418"))).toEqual([
      "SAMPLE",
      "Roadside Fuel Stop",
      "Lake City, FL",
      "Date 10/29/2026 6:29 AM",
      "Truck BR-T112",
      "Diesel 103.000 gal",
      "Price $4.000/gal",
      "Total $412.00",
      "Fleet card",
    ]);
    for (const d of SAMPLE_DOCS.filter(isPhoto)) expect(receiptLines(d)[0]).toBe("SAMPLE");
  });
});
