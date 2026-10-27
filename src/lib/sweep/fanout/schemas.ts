import { z } from "zod";
import { FINDING_CATEGORIES, TABLES } from "../../rules-engine/types";

// The three answers the sweep's second opinion asks a model for (design 3.2 to 3.4), each as a
// strict JSON Schema for the request and a strict zod schema the server parses the reply with.
// No answer carries an amount: the only number in any of them is a plan priority (1 to 3). Text
// lengths are cut to size after parsing, so a few characters over never loses a whole answer.

export const OTHER_CATEGORY = "other_for_review";
export const CHECK_CATEGORIES = [...FINDING_CATEGORIES, OTHER_CATEGORY] as const;
export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

export const SUMMARY_MAX = 600;
export const BRIEF_MAX = 240;
export const NOTE_MAX = 200;
export const DISAGREEMENT_MAX = 240;
export const MAX_FOCUS = 4;
export const MAX_ISSUES = 8;
export const MAX_SOURCES = 4;
export const MAX_DISAGREEMENTS = 12;

// A dollar or cent sign, five digits in a row, a decimal of any length, a thousands group, or a
// number with a currency word before or after it ("45 cents", "40 dollars", "USD 40"): a figure a
// model wrote. The page never shows one, so the whole string is replaced. Other short numbers (a
// date, a driver code, a load count) stay.
const FIGURE = /\$|¢|\d{5,}|\d+\.\d+|\d{1,3}(?:,\d{3})+|\d+\s*(?:cents?|dollars?|bucks|usd)\b|\busd\s*\d/i;

export function scrubFigures(text: string, replacement: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (FIGURE.test(clean)) return replacement;
  return clean.slice(0, max);
}

const text = z.string().max(4_000);
const uuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

// ---- Plan (Muse Wonder, fanout_plan) ----

export const PlanAnswer = z.strictObject({
  summary: text,
  order: z
    .array(
      z.strictObject({
        driverId: uuid,
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        focus: z.array(z.string().max(60)).max(20),
        brief: text,
      }),
    )
    .max(200),
  skipped: z.array(z.strictObject({ driverId: uuid, reason: z.enum(["over_limit", "no_activity"]) })).max(200),
});
export type PlanAnswer = z.infer<typeof PlanAnswer>;

export const PLAN_FORMAT = {
  name: "fanout_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "order", "skipped"],
    properties: {
      summary: { type: "string", maxLength: SUMMARY_MAX },
      order: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["driverId", "priority", "focus", "brief"],
          properties: {
            driverId: { type: "string" },
            priority: { type: "integer", enum: [1, 2, 3] },
            focus: { type: "array", maxItems: MAX_FOCUS, items: { type: "string", enum: [...FINDING_CATEGORIES] } },
            brief: { type: "string", maxLength: BRIEF_MAX },
          },
        },
      },
      skipped: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["driverId", "reason"],
          properties: {
            driverId: { type: "string" },
            reason: { type: "string", enum: ["over_limit", "no_activity"] },
          },
        },
      },
    },
  },
};

// ---- One driver's check (Muse Spark, fanout_check) ----

export const CheckAnswer = z.strictObject({
  driverId: uuid,
  checkedAll: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  issues: z
    .array(
      z.strictObject({
        category: z.enum(CHECK_CATEGORIES),
        sources: z.array(z.strictObject({ table: z.string().max(60), id: uuid })).min(1).max(MAX_SOURCES),
        note: text,
      }),
    )
    .max(MAX_ISSUES),
});
export type CheckAnswer = z.infer<typeof CheckAnswer>;

// The shape the check's last message must take, spelled out in its prompt: the check's request
// offers tools, so its answer is a plain message the server parses, never a forced format.
export const CHECK_SHAPE =
  '{"driverId": "<the driver id>", "checkedAll": true|false, "confidence": "high"|"medium"|"low", ' +
  '"issues": [{"category": "<one of: ' +
  CHECK_CATEGORIES.join(", ") +
  '>", "sources": [{"table": "<table>", "id": "<record id>"}], "note": "<one sentence, no amounts>"}]}';

// ---- Comparison (Muse Wonder, fanout_reconcile) ----

export const ReconcileAnswer = z.strictObject({
  summary: text,
  disagreements: z
    .array(z.strictObject({ driverId: uuid, category: z.enum(CHECK_CATEGORIES), text }))
    .max(50),
});
export type ReconcileAnswer = z.infer<typeof ReconcileAnswer>;

export const RECONCILE_FORMAT = {
  name: "fanout_reconcile",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "disagreements"],
    properties: {
      summary: { type: "string", maxLength: SUMMARY_MAX },
      disagreements: {
        type: "array",
        maxItems: MAX_DISAGREEMENTS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["driverId", "category", "text"],
          properties: {
            driverId: { type: "string" },
            category: { type: "string", enum: [...CHECK_CATEGORIES] },
            text: { type: "string", maxLength: DISAGREEMENT_MAX },
          },
        },
      },
    },
  },
};

// A record table the engine cites (and the record pages link to).
export function isRecordTable(table: string): boolean {
  return (TABLES as readonly string[]).includes(table);
}

// A model's JSON answer, also when it wrapped the JSON in one code fence; anything else is undefined.
export function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    return undefined;
  }
}
