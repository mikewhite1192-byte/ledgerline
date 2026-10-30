import { describe, expect, it } from "vitest";
import type { PayConfigKnobs } from "../data/rows";
import { rowsFor } from "../pay-rules/__tests__/rows";
import { RULE_KEYS } from "../pay-rules/rules";
import { parsePolicyArgs, stateCounts } from "./args";
import { mapAnswer } from "./map";
import { sectionsOfTranscript, transcriptOf } from "./sections";
import { rulesAnswerFor, sampleSections } from "./test-fixtures";

// The stored args of a pay_policy_setup card: what the run builds from a sample parses back whole,
// the card store's revision included, and anything else (an extra key, a wrong id, a value that is
// not a stored value, a start before the asked date, a rule left out) is refused.

const DOC = "11111111-1111-4111-8111-111111111111";
const INPUT = "22222222-2222-4222-8222-222222222222";
const BASE = "33333333-3333-4333-8333-333333333333";

function newest(): PayConfigKnobs {
  return [...rowsFor("blue-ridge").pay_configs].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
}

function built(): Record<string, unknown> {
  const transcript = transcriptOf(sampleSections("harrow-flats-pay-policy"));
  const sections = sectionsOfTranscript(transcript);
  if (!sections) throw new Error("the sample transcript does not read back");
  const mapped = mapAnswer(sections, transcript, rulesAnswerFor("harrow-flats-pay-policy"), newest());
  return {
    v: 1,
    documentId: DOC,
    transcriptId: INPUT,
    baseVersionId: BASE,
    effectiveFrom: "2026-11-02",
    askedFrom: "2026-11-02",
    carrierNameInDocument: mapped.carrierName,
    fields: mapped.fields,
    noted: mapped.noted,
  };
}

describe("a policy card's stored args", () => {
  it("parses what the run builds, and again after a JSON round trip with the card's revision", () => {
    const args = built();
    const parsed = parsePolicyArgs(args);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed?.fields ?? {}).sort()).toEqual([...RULE_KEYS].sort());
    const stored = JSON.parse(JSON.stringify({ ...args, revision: 2 }));
    expect(parsePolicyArgs(stored)?.revision).toBe(2);
  });

  it("counts each rule's state", () => {
    const parsed = parsePolicyArgs(built());
    if (!parsed) throw new Error("the built args did not parse");
    const counts = stateCounts(parsed.fields);
    expect(counts.found + counts.needsYou + counts.notInDocument).toBe(RULE_KEYS.length);
    expect(counts.needsYou).toBeGreaterThanOrEqual(1);
    expect(parsed.fields.net_pay_floor_cents.state).toBe("needs_you");
  });

  it("refuses an extra key, a bad id, a bad date, and a start before the asked date", () => {
    const args = built();
    expect(parsePolicyArgs({ ...args, approvedBy: "someone" })).toBeNull();
    expect(parsePolicyArgs({ ...args, v: 2 })).toBeNull();
    expect(parsePolicyArgs({ ...args, documentId: "not-a-uuid" })).toBeNull();
    expect(parsePolicyArgs({ ...args, effectiveFrom: "2026-02-30" })).toBeNull();
    expect(parsePolicyArgs({ ...args, askedFrom: "2026-11-09" })).toBeNull();
    expect(parsePolicyArgs({ ...args, revision: -1 })).toBeNull();
  });

  it("refuses a rule left out, a rule added, and a value that is not a stored value", () => {
    const args = built();
    const fields = args.fields as Record<string, Record<string, unknown>>;
    const missing = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "insurance_per_day_cents"));
    expect(parsePolicyArgs({ ...args, fields: missing })).toBeNull();
    expect(parsePolicyArgs({ ...args, fields: { ...fields, week_start_dow: fields.insurance_per_day_cents } })).toBeNull();
    for (const value of ["$10.50", "10.5", "-1", "Owner Operator", "1".repeat(10)]) {
      const bad = { ...fields, insurance_per_day_cents: { ...fields.insurance_per_day_cents, value } };
      expect(parsePolicyArgs({ ...args, fields: bad }), value).toBeNull();
    }
    const state = { ...fields, insurance_per_day_cents: { ...fields.insurance_per_day_cents, state: "maybe" } };
    expect(parsePolicyArgs({ ...args, fields: state })).toBeNull();
  });

  it("refuses a passage with a short quote or too many passages for one rule", () => {
    const args = built();
    const fields = args.fields as Record<string, { passages: { section: string; quote: string; paragraph: string }[] }>;
    const one = fields.insurance_per_day_cents.passages[0];
    const short = { ...fields.insurance_per_day_cents, passages: [{ ...one, quote: "short" }] };
    expect(parsePolicyArgs({ ...args, fields: { ...fields, insurance_per_day_cents: short } })).toBeNull();
    const many = { ...fields.insurance_per_day_cents, passages: [one, one, one] };
    expect(parsePolicyArgs({ ...args, fields: { ...fields, insurance_per_day_cents: many } })).toBeNull();
  });
});
