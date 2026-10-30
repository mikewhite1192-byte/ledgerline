// What the model reads off a pay card picture, under a strict schema. The prompt holds no expected
// value, so the read cannot echo the answer key: it reports only what is printed. Anything off
// schema is a failure, never a pass. Plain data: check.ts, the only file here that names the model
// wrapper, sends it.

export type CardRead = {
  net_pay_cents: number | null;
  earned_cents: number | null;
  taken_out_cents: number | null;
  loads: number | null;
  miles: number | null;
  change_cents: number | null;
  first_name: string | null;
  week_text: string | null;
  other_amounts_cents: number[];
  any_other_digits: boolean;
};

const KEYS: readonly (keyof CardRead)[] = [
  "net_pay_cents",
  "earned_cents",
  "taken_out_cents",
  "loads",
  "miles",
  "change_cents",
  "first_name",
  "week_text",
  "other_amounts_cents",
  "any_other_digits",
];

const INT_OR_NULL = { type: ["integer", "null"] };
const STR_OR_NULL = { type: ["string", "null"] };

export const PAY_CARD_READ_FORMAT = {
  name: "pay_card_read",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [...KEYS],
    properties: {
      net_pay_cents: INT_OR_NULL,
      earned_cents: INT_OR_NULL,
      taken_out_cents: INT_OR_NULL,
      loads: INT_OR_NULL,
      miles: INT_OR_NULL,
      change_cents: INT_OR_NULL,
      first_name: STR_OR_NULL,
      week_text: STR_OR_NULL,
      other_amounts_cents: { type: "array", items: { type: "integer" } },
      any_other_digits: { type: "boolean" },
    },
  } as Record<string, unknown>,
};

// English or Spanish cards read the same way: the fields are named by place and meaning, not by
// the card's words.
export const PAY_CARD_PROMPT = [
  "This picture is a driver's weekly pay card, in English or Spanish. Report only what is printed",
  "on it. Do not guess, add up, complete or correct anything. Amounts are in cents ($1,234.56 is",
  "123456). Use null for a field the card does not show.",
  "net_pay_cents: the large take-home pay amount (Take-home pay or Pago neto).",
  "earned_cents: the amount labeled Earned or Ganado.",
  "taken_out_cents: the amount labeled Taken out or Descontado.",
  "loads: the number of loads (loads or cargas).",
  "miles: the number of miles (miles or millas).",
  "change_cents: the change from last week: positive when it says Up or más, negative when it says",
  "Down or menos, 0 when it says the same as last week; null when it says first week or shows no",
  "change from last week.",
  "first_name: the driver's name exactly as printed.",
  "week_text: the line that names the week, exactly as printed.",
  "other_amounts_cents: every other dollar amount printed on the card, in cents; empty if none.",
  "any_other_digits: true if any other digit is printed anywhere on the card, outside the fields",
  "above and the carrier name at the top; else false.",
].join("\n");

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isIntOrNull = (v: unknown) => v === null || isInt(v);
const isStrOrNull = (v: unknown) => v === null || (typeof v === "string" && v.length <= 200);

// The model's text as a CardRead, or null when it is not exactly that shape.
export function parseCardRead(text: string): CardRead | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(v, k))) return null;
  if (
    !isIntOrNull(v.net_pay_cents) ||
    !isIntOrNull(v.earned_cents) ||
    !isIntOrNull(v.taken_out_cents) ||
    !isIntOrNull(v.loads) ||
    !isIntOrNull(v.miles) ||
    !isIntOrNull(v.change_cents) ||
    !isStrOrNull(v.first_name) ||
    !isStrOrNull(v.week_text) ||
    !Array.isArray(v.other_amounts_cents) ||
    v.other_amounts_cents.length > 20 ||
    !v.other_amounts_cents.every(isInt) ||
    typeof v.any_other_digits !== "boolean"
  ) {
    return null;
  }
  return v as CardRead;
}
