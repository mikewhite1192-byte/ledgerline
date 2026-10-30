import { valueText, type RuleKey, type RuleValue } from "../pay-rules/rules";
import { candidatesFor, normalize, valueFromText } from "./parse";

// The citations, enforced in code (design 2.4). The model only points: a section, a quote from
// it, and the value it read. A passage stands only when (a) its section is one the read copied,
// (b) its quote, folded, is word for word inside that section, and (c) the quote is 12 to 400
// characters. Then (d) code reads the value out of the quote itself and (e) compares it with the
// model's reading. Only passages that pass (a) to (c) are kept, so the card never shows text that
// is not in the document; a value is Found only when code and model read the same one from it.
// Pure.

export const QUOTE_MIN = 12;
export const QUOTE_MAX = 400;
export const PASSAGES_MAX = 2;
export const ALTERNATIVES_MAX = 4;
// The most passages read for one rule, kept or not.
const READ_MAX = 4;

export type ModelPassage = { section: string; quote: string; value_text: string };
export type Passage = { section: string; quote: string; paragraph: string };
export type Alternative = { value: string; section: string };
export type FieldState = "found" | "needs_you" | "not_in_document";
export type Field = { value: string; state: FieldState; passages: Passage[]; alternatives?: Alternative[] };

// (a) to (c): the passage as stored, the quote folded and the paragraph its whole section, or null.
export function citedPassage(sections: ReadonlyMap<string, string>, p: { section: string; quote: string }): Passage | null {
  const paragraph = sections.get(p.section.trim());
  if (paragraph === undefined) return null;
  const quote = normalize(p.quote);
  if (quote.length < QUOTE_MIN || quote.length > QUOTE_MAX) return null;
  if (!normalize(paragraph).includes(quote)) return null;
  return { section: p.section.trim(), quote, paragraph };
}

type Reading = { value: RuleValue; passage: Passage };
type Doubt = { values: RuleValue[]; passage: Passage };

export type Cited = {
  field: Field;
  // Two passages that read cleanly as two different values.
  conflict: boolean;
};

// One rule, from the model's passages for it. base is the value the carrier's rules hold now:
// the value of a rule the document does not state, and the placeholder of one that needs a person.
export function citeRule(
  sections: ReadonlyMap<string, string>,
  key: RuleKey,
  model: readonly ModelPassage[],
  base: RuleValue,
): Cited {
  const readings: Reading[] = [];
  const doubts: Doubt[] = [];
  const seen = new Set<string>();
  for (const p of model.slice(0, READ_MAX)) {
    const passage = citedPassage(sections, p);
    if (!passage) continue;
    const id = `${passage.section}\n${passage.quote}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const c = candidatesFor(key, passage.quote);
    if (c.range) {
      doubts.push({ values: [...c.range], passage });
      continue;
    }
    // (d) The quote states no value for this rule: not a citation of it.
    if (c.values.length === 0) continue;
    const said = valueFromText(key, p.value_text);
    if (c.weekMismatch) {
      doubts.push({ values: c.values, passage });
      continue;
    }
    // (e) The model's reading is one the quote states.
    if (said !== undefined && c.values.includes(said)) readings.push({ value: said, passage });
    else doubts.push({ values: c.values, passage });
  }

  const passages = [...readings.map((r) => r.passage), ...doubts.map((d) => d.passage)].slice(0, PASSAGES_MAX);
  if (passages.length === 0) {
    return { field: { value: valueText(base), state: "not_in_document", passages: [] }, conflict: false };
  }
  const values = new Set(readings.map((r) => r.value));
  if (doubts.length === 0 && values.size === 1) {
    return { field: { value: valueText(readings[0].value), state: "found", passages }, conflict: false };
  }
  const alternatives: Alternative[] = [];
  const add = (value: RuleValue, section: string) => {
    const v = valueText(value);
    if (!alternatives.some((a) => a.value === v && a.section === section)) alternatives.push({ value: v, section });
  };
  for (const r of readings) add(r.value, r.passage.section);
  for (const d of doubts) for (const v of d.values) add(v, d.passage.section);
  return {
    field: {
      value: valueText(base),
      state: "needs_you",
      passages,
      alternatives: alternatives.slice(0, ALTERNATIVES_MAX),
    },
    conflict: values.size > 1,
  };
}
