import type { MoneyCodePurpose, MoneyCodeRefusal, MoneyCodeStatus } from "../rules-engine/money-codes";

// Every sentence a person sees about a money code, fixed text per category (client-safe: types
// only from the engine). Categories come from the engine's refusal list, the issue gate and the
// executor; a raw outside answer never reaches a sentence.

export const REFUSAL_SENTENCES: Readonly<Record<MoneyCodeRefusal, string>> = {
  load_not_drivers: "That load is not one of this driver's loads.",
  load_not_active: "The load is not on the road and was not delivered in the last three days.",
  amount_invalid: "The amount must be a dollar amount above $0.00.",
  over_code_cap: "The amount is over the most one money code can be.",
  evidence_missing: "The receipt or voice note it names was not found.",
  receipt_unreadable: "The receipt could not be read clearly. Ask the driver for a clearer photo.",
  receipt_kind: "The receipt is not the kind this code is for.",
  receipt_total_differs: "The amount does not equal the receipt's total.",
  receipt_other_load: "The receipt names a different load, or no load.",
  voice_other_driver: "The voice note came from a different driver.",
  voice_amount_differs: "The driver did not say that amount in the voice note.",
  driver_not_armed: "This driver is not armed to receive money. An admin can arm them on the driver page.",
  duplicate_code: "A code for this load, purpose and amount was already asked for in the last 24 hours.",
  daily_limit: "This driver already has the most money codes allowed for today.",
};

// The issue gate's words and the executor's own outcomes.
const OUTCOME_SENTENCES: Readonly<Record<string, string>> = {
  codes_off: "Money codes are off for this carrier, so no code was issued.",
  codes_payouts_off: "Payments are switched off, so no code was issued.",
  codes_not_armed: "Issuing money codes is not armed yet, so no code was issued.",
  codes_before_start: "Money codes start on a later date, so no code was issued.",
  code_exists: "A code was already asked for on this card. Open it from the Money codes page.",
  code_declined: "The card provider declined the code. Nothing was charged to the driver.",
  code_failed: "No code was issued and nothing was charged to the driver. Send a new request to try again.",
  code_pending: "The code is not confirmed yet. Use Check pending on the code's page.",
  code_unavailable: "The card provider could not be reached, so no code was issued. Try again in a minute.",
  check_unavailable: "The rules could not be checked just now, so no code was issued. Try again.",
  code_ref_collision: "This code's record is already taken. Nothing was issued; it needs a person.",
};

export function moneyCodeSentence(category: string | null | undefined): string {
  if (typeof category === "string") {
    if (Object.hasOwn(REFUSAL_SENTENCES, category)) return REFUSAL_SENTENCES[category as MoneyCodeRefusal];
    if (Object.hasOwn(OUTCOME_SENTENCES, category)) return OUTCOME_SENTENCES[category];
  }
  return "That did not finish. Nothing was issued that cannot be checked; try again.";
}

// The approval card's sentences for a money code's own categories. load_not_drivers and
// driver_not_armed are left to the shared advance sentences, which say the same thing, so one
// card map never holds two sentences for one word.
const SHARED_WITH_ADVANCES = new Set(["load_not_drivers", "driver_not_armed"]);
export const MONEY_CODE_APPROVE_NOTICE: Readonly<Record<string, string>> = Object.fromEntries(
  [...Object.entries(REFUSAL_SENTENCES), ...Object.entries(OUTCOME_SENTENCES)].filter(
    ([k]) => !SHARED_WITH_ADVANCES.has(k),
  ),
);

// The Money codes page's cards say every money code sentence, the two shared words included:
// the page holds only money code cards, so no word there means two things.
export const MONEY_CODE_PAGE_NOTICE: Readonly<Record<string, string>> = { ...REFUSAL_SENTENCES, ...OUTCOME_SENTENCES };

const STATUS_WORDS: Readonly<Record<MoneyCodeStatus, string>> = {
  issuing: "Processing",
  issued: "Issued",
  failed: "Not issued",
  unknown: "Not confirmed yet",
  voided: "Called off",
};

export function moneyCodeStatusWord(status: string): string {
  return Object.hasOwn(STATUS_WORDS, status) ? STATUS_WORDS[status as MoneyCodeStatus] : "Not known";
}

const PURPOSE_WORDS: Readonly<Record<MoneyCodePurpose, string>> = {
  lumper: "Lumper",
  repair: "Repair",
  other: "Other",
};

export function moneyCodePurposeWord(purpose: string): string {
  return Object.hasOwn(PURPOSE_WORDS, purpose) ? PURPOSE_WORDS[purpose as MoneyCodePurpose] : "Other";
}

// What the request form's answer says.
const REQUEST_SENTENCES: Readonly<Record<string, string>> = {
  created: "Sent for approval. It shows below until someone approves or rejects it.",
  duplicate: "That request is already waiting for approval.",
  live_exists: "A code for this load is already waiting or being issued. Decide that one first.",
  already_decided: "The same request was already decided. Change something, or ask again later.",
  bad_request: "Pick a load, then fill in the amount and the purpose.",
  unauthenticated: "Your sign-in ended. Sign in again, then send the request.",
  forbidden: "This login cannot act for this carrier.",
  codes_off: OUTCOME_SENTENCES.codes_off,
};

export function requestSentence(category: string | null | undefined): string {
  if (typeof category === "string" && Object.hasOwn(REQUEST_SENTENCES, category)) {
    return REQUEST_SENTENCES[category];
  }
  return moneyCodeSentence(category);
}

// The request form's purposes, in the order it offers them.
export const PURPOSE_CHOICES: readonly { value: MoneyCodePurpose; label: string }[] = [
  { value: "lumper", label: PURPOSE_WORDS.lumper },
  { value: "repair", label: PURPOSE_WORDS.repair },
  { value: "other", label: PURPOSE_WORDS.other },
];

// What a button on a code's page says when its route refuses. Fixed sentences only.
const ACTION_SENTENCES: Readonly<Record<string, string>> = {
  disabled: "Money codes are switched off for this carrier.",
  not_issued: "The code is not issued yet, so there is nothing to show.",
  code_expired: "This code expired. Request a new one if the driver still needs it.",
  not_found: "That code is not here.",
  unauthenticated: "Your sign-in ended. Sign in again, then try again.",
  forbidden: "This login cannot act for this carrier.",
  bad_request: "That code is not here.",
  unavailable: "The server could not be reached. Nothing changed; try again in a minute.",
};

export function actionSentence(category: string | null | undefined): string {
  if (typeof category === "string" && Object.hasOwn(ACTION_SENTENCES, category)) return ACTION_SENTENCES[category];
  return moneyCodeSentence(category);
}

export type CheckSummary = { checked: number; confirmed: number; failed: number; stillUnknown: number };

// Check pending's answer in words: what the read-back settled, or why nothing was read.
export function checkSentence(summary: CheckSummary | undefined, tooNew: number, stillWaiting: number): string {
  if (!summary || summary.checked === 0) {
    if (tooNew > 0) return "The code was asked for less than a minute ago, too soon to check. Check again in a minute.";
    if (stillWaiting > 0) return "The code is still waiting on the card provider. Nothing was changed. Check again later.";
    return "Nothing was waiting to be checked.";
  }
  if (summary.confirmed > 0) return "Confirmed. The code is issued and its paystub lines are added.";
  if (summary.failed > 0) return "The card provider says no code was issued. Nothing was charged to the driver.";
  return "Still not confirmed. Nothing was changed. Check again later.";
}

// How long an issued code has left, in hours and minutes, as of now.
export function expiresInWords(expiresAt: string, now: Date): string {
  const left = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(left)) return "Not known";
  if (left <= 0) return "Expired";
  const minutes = Math.ceil(left / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

// What the Test mode card provider does with an amount, by its last two digits, so a person can
// try each outcome on purpose.
export const TEST_MODE_NOTE =
  "Test mode: an amount ending in 99 cents is declined, and one ending in 98 cents stays not confirmed until Check pending.";
