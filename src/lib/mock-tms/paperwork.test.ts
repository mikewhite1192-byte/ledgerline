import { describe, expect, it } from "vitest";
import { parseRead } from "../documents/schema";
import { CONFIDENCE_FIELDS } from "../documents/types";
import { paperworkOf, stampInstant, type PaperDocument } from "../loads/paperwork";
import { renderPdfContent } from "../seed/docs/pdf";
import { textRuns, type PdfContent } from "../seed/docs/documents";
import { paperContentFor, paperDatesFor, paperFilename, stageOf, type PaperLoad, type PaperStage, type PaperTimes } from "./paperwork";

const ZONE = "America/Chicago";
// Tue Nov 3, 2026: Central time is UTC-6 (daylight saving ended Nov 1).
const at = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 10, 3, hh + 6, mm, ss);
const LOAD_ID = "11111111-1111-4111-8111-111111111111";

const LOAD: PaperLoad = {
  id: LOAD_ID,
  loadNumber: "BR-L10417",
  status: "planned",
  pickupOn: "2026-11-03",
  pickupDepartedAt: null,
  origin: { city: "Joliet", state: "IL" },
  destination: { city: "Columbus", state: "OH" },
  customer: { name: "Test Shipper", city: "Springfield", state: "IL" },
  carrierName: "Sample Carrier",
  driverCode: "DRV-1",
  driverFirstName: "Dana",
  truckUnit: "T-101",
  zone: ZONE,
};

const dates = (stage: PaperStage, over: Partial<{ pickupOn: string; pickupDepartedAt: string | null }>, nowMs: number) =>
  paperDatesFor(stage, { pickupOn: LOAD.pickupOn, pickupDepartedAt: null, ...over }, nowMs, ZONE);

const timesOf = (stage: PaperStage, over: Partial<{ pickupOn: string; pickupDepartedAt: string | null }>, nowMs: number): PaperTimes => {
  const d = dates(stage, over, nowMs);
  if (!d.ok) throw new Error(`no paper dates: ${d.reason}`);
  return d.times;
};

const iso = (ms: number) => new Date(ms).toISOString();

describe("stageOf", () => {
  it("sends pickup paper for a planned load, delivery paper in transit, and nothing after", () => {
    expect(stageOf("planned")).toBe("pickup");
    expect(stageOf("in_transit")).toBe("delivery");
    for (const s of ["delivered", "invoiced", "cancelled", "other"]) expect(stageOf(s)).toBeNull();
  });
});

describe("paperDatesFor", () => {
  it("dates a pickup today at the fixed clock once that clock has passed", () => {
    expect(dates("pickup", {}, at(9, 0))).toEqual({
      ok: true,
      times: { date: "2026-11-03", arrivedAt: iso(at(7, 40)), departedAt: iso(at(8, 5)) },
    });
  });

  it("uses the early clock, 12:01 to 12:19 AM, when the fixed clock is still ahead today", () => {
    expect(dates("pickup", {}, at(7, 0, 42))).toEqual({
      ok: true,
      times: { date: "2026-11-03", arrivedAt: iso(at(0, 1)), departedAt: iso(at(0, 19)) },
    });
  });

  it("gives the same times to every tap before the fixed clock that day, whatever the minute", () => {
    for (const stage of ["pickup", "delivery"] as const) {
      const first = dates(stage, {}, at(0, 19));
      expect(first.ok).toBe(true);
      for (const later of [at(0, 25), at(6, 3, 17), at(7, 59, 59)]) expect(dates(stage, {}, later)).toEqual(first);
    }
    const left = { pickupDepartedAt: iso(at(8, 5)) };
    const delivery = dates("delivery", left, at(9, 0));
    for (const later of [at(9, 7, 30), at(13, 49), at(14, 13, 59)]) expect(dates("delivery", left, later)).toEqual(delivery);
  });

  it("dates an old load's pickup on the last day the window allows", () => {
    expect(timesOf("pickup", { pickupOn: "2026-10-20" }, at(9, 0)).date).toBe("2026-10-22");
  });

  it("allows a pickup a day early and refuses one further ahead", () => {
    expect(timesOf("pickup", { pickupOn: "2026-11-04" }, at(9, 0)).date).toBe("2026-11-03");
    expect(dates("pickup", { pickupOn: "2026-11-05" }, at(9, 0))).toEqual({ ok: false, reason: "not_due" });
  });

  it("dates a delivery on min(today, pickup + 14 days) and never before the pickup date", () => {
    expect(timesOf("delivery", { pickupOn: "2026-10-01" }, at(9, 0))).toEqual({
      date: "2026-10-15",
      arrivedAt: new Date(Date.UTC(2026, 9, 15, 18, 50)).toISOString(),
      departedAt: new Date(Date.UTC(2026, 9, 15, 19, 14)).toISOString(),
    });
    expect(timesOf("delivery", { pickupOn: "2026-10-30" }, at(15, 0))).toMatchObject({ date: "2026-11-03", departedAt: iso(at(14, 14)) });
    expect(dates("delivery", { pickupOn: "2026-11-04" }, at(9, 0))).toEqual({ ok: false, reason: "not_due" });
  });

  it("starts a same day delivery after the pickup left", () => {
    expect(timesOf("delivery", { pickupDepartedAt: iso(at(8, 5)) }, at(9, 0))).toEqual({
      date: "2026-11-03",
      arrivedAt: iso(at(8, 6)),
      departedAt: iso(at(8, 6)),
    });
    expect(timesOf("delivery", { pickupDepartedAt: iso(at(8, 50, 30)) }, at(9, 0))).toEqual({
      date: "2026-11-03",
      arrivedAt: iso(at(8, 52)),
      departedAt: iso(at(8, 52)),
    });
    expect(timesOf("delivery", { pickupDepartedAt: iso(at(14, 0)) }, at(15, 0))).toEqual({
      date: "2026-11-03",
      arrivedAt: iso(at(14, 1)),
      departedAt: iso(at(14, 14)),
    });
    expect(dates("delivery", { pickupDepartedAt: iso(at(8, 59, 30)) }, at(9, 0, 10))).toEqual({ ok: false, reason: "too_soon" });
  });

  it("refuses a paper whose times would fall on the day before (just after midnight)", () => {
    expect(dates("pickup", {}, at(0, 10))).toEqual({ ok: false, reason: "too_soon" });
  });
});

describe("paperContentFor", () => {
  const values = (c: PdfContent) => Object.fromEntries(c.fields.map((f) => [f.label, f.value]));

  it("prints the whole load number, one date and only the pickup stop on the pickup paper", () => {
    const times = timesOf("pickup", {}, at(9, 0));
    const c = paperContentFor(LOAD, "pickup", times);
    expect(c.title).toBe("Bill of Lading");
    expect(values(c)).toEqual({
      Load: "BR-L10417",
      Shipper: "Joliet, IL",
      Consignee: "Columbus, OH",
      "Bill to": "Test Shipper, Springfield, IL",
      Carrier: "Sample Carrier",
      Truck: "T-101",
      Driver: "DRV-1",
      "Pickup date": "11/03/2026",
      Commodity: "General freight",
    });
    expect(c.fields.filter((f) => f.label.endsWith("date"))).toHaveLength(1);
    expect(c.stops).toEqual([
      { label: "Pickup arrived", value: "11/03/2026 7:40 AM CST" },
      { label: "Pickup departed", value: "11/03/2026 8:05 AM CST" },
    ]);
    expect(c.signatures).toEqual(["Shipper signature", "Driver signature"]);
    expect(c.charges).toEqual([]);
  });

  it("prints only the delivery stop and the consignee's signature on the delivery paper, and leaves out an unknown truck", () => {
    const times = timesOf("delivery", { pickupOn: "2026-10-30" }, at(15, 0));
    const c = paperContentFor({ ...LOAD, truckUnit: null, driverCode: null }, "delivery", times);
    const v = values(c);
    expect(v["Delivery date"]).toBe("11/03/2026");
    expect(v["Pickup date"]).toBeUndefined();
    expect(v.Truck).toBeUndefined();
    expect(v.Driver).toBeUndefined();
    expect(c.stops.map((s) => s.label)).toEqual(["Delivery arrived", "Delivery departed"]);
    expect(c.stops.map((s) => s.value)).toEqual(["11/03/2026 1:50 PM CST", "11/03/2026 2:14 PM CST"]);
    expect(c.signatures).toEqual(["Driver signature", "Received by (consignee)"]);
  });

  it("prints stamps the paperwork rules read back to the same instants", () => {
    const times = timesOf("pickup", {}, at(7, 0));
    const c = paperContentFor(LOAD, "pickup", times);
    expect(stampInstant(c.stops[0].value, ZONE)).toBe(times.arrivedAt);
    expect(stampInstant(c.stops[1].value, ZONE)).toBe(times.departedAt);
  });

  it("names the file by the load and the stage, inside the documents filename rule", () => {
    expect(paperFilename("BR-L10417", "pickup")).toBe("driver-BR-L10417-pickup.pdf");
    expect(paperFilename("BR-L10417", "delivery")).toMatch(/^[A-Za-z0-9._ -]{1,120}$/);
  });
});

// What a faithful read of each paper looks like, through the real parser, into the paperwork rules.
function readingOf(c: PdfContent, stage: PaperStage): string {
  const v = Object.fromEntries(c.fields.map((f) => [f.label, f.value]));
  return JSON.stringify({
    document_kind: "bill_of_lading",
    sample_word: true,
    vendor: null,
    date_mmddyyyy: v["Pickup date"] ?? v["Delivery date"],
    total_cents: null,
    load_number: v.Load,
    truck_unit: v.Truck ?? null,
    gallons_milli: null,
    price_cents: null,
    loaded_miles: null,
    rate_per_mile_cents: null,
    linehaul_cents: null,
    fuel_surcharge_cents: null,
    customer_name: "Test Shipper",
    stops: [{ role: stage, arrived: c.stops[0].value, departed: c.stops[1].value }],
    text_lines: textRuns(c).slice(0, 10),
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])),
  });
}

function docOf(c: PdfContent, stage: PaperStage, id: string, createdAt: string): PaperDocument {
  const read = parseRead(readingOf(c, stage));
  if (read === null) throw new Error("reading did not parse");
  return {
    id,
    readStatus: "read",
    kind: "bill_of_lading",
    read,
    match: {
      found: true,
      table: "loads",
      id: LOAD_ID,
      humanRef: LOAD.loadNumber,
      loadId: LOAD_ID,
      driverId: null,
      fields: [{ name: "load_number", claim: LOAD.loadNumber, record: LOAD.loadNumber, status: "same" }],
      notes: [],
      supports: null,
    },
    createdAt,
  };
}

describe("the paperwork rules on these papers", () => {
  const paperLoad = { id: LOAD_ID, pickup_on: "2026-11-03", linehaul_cents: null };
  const pickupTimes = timesOf("pickup", {}, at(9, 0));
  const deliveryTimes = timesOf("delivery", { pickupDepartedAt: pickupTimes.departedAt }, at(15, 0));
  const pickup = docOf(paperContentFor(LOAD, "pickup", pickupTimes), "pickup", "00000000-0000-4000-8000-000000000001", iso(at(9, 0)));
  const delivery = docOf(paperContentFor(LOAD, "delivery", deliveryTimes), "delivery", "00000000-0000-4000-8000-000000000002", iso(at(15, 0)));

  it("counts the pickup paper as the pickup bill of lading", () => {
    expect(paperworkOf(paperLoad, [pickup])).toMatchObject({ pickupBol: pickup.id, pod: null, pickupIn: true, deliveryIn: false });
  });

  it("counts the delivery paper alone as the proof of delivery", () => {
    expect(paperworkOf(paperLoad, [delivery])).toMatchObject({ pickupBol: null, pod: delivery.id, deliveryIn: true });
  });

  it("counts both, each as its own paper", () => {
    expect(paperworkOf(paperLoad, [delivery, pickup])).toMatchObject({ pickupBol: pickup.id, pod: delivery.id });
  });
});

describe("the rendered paper", () => {
  it("is the same bytes for the same load, stage and times, and different for the other stage", async () => {
    const times = timesOf("pickup", {}, at(9, 0));
    const info = { title: "Bill of Lading BR-L10417 (SAMPLE)" };
    const a = await renderPdfContent(paperContentFor(LOAD, "pickup", times), info);
    const b = await renderPdfContent(paperContentFor(LOAD, "pickup", times), info);
    const c = await renderPdfContent(paperContentFor(LOAD, "delivery", timesOf("delivery", {}, at(15, 0))), info);
    expect(a.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Buffer.compare(a, b)).toBe(0);
    expect(Buffer.compare(a, c)).not.toBe(0);
  });

  it("is the same bytes for a same day paper tapped at different minutes before the fixed clock", async () => {
    const info = { title: "Bill of Lading BR-L10417 (SAMPLE)" };
    const a = await renderPdfContent(paperContentFor(LOAD, "pickup", timesOf("pickup", {}, at(6, 2))), info);
    const b = await renderPdfContent(paperContentFor(LOAD, "pickup", timesOf("pickup", {}, at(6, 47, 31))), info);
    expect(Buffer.compare(a, b)).toBe(0);
  });
});
