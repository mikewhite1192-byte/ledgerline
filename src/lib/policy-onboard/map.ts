import { z } from "zod";
import type { PayConfigKnobs } from "../data/rows";
import { RULE_KEYS, valueOf, type RuleKey } from "../pay-rules/rules";
import type { LocalDate } from "../time/local-date";
import { citedPassage, citeRule, type Field, type ModelPassage } from "./cite";
import { NOTED_KEYS, type NotedKey } from "./format";
import { amountsOf, dateOf, minutesOf, normalize, percentsOf, weekdayOf } from "./parse";

// The propose call's answer turned into the card: every one of the 13 rules Found (one value, read
// the same by code and model from a quote in the document), Needs you (two readings, a range, or a
// reading code does not share) or Not in document (the current value stays). Then the figures kept
// for reference only, the document's own date and pay week start, and the carrier's name as
// written. Each is kept only when its quote is in the document and code reads the same value from
// it. Pure.

export const NOTED_MAX = 8;
const CARRIER_NAME = /^[A-Za-z0-9&.,' -]{2,80}$/;

const passage = z.strictObject({ section: z.string().max(40), quote: z.string().max(2_000), value_text: z.string().max(200) });
const passages = z.array(passage).max(8);

const answerSchema = z.strictObject({
  carrier_name: z.string().max(200).nullable(),
  effective_date: passages,
  week_start: passages,
  rules: z.strictObject(Object.fromEntries(RULE_KEYS.map((k) => [k, passages])) as Record<RuleKey, typeof passages>),
  noted: z
    .array(
      z.strictObject({
        key: z.enum(NOTED_KEYS),
        section: z.string().max(40),
        quote: z.string().max(2_000),
        value_text: z.string().max(200),
      }),
    )
    .max(16),
});

export type RulesAnswer = z.infer<typeof answerSchema>;

export function parseRulesAnswer(text: string): RulesAnswer | null {
  try {
    const parsed = answerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type NotedFigureKey = NotedKey | "week_start";
// value: minutes, cents, basis points or a weekday (0 Sunday), as digits.
export type Noted = { key: NotedFigureKey; value: string; section: string; quote: string };

export type Mapped = {
  fields: Record<RuleKey, Field>;
  noted: Noted[];
  documentDate: LocalDate | null;
  weekStartDow: number | null;
  carrierName: string | null;
  exceptions: string[];
};

function readNoted(key: NotedKey, text: string): number[] {
  if (key === "detention_free_minutes") {
    const m = minutesOf(text);
    return m === null ? [] : [m];
  }
  if (key === "oo_percent") return percentsOf(text);
  return amountsOf(text).map((a) => a.cents);
}

// The first passage that is in the document and whose quote and reading say the same.
function firstAgreeing(
  sections: ReadonlyMap<string, string>,
  list: readonly ModelPassage[],
  read: (text: string) => number | null,
): { value: number; section: string; quote: string } | null {
  for (const p of list.slice(0, 4)) {
    const cited = citedPassage(sections, p);
    if (!cited) continue;
    const fromQuote = read(cited.quote);
    if (fromQuote !== null && fromQuote === read(p.value_text)) {
      return { value: fromQuote, section: cited.section, quote: cited.quote };
    }
  }
  return null;
}

export function mapAnswer(
  sections: ReadonlyMap<string, string>,
  transcript: string,
  answer: RulesAnswer,
  base: PayConfigKnobs,
): Mapped {
  const exceptions = new Set<string>();
  const fields = {} as Record<RuleKey, Field>;
  for (const key of RULE_KEYS) {
    const cited = citeRule(sections, key, answer.rules[key], valueOf(base, key));
    fields[key] = cited.field;
    if (cited.conflict) exceptions.add("conflicting_values");
    if (cited.field.state === "needs_you") exceptions.add("needs_you");
  }

  const noted: Noted[] = [];
  const seen = new Set<string>();
  for (const n of answer.noted) {
    if (noted.length >= NOTED_MAX - 1) break;
    const cited = citedPassage(sections, n);
    if (!cited) continue;
    const said = readNoted(n.key, n.value_text);
    const fromQuote = readNoted(n.key, cited.quote);
    if (said.length !== 1 || !fromQuote.includes(said[0])) continue;
    const id = `${n.key}:${said[0]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    noted.push({ key: n.key, value: String(said[0]), section: cited.section, quote: cited.quote });
  }

  const week = firstAgreeing(sections, answer.week_start, weekdayOf);
  if (week) {
    noted.push({ key: "week_start", value: String(week.value), section: week.section, quote: week.quote });
    if (week.value !== base.week_start_dow) exceptions.add("week_start_differs");
  }

  let documentDate: LocalDate | null = null;
  for (const p of answer.effective_date.slice(0, 4)) {
    const cited = citedPassage(sections, p);
    const d = cited ? dateOf(cited.quote) : null;
    if (d !== null && d === dateOf(p.value_text)) {
      documentDate = d;
      break;
    }
  }

  const name = answer.carrier_name === null ? null : normalize(answer.carrier_name);
  const carrierName = name !== null && CARRIER_NAME.test(name) && transcript.includes(name) ? name : null;

  return {
    fields,
    noted,
    documentDate,
    weekStartDow: week ? week.value : null,
    carrierName,
    exceptions: [...exceptions],
  };
}
