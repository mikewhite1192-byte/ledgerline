import { describe, expect, it } from "vitest";
import { CLIP_FORMAT, CLIP_PROMPT, parseClipReading } from "./schema";

// A reading of the synthetic dock clip: burned-in clock, the seeded load's BOL and invented seal.
const GOOD = {
  arrival: { clockText: "04:05:12 AM", dateText: "10/22/2026", atSeconds: 1.04, confidence: "high" },
  departure: { clockText: "11:25:03 AM", dateText: "10/22/2026", atSeconds: 16.5, confidence: "high" },
  bolNumber: { value: "BR-L10216", atSeconds: 8.2, confidence: "high" },
  sealNumber: { value: "SL-482113", atSeconds: 9, confidence: "medium" },
  doorText: "RECEIVING DOOR 7",
};
const text = (v: unknown) => JSON.stringify(v);

describe("parseClipReading", () => {
  it("keeps a reading that follows the format, with seconds to a tenth", () => {
    const parsed = parseClipReading(text(GOOD), 18_000);
    expect(parsed).toEqual({
      ok: true,
      reading: { ...GOOD, arrival: { ...GOOD.arrival, atSeconds: 1 } },
    });
    const empty = { arrival: null, departure: null, bolNumber: null, sealNumber: null, doorText: null };
    expect(parseClipReading(text(empty), 18_000)).toEqual({ ok: true, reading: empty });
  });

  it("refuses text that is not JSON, or not this shape, by category only", () => {
    expect(parseClipReading("The clock says 4:05", 18_000)).toEqual({ ok: false, category: "not_json" });
    expect(parseClipReading(text([GOOD]), 18_000)).toEqual({ ok: false, category: "shape" });
    expect(parseClipReading(text({ ...GOOD, driverName: "X" }), 18_000)).toEqual({ ok: false, category: "shape" });
    const missing: Record<string, unknown> = { ...GOOD };
    delete missing.doorText;
    expect(parseClipReading(text(missing), 18_000)).toEqual({ ok: false, category: "shape" });
    expect(parseClipReading(text({ ...GOOD, arrival: { ...GOOD.arrival, note: "x" } }), 18_000)).toEqual({
      ok: false,
      category: "shape",
    });
    expect(parseClipReading(text({ ...GOOD, arrival: { ...GOOD.arrival, atSeconds: "1" } }), 18_000)).toEqual({
      ok: false,
      category: "shape",
    });
  });

  it("refuses a value outside its pattern or past the end of the clip", () => {
    const cases = [
      { ...GOOD, arrival: { ...GOOD.arrival, clockText: "about four" } },
      { ...GOOD, arrival: { ...GOOD.arrival, dateText: "Oct 22" } },
      { ...GOOD, arrival: { ...GOOD.arrival, confidence: "certain" } },
      { ...GOOD, arrival: { ...GOOD.arrival, atSeconds: 18.5 } },
      { ...GOOD, arrival: { ...GOOD.arrival, atSeconds: -1 } },
      { ...GOOD, bolNumber: { ...GOOD.bolNumber, value: "bol 10216" } },
      { ...GOOD, sealNumber: { ...GOOD.sealNumber, value: "SL" } },
      { ...GOOD, doorText: "Receiving door 7, ask for Sam" },
    ];
    for (const c of cases) expect(parseClipReading(text(c), 18_000), text(c)).toEqual({ ok: false, category: "value" });
  });

  it("asks for no person and no free text in the format and the prompt", () => {
    const fields = Object.keys((CLIP_FORMAT.schema as { properties: object }).properties);
    expect(fields).toEqual(["arrival", "departure", "bolNumber", "sealNumber", "doorText"]);
    expect(CLIP_PROMPT).toContain("never report a person or a name");
  });
});
