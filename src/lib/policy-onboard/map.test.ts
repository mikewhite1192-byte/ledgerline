import { describe, expect, it } from "vitest";
import type { PayConfigKnobs } from "../data/rows";
import { RULE_KEYS, valueOf, valueText, type RuleKey } from "../pay-rules/rules";
import { rowsFor } from "../pay-rules/__tests__/rows";
import cedar from "../seed/policy/cedar-bend-pay-policy.expected.json";
import harrow from "../seed/policy/harrow-flats-pay-policy.expected.json";
import { mapAnswer, parseRulesAnswer, type RulesAnswer } from "./map";
import { sectionsOfTranscript, transcriptOf } from "./sections";
import { rulesAnswerFor, sampleSections, type SampleName } from "./test-fixtures";

// The propose answer for each sample, mapped against the sample's answer key: every rule the key
// states is Found with its value and section, every planted question Needs you with the values
// the document gives, every rule the document leaves out keeps the carrier's current value. A
// corrupted answer (a quote not in the document, a reading the quote does not give) demotes the
// fields it touches and never shows text the document does not hold.

type Key = {
  carrier: { name: string };
  effectiveFrom: { value: string };
  config: Record<string, { value: number | string | null; section: string }>;
  customerDefaults: Record<string, { value: number; section: string }>;
  flags: { field: string; sections: string[]; values: number[] }[];
  notInDocument?: string[];
  informational: { cents?: number; bps?: number; section: string }[];
};

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function newest(slug: "blue-ridge" | "prairie-wind"): PayConfigKnobs {
  return [...rowsFor(slug).pay_configs].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
}

function setup(name: SampleName) {
  const transcript = transcriptOf(sampleSections(name));
  const sections = sectionsOfTranscript(transcript);
  if (!sections) throw new Error("the sample transcript does not read back");
  return { transcript, sections };
}

const CASES: readonly { name: SampleName; key: Key; slug: "blue-ridge" | "prairie-wind" }[] = [
  { name: "harrow-flats-pay-policy", key: harrow, slug: "blue-ridge" },
  { name: "cedar-bend-pay-policy", key: cedar, slug: "prairie-wind" },
];

describe.each(CASES)("the propose answer for $name", ({ name, key, slug }) => {
  const base = newest(slug);
  const { transcript, sections } = setup(name);
  const mapped = mapAnswer(sections, transcript, rulesAnswerFor(name), base);

  it("finds every rule the key states, in the section it cites, unless the key flags it", () => {
    const flagged = new Set(key.flags.map((f) => snake(f.field)));
    for (const [field, { value, section }] of Object.entries(key.config)) {
      const rule = snake(field);
      if (rule === "week_start_dow" || flagged.has(rule)) continue;
      const f = mapped.fields[rule as RuleKey];
      expect(f, rule).toBeDefined();
      expect(f.state, rule).toBe("found");
      expect(f.value, rule).toBe(valueText(value));
      expect(f.passages.map((x) => x.section), rule).toEqual([section]);
      for (const passage of f.passages) expect(sections.get(passage.section)).toContain(passage.quote);
    }
  });

  it("asks a person about each flagged rule, offering exactly the values the document gives", () => {
    for (const flag of key.flags) {
      const f = mapped.fields[snake(flag.field) as RuleKey];
      expect(f.state).toBe("needs_you");
      expect(f.value).toBe(valueText(valueOf(base, snake(flag.field) as RuleKey)));
      expect((f.alternatives ?? []).map((a) => Number(a.value)).sort()).toEqual([...flag.values].sort());
      expect([...new Set(f.passages.map((x) => x.section))].sort()).toEqual([...flag.sections].sort());
    }
    expect(mapped.exceptions).toContain("needs_you");
  });

  it("keeps the current value of every rule the document does not state", () => {
    const stated = new Set([...Object.keys(key.config).map(snake), ...key.flags.map((f) => snake(f.field))]);
    const missing = RULE_KEYS.filter((k) => !stated.has(k));
    expect(missing).toEqual((key.notInDocument ?? []).map(snake));
    for (const k of missing) {
      expect(mapped.fields[k]).toEqual({ value: valueText(valueOf(base, k)), state: "not_in_document", passages: [] });
    }
  });

  it("notes the figures that are not pay rules, the week start, the date and the carrier's name", () => {
    const byKey = new Map(mapped.noted.map((n) => [n.key, Number(n.value)]));
    expect(byKey.get("detention_free_minutes")).toBe(key.customerDefaults.detentionFreeMinutes.value);
    expect(byKey.get("detention_hourly")).toBe(key.customerDefaults.detentionHourlyCents.value);
    expect(byKey.get("week_start")).toBe(key.config.weekStartDow.value);
    const informational = key.informational.map((i) => i.cents ?? i.bps);
    expect([byKey.get("per_mile"), byKey.get("per_load"), byKey.get("oo_percent")]).toEqual(informational);
    expect(mapped.weekStartDow).toBe(key.config.weekStartDow.value);
    expect(mapped.documentDate).toBe(key.effectiveFrom.value);
    expect(mapped.carrierName).toBe(key.carrier.name);
    expect(mapped.exceptions).not.toContain("week_start_differs");
  });

  it("round-trips through the answer's own parser", () => {
    expect(parseRulesAnswer(JSON.stringify(rulesAnswerFor(name)))).toEqual(rulesAnswerFor(name));
  });
});

describe("the planted questions", () => {
  it("calls Harrow Flats' two net pay floors a conflict", () => {
    const { transcript, sections } = setup("harrow-flats-pay-policy");
    const m = mapAnswer(sections, transcript, rulesAnswerFor("harrow-flats-pay-policy"), newest("blue-ridge"));
    expect(m.exceptions.sort()).toEqual(["conflicting_values", "needs_you"]);
  });

  it("keeps Cedar Bend's insurance Found because the weekly figure is 7 times the daily one, and its fee range is no conflict", () => {
    const { transcript, sections } = setup("cedar-bend-pay-policy");
    const m = mapAnswer(sections, transcript, rulesAnswerFor("cedar-bend-pay-policy"), newest("prairie-wind"));
    expect(m.fields.insurance_per_day_cents.state).toBe("found");
    expect(m.fields.insurance_per_day_cents.value).toBe("1100");
    expect(m.exceptions).toEqual(["needs_you"]);
  });

  it("asks about insurance when the weekly figure is not 7 times the daily one", () => {
    const sections = new Map([["5.1", "The carrier charges $11.00 per day, billed as $80.00 per week."]]);
    const answer = withRule(rulesAnswerFor("cedar-bend-pay-policy"), "insurance_per_day_cents", [
      { section: "5.1", quote: "The carrier charges $11.00 per day, billed as $80.00 per week", value_text: "$11.00" },
    ]);
    const m = mapAnswer(sections, "5.1 x", answer, newest("prairie-wind"));
    expect(m.fields.insurance_per_day_cents.state).toBe("needs_you");
  });

  it("says when the policy's week starts on another day than the carrier's", () => {
    const { transcript, sections } = setup("cedar-bend-pay-policy");
    const m = mapAnswer(sections, transcript, rulesAnswerFor("cedar-bend-pay-policy"), newest("blue-ridge"));
    expect(m.weekStartDow).toBe(0);
    expect(m.exceptions).toContain("week_start_differs");
  });
});

function withRule(answer: RulesAnswer, key: RuleKey, list: RulesAnswer["rules"][RuleKey]): RulesAnswer {
  return { ...answer, rules: { ...answer.rules, [key]: list } };
}

describe("a corrupted answer", () => {
  const { transcript, sections } = setup("harrow-flats-pay-policy");
  const base = newest("blue-ridge");
  const good = rulesAnswerFor("harrow-flats-pay-policy");

  it("drops a quote that is not in its section, so the rule is Not in document", () => {
    const m = mapAnswer(
      sections,
      transcript,
      withRule(good, "advance_fee_cents", [{ section: "9.1", quote: "Each advance carries a $4 fee.", value_text: "$4" }]),
      base,
    );
    expect(m.fields.advance_fee_cents).toEqual({ value: valueText(base.advance_fee_cents), state: "not_in_document", passages: [] });
  });

  it("drops a passage that names a section the read did not copy", () => {
    const m = mapAnswer(
      sections,
      transcript,
      withRule(good, "advance_fee_cents", [{ section: "9.9", quote: "Each advance carries a $3 fee.", value_text: "$3" }]),
      base,
    );
    expect(m.fields.advance_fee_cents.state).toBe("not_in_document");
  });

  it("asks a person when the model reads a value the quote does not give", () => {
    const m = mapAnswer(
      sections,
      transcript,
      withRule(good, "advance_fee_cents", [{ section: "9.1", quote: "Each advance carries a $3 fee.", value_text: "$30" }]),
      base,
    );
    expect(m.fields.advance_fee_cents.state).toBe("needs_you");
    expect(m.fields.advance_fee_cents.alternatives).toEqual([{ value: "300", section: "9.1" }]);
  });

  it("ignores a quote that states no value for the rule", () => {
    const m = mapAnswer(
      sections,
      transcript,
      withRule(good, "advance_min_cents", [
        { section: "9.1", quote: "A driver may ask for an advance against pay already earned", value_text: "$75" },
      ]),
      base,
    );
    expect(m.fields.advance_min_cents.state).toBe("not_in_document");
  });

  it("keeps no carrier name, date or noted figure the document does not hold", () => {
    const m = mapAnswer(
      sections,
      transcript,
      {
        ...good,
        carrier_name: "Some Other Carrier",
        effective_date: [{ section: "1.1", quote: "takes effect on November 2, 2026", value_text: "November 9, 2026" }],
        noted: [{ key: "per_mile", section: "3.1", quote: "Company drivers on long-haul lanes are paid $0.62 per loaded mile", value_text: "$0.65" }],
      },
      base,
    );
    expect(m.carrierName).toBeNull();
    expect(m.documentDate).toBeNull();
    expect(m.noted.map((n) => n.key)).toEqual(["week_start"]);
  });

  it("refuses an answer that is not the strict shape", () => {
    expect(parseRulesAnswer("{")).toBeNull();
    expect(parseRulesAnswer(JSON.stringify({ ...good, extra: 1 }))).toBeNull();
    expect(parseRulesAnswer(JSON.stringify({ ...good, rules: { ...good.rules, week_start_dow: [] } }))).toBeNull();
  });
});
