import type { AiFormat } from "../ai";
import { DOCUMENT_FORMAT, DOCUMENT_PROMPT, MAX_CENTS, MAX_LINE_CHARS, parseRead } from "./schema";
import type { DocumentRead } from "./types";

// The read-back of a marked copy: the document schema unchanged (so every field the original
// reading took is read again under the same rules), plus four keys about what was drawn. The
// prompt carries no expected value: the model says what it sees, and markup-check.ts compares.

const EXTRA_KEYS = ["callout_text", "circled_line_text", "circle_count", "all_amounts_cents"] as const;

export const MAX_CALLOUT_READ_CHARS = 200;
export const MAX_AMOUNTS_READ = 40;
export const MAX_CIRCLES_READ = 20;

const base = DOCUMENT_FORMAT.schema as {
  required: string[];
  properties: Record<string, unknown>;
} & Record<string, unknown>;

export const MARKUP_CHECK_FORMAT: AiFormat = {
  name: "document_markup_check",
  strict: true,
  schema: {
    ...base,
    required: [...base.required, ...EXTRA_KEYS],
    properties: {
      ...base.properties,
      callout_text: { type: ["string", "null"] },
      circled_line_text: { type: ["string", "null"] },
      circle_count: { type: "integer" },
      all_amounts_cents: { type: "array", items: { type: "integer" } },
    },
  },
};

export const MARKUP_CHECK_PROMPT = [
  DOCUMENT_PROMPT,
  "This photo may have been edited: a red oval drawn around one printed line, and a white box",
  "with a red border holding a short note. Fill the document fields from the document itself,",
  "never from the added box. text_lines: the document's own printed lines only.",
  "callout_text: the exact text inside the added white box, or null when there is none.",
  "circled_line_text: the printed line inside the red oval, verbatim, or null when there is none.",
  "circle_count: how many red ovals or circles are drawn on the photo (0 when none).",
  "all_amounts_cents: every dollar amount visible anywhere in the photo, the box included, in",
  "cents, each amount once. sample_word: whether the word SAMPLE is visible anywhere.",
].join("\n");

export type MarkupCheckRead = {
  read: DocumentRead;
  calloutText: string | null;
  circledLineText: string | null;
  circleCount: number;
  amountsCents: number[];
  // The answer as the model gave it, kept on the row for the trace (never shown).
  raw: Record<string, unknown>;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isInt = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;

const textOrNull = (v: unknown, max: number): v is string | null =>
  v === null || (typeof v === "string" && v.length <= max);

// The model's answer as a MarkupCheckRead, or null when it is not exactly the schema's shape
// within its limits (off_schema).
export function parseMarkupCheck(text: string): MarkupCheckRead | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  for (const k of EXTRA_KEYS) if (!Object.hasOwn(value, k)) return null;
  const { callout_text, circled_line_text, circle_count, all_amounts_cents, ...rest } = value;
  if (!textOrNull(callout_text, MAX_CALLOUT_READ_CHARS)) return null;
  if (!textOrNull(circled_line_text, MAX_LINE_CHARS)) return null;
  if (!isInt(circle_count, MAX_CIRCLES_READ)) return null;
  if (!Array.isArray(all_amounts_cents) || all_amounts_cents.length > MAX_AMOUNTS_READ) return null;
  if (!all_amounts_cents.every((a) => isInt(a, MAX_CENTS))) return null;
  const read = parseRead(JSON.stringify(rest));
  if (!read) return null;
  return {
    read,
    calloutText: callout_text,
    circledLineText: circled_line_text,
    circleCount: circle_count,
    amountsCents: all_amounts_cents as number[],
    raw: value,
  };
}
