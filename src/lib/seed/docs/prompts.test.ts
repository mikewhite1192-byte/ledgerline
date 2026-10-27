import { describe, expect, it } from "vitest";
import { receiptLines } from "./documents";
import { SAMPLE_DOCS, isPhoto } from "./manifest";
import { BACKGROUND_PROMPT, LINES_INTRO, PLACEMENT, PROMPT_END, imagePrompt } from "./prompts";

// A prompt is the fixed template plus the receipt's lines, and every line is built from manifest
// strings: strip the template and only the lines are left.

describe("image prompts", () => {
  it.each(SAMPLE_DOCS.filter(isPhoto).map((d) => [d.id, d] as const))(
    "%s holds only the template and its receipt lines",
    (_id, doc) => {
      const prompt = imagePrompt(doc);
      const parts = prompt.split("\n");
      expect(parts[0]).toBe(doc.cabAngle ? PLACEMENT.cab : PLACEMENT.flat);
      expect(parts[1]).toBe(LINES_INTRO);
      expect(parts.at(-1)).toBe(PROMPT_END);
      expect(parts.slice(2, -1)).toEqual(receiptLines(doc));
      expect(parts[2]).toBe("SAMPLE");
      // Every word in a line comes from the manifest entry or the fixed receipt labels.
      const e = doc.expect;
      const known = [
        "SAMPLE",
        e.vendor,
        e.truckUnit,
        e.loadNumber ?? "",
        e.localTime ?? "",
        e.state ?? "",
        doc.shows.city ?? "",
        doc.shows.plaza ?? "",
        "Lumper service",
        "Paid by driver",
        "Diesel prepaid",
        "Fleet card",
        "Load",
        "Truck",
        "Date",
        "Total",
        "Toll",
        "Diesel",
        "gal",
        "Price",
        "/gal",
        ",",
      ].filter((s) => s !== "");
      for (const line of receiptLines(doc)) {
        let rest = line.replace(/\$[\d,]+\.\d{2,3}|\d{2}\/\d{2}\/\d{4}|\d+\.\d{3}/g, " ");
        for (const k of [...known].sort((a, b) => b.length - a.length)) {
          rest = rest.split(k).join(" ");
        }
        expect(rest.trim(), `${doc.id}: "${line}"`).toBe("");
      }
      expect(prompt.length).toBeLessThanOrEqual(4000);
      expect(prompt).toMatch(/^[\x20-\x7e\n]+$/);
    },
  );

  it("ends every prompt with the no-logos line", () => {
    expect(BACKGROUND_PROMPT.endsWith(PROMPT_END)).toBe(true);
    expect(PROMPT_END).toBe("No logos, no brand names, no other text.");
  });
});
