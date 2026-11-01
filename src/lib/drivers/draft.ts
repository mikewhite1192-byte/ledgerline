import { z } from "zod";
import { dollarsToCents } from "../invoices/form-text";
import { isLocalDate } from "../time/local-date";

// A new driver as the Add driver form sends it (design-d1-drivers 5.2), with no server imports,
// so the browser form and the route check the same rules. Each bound matches a CHECK on drivers
// (0004, 0019, 0032), and the pay basis picks exactly one rate, so the table's pairing CHECK is
// never the first thing to refuse. Codes are kept upper case and emails lower case, so the same
// person typed twice is the same value.

export const CODE = /^[A-Z0-9-]{2,20}$/;
const TRUCK = /^[A-Z0-9-]{1,20}$/;
// No control characters in a name (a tab, a newline): one line of plain text.
const PLAIN = /^[^\p{Cc}]+$/u;
export const NAME_MAX = 60;
export const EMAIL_MAX = 120;
export const WORKER_TYPES = ["company", "owner_operator"] as const;
export const PAY_BASES = ["per_mile", "percent", "flat"] as const;
export const LANGUAGES = ["en", "es"] as const;

export type WorkerType = (typeof WORKER_TYPES)[number];
export type PayBasis = (typeof PAY_BASES)[number];

const name = () => z.string().trim().min(1).max(NAME_MAX).regex(PLAIN);

const shared = {
  code: z.string().trim().toUpperCase().regex(CODE),
  firstName: name(),
  lastName: name(),
  email: z.string().trim().toLowerCase().min(3).max(EMAIL_MAX).pipe(z.email()),
  workerType: z.enum(WORKER_TYPES),
  // Absent means the carrier's default limit (drivers.advance_limit_cents NULL).
  advanceLimitCents: z.int().min(0).max(999_999_999).optional(),
  truckUnit: z.string().trim().toUpperCase().regex(TRUCK).optional(),
  tankGallons: z.int().min(100).max(400).default(200),
  // Absent means today in the carrier's zone, set by the service, which also refuses a date more
  // than a year either side of that today (it knows the carrier's zone; this schema does not).
  activeFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isLocalDate)
    .optional(),
  ownInsurance: z.boolean().default(false),
  preferredLanguage: z.enum(LANGUAGES).default("en"),
};

export const DriverDraft = z.discriminatedUnion("payBasis", [
  z.strictObject({ ...shared, payBasis: z.literal("per_mile"), perMileCents: z.int().min(1).max(999) }),
  z.strictObject({ ...shared, payBasis: z.literal("percent"), percentBps: z.int().min(1).max(10_000) }),
  z.strictObject({ ...shared, payBasis: z.literal("flat"), flatPerLoadCents: z.int().min(1).max(999_999_999) }),
]);
export type DriverDraft = z.output<typeof DriverDraft>;

// The form's own fields, as typed. The rate is one box whose meaning follows the pay basis: dollars
// per mile, a percent of linehaul, or dollars per load.
export type DriverFormText = {
  code: string;
  firstName: string;
  lastName: string;
  email: string;
  workerType: WorkerType;
  payBasis: PayBasis;
  rate: string;
  advanceLimit: string;
  truckUnit: string;
  tankGallons: string;
  activeFrom: string;
  ownInsurance: boolean;
  preferredLanguage: "en" | "es";
};
export type DriverFormField = keyof DriverFormText;
// form: a refusal that names no one field.
export type DriverFormErrors = Partial<Record<DriverFormField | "form", string>>;
export const CHECK_FIELDS = "Check the fields and try again.";

// One fixed sentence per field; never a library's or the server's own words.
export const FIELD_SENTENCES: Readonly<Record<DriverFormField, string>> = {
  code: "2 to 20 letters, digits or dashes, like BR-D27.",
  firstName: "A first name, up to 60 characters.",
  lastName: "A last name, up to 60 characters.",
  email: "An email address, up to 120 characters.",
  workerType: "Pick company driver or owner-operator.",
  payBasis: "Pick how the driver is paid.",
  rate: "The rate for this pay basis.",
  advanceLimit: "Dollars and cents, up to $9,999,999.99, or leave it empty for the carrier's default.",
  truckUnit: "Up to 20 letters, digits or dashes, or leave it empty.",
  tankGallons: "A whole number of gallons from 100 to 400.",
  activeFrom: "A calendar date within a year of today.",
  ownInsurance: "Yes or no.",
  preferredLanguage: "Pick English or Spanish.",
};

export const RATE_SENTENCES: Readonly<Record<PayBasis, string>> = {
  per_mile: "Dollars per mile, from $0.01 to $9.99, like 0.62.",
  percent: "A percent of linehaul from 0.01 to 100, like 72.5.",
  flat: "Dollars per load, from $0.01 to $9,999,999.99.",
};

const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

// A percent as typed ("72.5") to basis points (7250), or null. Digits only, never through a float.
export function percentToBps(text: string): number | null {
  const m = PERCENT.exec(text.trim().replace(/%$/, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

function wholeNumber(text: string): number | null {
  const t = text.trim();
  return /^\d{1,4}$/.test(t) ? Number(t) : null;
}

// The form's text to the route's body, checked by the same schema the route uses. Either the body
// to send, or a sentence for each field that is wrong.
export function readDriverForm(
  text: DriverFormText,
): { ok: true; body: DriverDraft } | { ok: false; errors: DriverFormErrors } {
  const errors: DriverFormErrors = {};
  const body: Record<string, unknown> = {
    code: text.code,
    firstName: text.firstName,
    lastName: text.lastName,
    email: text.email,
    workerType: text.workerType,
    payBasis: text.payBasis,
    ownInsurance: text.ownInsurance,
    preferredLanguage: text.preferredLanguage,
  };
  const rate =
    text.payBasis === "percent" ? percentToBps(text.rate) : PAY_BASES.includes(text.payBasis) ? dollarsToCents(text.rate) : null;
  if (rate === null) errors.rate = RATE_SENTENCES[text.payBasis] ?? FIELD_SENTENCES.rate;
  else if (text.payBasis === "per_mile") body.perMileCents = rate;
  else if (text.payBasis === "percent") body.percentBps = rate;
  else body.flatPerLoadCents = rate;
  if (text.advanceLimit.trim() !== "") {
    const cents = dollarsToCents(text.advanceLimit);
    if (cents === null) errors.advanceLimit = FIELD_SENTENCES.advanceLimit;
    else body.advanceLimitCents = cents;
  }
  if (text.truckUnit.trim() !== "") body.truckUnit = text.truckUnit;
  const gallons = wholeNumber(text.tankGallons);
  if (gallons === null) errors.tankGallons = FIELD_SENTENCES.tankGallons;
  else body.tankGallons = gallons;
  if (text.activeFrom.trim() !== "") body.activeFrom = text.activeFrom.trim();

  const parsed = DriverDraft.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = formFieldOf(issue.path[0]);
      if (field && errors[field] === undefined) {
        errors[field] = field === "rate" ? (RATE_SENTENCES[text.payBasis] ?? FIELD_SENTENCES.rate) : FIELD_SENTENCES[field];
      }
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  // A refusal no field explains still stops the send.
  if (!parsed.success) return { ok: false, errors: { form: CHECK_FIELDS } };
  return { ok: true, body: parsed.data };
}

const BODY_TO_FORM: Readonly<Record<string, DriverFormField>> = {
  perMileCents: "rate",
  percentBps: "rate",
  flatPerLoadCents: "rate",
  advanceLimitCents: "advanceLimit",
};

function formFieldOf(key: PropertyKey | undefined): DriverFormField | null {
  if (typeof key !== "string") return null;
  if (Object.hasOwn(BODY_TO_FORM, key)) return BODY_TO_FORM[key];
  return Object.hasOwn(FIELD_SENTENCES, key) ? (key as DriverFormField) : null;
}
