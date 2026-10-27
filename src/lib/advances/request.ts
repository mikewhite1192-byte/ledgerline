import { isCanonicalUuid } from "../money/keys";
import { dollars } from "../money/format";
import type { AdvanceSource } from "../rules-engine/types";

// The advance flow's small rules, pure: what a desk request says, how dollars typed by a person
// become integer cents, the reference a flow advance carries, and how much the accounting post
// books. No clock, no database.

// Why a driver asked, picked from a list on the request desk. Never free text.
export const ADVANCE_REQUEST_CATEGORIES = ["fuel", "repair", "tolls", "lodging", "personal", "other"] as const;
export type AdvanceRequestCategory = (typeof ADVANCE_REQUEST_CATEGORIES)[number];

export const REQUEST_CATEGORY_LABELS: Readonly<Record<AdvanceRequestCategory, string>> = {
  fuel: "Fuel",
  repair: "Repair",
  tolls: "Tolls",
  lodging: "Lodging",
  personal: "Personal",
  other: "Other",
};

export function isRequestCategory(value: unknown): value is AdvanceRequestCategory {
  return typeof value === "string" && (ADVANCE_REQUEST_CATEGORIES as readonly string[]).includes(value);
}

// The desk's amount bounds, in cents: $1.00 to $10,000.00.
export const DESK_MIN_CENTS = 100;
export const DESK_MAX_CENTS = 1_000_000;

// Dollars as a person types them ("300", "300.5", "$1,250.00") to integer cents, built from the
// digits only: no float ever carries the amount. Returns null for anything else (an exponent, a
// sign, a third decimal place, letters), so the form says what is wrong instead of guessing.
const TYPED_DOLLARS = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

export function parseDollarsToCents(text: string): number | null {
  if (typeof text !== "string") return null;
  const m = TYPED_DOLLARS.exec(text.trim());
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  const part = Number((m[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + part;
  return Number.isSafeInteger(whole) && Number.isSafeInteger(cents) ? cents : null;
}

export function isDeskAmount(cents: unknown): cents is number {
  return Number.isSafeInteger(cents) && (cents as number) >= DESK_MIN_CENTS && (cents as number) <= DESK_MAX_CENTS;
}

// The question the desk hands the agent, the same words every time. The driver is named by code
// (no name, no contact detail), the amount by the shared money format.
export function deskRequestText(
  amountCents: number,
  driverCode: string,
  category: AdvanceRequestCategory,
  loadNumber: string | null = null,
): string {
  if (!isDeskAmount(amountCents)) throw new RangeError("amount is outside the desk's range");
  if (!/^[A-Z0-9-]{1,20}$/.test(driverCode)) throw new RangeError("driver code is not a plain code");
  if (!isRequestCategory(category)) throw new RangeError("unknown request category");
  if (loadNumber !== null && !DESK_LOAD_NUMBER.test(loadNumber)) throw new RangeError("load number is not a plain number");
  const load = loadNumber === null ? "" : ` for load ${loadNumber}`;
  return `Request an advance of ${dollars(amountCents)} for driver ${driverCode} (${category})${load}`;
}

// A load number the desk will put in its sentence: letters, digits and dashes only.
export const DESK_LOAD_NUMBER = /^[A-Z0-9-]{1,30}$/;

// A flow advance's reference: ADV- and the first 12 hex characters of its proposal's id, upper
// case. Derived from the proposal's random id, never from a counter, so it cannot collide with
// any other system's numbering; UNIQUE (tenant_id, request_ref) catches the rare repeat.
export function requestRefOf(proposalId: string): string {
  if (!isCanonicalUuid(proposalId)) throw new RangeError("proposal id is not a lowercase UUID");
  return `ADV-${proposalId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

export const REQUEST_REF = /^ADV-[0-9A-F]{12}$/;

// Where an ask came from, by the kind of outside text behind it. No text: the desk or the chat.
export function sourceOfInput(kind: string | null): AdvanceSource {
  if (kind === "transcript") return "voice";
  if (kind === "email") return "email";
  return "ui";
}

// Where an advance came from, in words for the pages.
const SOURCE_WORDS: Readonly<Record<AdvanceSource, string>> = {
  ui: "In the app",
  email: "Email",
  voice: "Voice note",
  seed: "On file",
};

export function sourceWords(source: string): string {
  return Object.hasOwn(SOURCE_WORDS, source) ? SOURCE_WORDS[source as AdvanceSource] : "Other";
}

// The one place the accounting post's amount rule lives. The rules engine counts the fee as owed
// by the driver (outstanding = amount + fee - recovered), and the accounting adapter books the
// advance and its fee as two lines of one purchase whose total it confirms. The ledger confirms
// a post only when the outside total equals the action's amount, so the action carries amount +
// fee; booking the advance alone would settle every post as amount_mismatch. The payout itself
// carries the amount only: the fee is charged back later, never paid out.
export function expenseAmountCents(advance: { amountCents: number; feeCents: number }): number {
  const total = advance.amountCents + advance.feeCents;
  if (!Number.isSafeInteger(total) || advance.amountCents <= 0 || advance.feeCents < 0) {
    throw new RangeError("advance amounts must be whole cents");
  }
  return total;
}

// The desk's suggestion in words, from the engine's numbers only. A driver nobody armed, or one
// the rules allow nothing for, says so instead of suggesting.
export type SuggestionNumbers = {
  armed: boolean;
  suggestedCents: number;
  load: { capCents: number; openOnLoadCents: number } | null;
};

export function suggestionLine(s: SuggestionNumbers): string {
  if (!s.armed) return "This driver is not armed to receive money yet. An admin can arm them on the driver page.";
  if (s.suggestedCents <= 0) return "The pay rules allow no advance for this driver right now.";
  const load = s.load ? ` (cap ${dollars(s.load.capCents)}, open ${dollars(s.load.openOnLoadCents)})` : "";
  return `Suggested: ${dollars(s.suggestedCents)}${load}`;
}

// The suggested amount as the amount field writes it ("300.00").
export function suggestionInput(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) return "";
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
