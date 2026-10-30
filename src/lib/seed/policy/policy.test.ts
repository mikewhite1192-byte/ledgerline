import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { looksLike, pdfPages } from "../../ai/providers/media";
import { SAMPLE_POLICY_PDFS } from "../../policy-onboard/samples.generated";
import cedar from "./cedar-bend-pay-policy.expected.json";
import harrow from "./harrow-flats-pay-policy.expected.json";

// The sample policies are for invented carriers, and each answer key must agree with its text:
// every section the key cites exists, and every dollar amount the key holds is written in the
// section it cites. A text edit that drifts from its key fails here, and the rendered PDFs must be
// the bytes npm run policy:pdf writes, both in public/ and in the sample route's module.

type Key = {
  source: string;
  carrier: { name: string };
  effectiveFrom: { value: string; section: string };
  config: Record<string, { value: number | string | null; section: string }>;
  customerDefaults: Record<string, { value: number; section: string }>;
};

const SAMPLES: readonly { name: string; key: Key }[] = [
  { name: "harrow-flats-pay-policy", key: harrow },
  { name: "cedar-bend-pay-policy", key: cedar },
];

const textOf = (name: string) => readFileSync(join(__dirname, `${name}.md`), "utf8");

// Numbered paragraphs ("6.2 Escrow is ...") by number, lines joined.
function sectionsOf(text: string): Map<string, string> {
  return new Map(
    text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
      .flatMap((p) => {
        const m = /^(\d+\.\d+) (.*)$/.exec(p);
        return m ? [[m[1], m[2]] as const] : [];
      }),
  );
}

// 1050 -> "$10.50", 250000 -> "$2,500", 300 -> "$3".
function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString("en-US");
  return cents % 100 === 0 ? `$${whole}` : `$${whole}.${String(cents % 100).padStart(2, "0")}`;
}

describe.each(SAMPLES)("the sample pay policy $name", ({ name, key }) => {
  const TEXT = textOf(name);
  const SECTIONS = sectionsOf(TEXT);

  it("has ten numbered sections in order, says SAMPLE and says the carrier is invented", () => {
    expect(key.source).toBe(`${name}.md`);
    const headings = TEXT.split("\n").filter((l) => /^# \d+\. /.test(l));
    expect(headings.map((h) => Number(/^# (\d+)\./.exec(h)![1]))).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    expect(TEXT.startsWith(`SAMPLE. ${key.carrier.name} is a fictitious carrier`, TEXT.indexOf("\n\n") + 2)).toBe(true);
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

  it("renders to a small PDF of at most three pages, the same bytes in public/ and the sample module", () => {
    const file = readFileSync(join(process.cwd(), "public", "samples", "policy", `${name}.pdf`));
    const bytes = new Uint8Array(file);
    expect(looksLike("application/pdf", bytes)).toBe(true);
    expect(bytes.byteLength).toBeLessThan(60 * 1024);
    expect(pdfPages(bytes)).toBeLessThanOrEqual(3);
    expect(SAMPLE_POLICY_PDFS[name]).toBe(file.toString("base64"));
  });
});

describe("the samples' planted questions", () => {
  it("Harrow Flats writes the net pay floor two ways in two sections", () => {
    const s = sectionsOf(textOf("harrow-flats-pay-policy"));
    expect(harrow.config.netPayFloorCents.value).toBe(35_000);
    expect(harrow.flags).toEqual([
      {
        field: "netPayFloorCents",
        kind: "conflicting_values",
        sections: ["6.2", "9.4"],
        values: [35_000, 30_000],
      },
    ]);
    expect(s.get("6.2")).toContain("weekly net pay under $350");
    expect(s.get("9.4")).toContain("weekly net pay under $300");
  });

  it("Cedar Bend gives the advance fee as a range, restates insurance by the week and has no escrow", () => {
    const s = sectionsOf(textOf("cedar-bend-pay-policy"));
    expect(cedar.flags).toEqual([{ field: "advanceFeeCents", kind: "range", sections: ["7.1"], values: [300, 500] }]);
    expect(s.get("7.1")).toContain("a fee of $3 to $5");
    expect(cedar.restated).toEqual([{ field: "insurancePerDayCents", section: "5.1", perDayCents: 1_100, perWeekCents: 7_700 }]);
    expect(s.get("5.1")).toContain("$11.00 per day, billed as $77.00 per week");
    expect(cedar.notInDocument).toEqual(["escrowTargetCents", "escrowPerSettlementCents"]);
    expect([...s.values()].some((t) => /\$\d/.test(t) && /escrow/i.test(t))).toBe(false);
  });

  it("lists exactly the two rendered samples in the sample module", () => {
    expect(Object.keys(SAMPLE_POLICY_PDFS).sort()).toEqual(SAMPLES.map((x) => x.name).sort());
  });
});
