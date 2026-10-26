import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import key from "./harrow-flats-pay-policy.expected.json";

// The sample policy is for an invented carrier, and its answer key must agree with its text:
// every section the key cites exists, and every dollar amount the key holds is written in the
// section it cites. A text edit that drifts from the key fails here, before the PDF is rendered.

const TEXT = readFileSync(join(__dirname, "harrow-flats-pay-policy.md"), "utf8");

// Numbered paragraphs ("6.2 Escrow is ...") by number, lines joined.
const SECTIONS = new Map(
  TEXT.split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .flatMap((p) => {
      const m = /^(\d+\.\d+) (.*)$/.exec(p);
      return m ? [[m[1], m[2]] as const] : [];
    }),
);

// 1050 -> "$10.50", 250000 -> "$2,500", 300 -> "$3".
function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString("en-US");
  return cents % 100 === 0 ? `$${whole}` : `$${whole}.${String(cents % 100).padStart(2, "0")}`;
}

describe("the sample pay policy", () => {
  it("has ten numbered sections in order, says SAMPLE and says the carrier is invented", () => {
    const headings = TEXT.split("\n").filter((l) => /^# \d+\. /.test(l));
    expect(headings.map((h) => Number(/^# (\d+)\./.exec(h)![1]))).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    expect(TEXT).toMatch(/^SAMPLE\. Harrow Flats Trucking is a fictitious carrier/m);
  });

  it("is plain ASCII with no em or en dashes, so the built-in font renders every character", () => {
    expect(TEXT).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("writes every amount in the answer key in the section the key cites", () => {
    const entries = [
      ...Object.entries(key.config),
      ...Object.entries(key.customerDefaults),
      ["effectiveFrom", key.effectiveFrom] as const,
    ];
    for (const [field, { value, section }] of entries) {
      const text = SECTIONS.get(section);
      expect(text, `${field} cites ${section}`).toBeDefined();
      if (field.endsWith("Cents") && typeof value === "number") {
        expect(text, field).toContain(dollars(value));
      }
    }
  });

  it("flags the net pay floor, written two ways in two sections", () => {
    expect(key.config.netPayFloorCents.value).toBe(35_000);
    expect(key.flags).toEqual([
      {
        field: "netPayFloorCents",
        kind: "conflicting_values",
        sections: ["6.2", "9.4"],
        values: [35_000, 30_000],
      },
    ]);
    expect(SECTIONS.get("6.2")).toContain("weekly net pay under $350");
    expect(SECTIONS.get("9.4")).toContain("weekly net pay under $300");
  });
});
