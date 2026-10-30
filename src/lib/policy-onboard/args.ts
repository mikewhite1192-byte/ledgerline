import { z } from "zod";
import { RULE_KEYS, type RuleKey } from "../pay-rules/rules";
import { isLocalDate } from "../time/local-date";
import { ALTERNATIVES_MAX, PASSAGES_MAX, QUOTE_MAX, QUOTE_MIN } from "./cite";
import { NOTED_KEYS } from "./format";
import { NOTED_MAX } from "./map";
import { SECTION_NUMBER, SECTION_TEXT_MAX } from "./sections";

// What a pay_policy_setup proposal stores as its args: the document and its transcript, the
// version it starts from, the dates, and each of the 13 rules with its state, its value as text
// and the passages it was read from. Quotes and paragraphs are text the document holds (checked
// word for word against the screened transcript when the card was made, and again at approval);
// everything else is ids, dates, digits or codes. The executor parses the stored args with this
// schema and re-checks every passage before it writes anything.

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const DATE = z.string().refine(isLocalDate);
const SECTION = z.string().regex(SECTION_NUMBER);
// A rule's value as stored: "null", an enum code, or whole cents or basis points.
export const VALUE_TEXT = /^(null|[a-z_]{2,40}|\d{1,9})$/;
const VALUE = z.string().regex(VALUE_TEXT);

const passage = z.strictObject({
  section: SECTION,
  quote: z.string().min(QUOTE_MIN).max(QUOTE_MAX),
  paragraph: z.string().min(1).max(SECTION_TEXT_MAX),
});

const field = z.strictObject({
  value: VALUE,
  state: z.enum(["found", "needs_you", "not_in_document"]),
  passages: z.array(passage).max(PASSAGES_MAX),
  alternatives: z.array(z.strictObject({ value: VALUE, section: SECTION })).max(ALTERNATIVES_MAX).optional(),
});

const noted = z.strictObject({
  key: z.enum([...NOTED_KEYS, "week_start"]),
  value: z.string().regex(/^\d{1,9}$/),
  section: SECTION,
  quote: z.string().min(QUOTE_MIN).max(QUOTE_MAX),
});

export const policyArgsSchema = z
  .strictObject({
    v: z.literal(1),
    documentId: UUID,
    transcriptId: UUID,
    baseVersionId: UUID,
    effectiveFrom: DATE,
    askedFrom: DATE,
    carrierNameInDocument: z.string().min(2).max(80).nullable(),
    fields: z.strictObject(Object.fromEntries(RULE_KEYS.map((k) => [k, field])) as Record<RuleKey, typeof field>),
    noted: z.array(noted).max(NOTED_MAX),
    // Set by the card store when the card is saved: how many earlier cards for the same version
    // ended expired or failed (proposals/engine.ts). Absent on the args the run builds.
    revision: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((a) => a.askedFrom <= a.effectiveFrom);

export type PolicyArgs = z.infer<typeof policyArgsSchema>;

export function parsePolicyArgs(raw: unknown): PolicyArgs | null {
  const parsed = policyArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// The fields' state counts, for the card and the auditor's engine view.
export function stateCounts(fields: PolicyArgs["fields"]): { found: number; needsYou: number; notInDocument: number } {
  let found = 0;
  let needsYou = 0;
  let notInDocument = 0;
  for (const key of RULE_KEYS) {
    const s = fields[key].state;
    if (s === "found") found += 1;
    else if (s === "needs_you") needsYou += 1;
    else notInDocument += 1;
  }
  return { found, needsYou, notInDocument };
}
