import { codeToWords } from "../format/labels";
import { dollars } from "../money/format";
import { ADVANCE_REFUSALS, type AdvanceRefusal } from "../rules-engine/types";
import { CANCELLED_BY_TAKEBACK } from "./takeback-words";

// Every sentence the advance flow shows a person, from a closed list. The rules engine's refusal
// codes and the flow's own outcome categories each have one fixed sentence; numbers in them are
// integer cents formatted by the shared money helper. Never a model's words, never upstream text.

export type RefusalNumbers = {
  minCents: number;
  limitCents: number;
  shareBps: number;
  earnedUnpaidCents: number;
  // The load an advance is for, when it names one: its number, the cap on advances against it,
  // what is still open on it, and the most one more advance can be once its fee is counted.
  load?: { number: string; capCents: number; openCents: number; mostCents: number } | null;
};

const percent = (bps: number) => {
  const whole = Math.floor(bps / 100);
  const rest = bps % 100;
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}%`;
};

const REFUSAL_SENTENCES: Readonly<Record<AdvanceRefusal, (n: RefusalNumbers) => string>> = {
  driver_not_armed: () =>
    "This driver is not armed to receive money. An admin can arm them on the driver page.",
  driver_inactive: () => "The driver is not active.",
  below_minimum: (n) => `Below the carrier's minimum advance of ${dollars(n.minCents)}.`,
  no_unpaid_earnings: () => "No earned pay is unpaid yet this period.",
  over_driver_limit: (n) =>
    `This would take open advances past the driver's limit of ${dollars(n.limitCents)}.`,
  exceeds_earned_share: (n) =>
    `More than ${percent(n.shareBps)} of earned, unpaid pay (${dollars(n.earnedUnpaidCents)}).`,
  possible_duplicate: () => "An advance for the same amount was requested within 24 hours.",
  over_load_cap: (n) =>
    n.load
      ? `Advances on load ${n.load.number} are capped at ${dollars(n.load.capCents)}; ${dollars(n.load.openCents)} is still open, so ${dollars(n.load.mostCents)} is the most for this load.`
      : "This would take advances on this load past the load's cap.",
};

export function isRefusal(code: unknown): code is AdvanceRefusal {
  return typeof code === "string" && (ADVANCE_REFUSALS as readonly string[]).includes(code);
}

export function refusalSentence(code: AdvanceRefusal, n: RefusalNumbers): string {
  return REFUSAL_SENTENCES[code](n);
}

// The flow's own outcomes: why an approval, a retry or a post did not go ahead, or what it did.
export const FLOW_OUTCOMES = [
  "disabled",
  "payouts_off",
  "not_armed",
  "over_cap",
  "before_start",
  "stale_eligibility",
  "capped_to_eligible",
  "eligibility_unavailable",
  "no_card",
  "driver_not_armed",
  "card_not_drivers",
  "load_not_drivers",
  "ref_collision",
  "attempts_exhausted",
  "not_retryable",
  "payout_pending",
  "payout_failed",
  "not_paid",
  "already_posted",
  "post_pending",
  "post_failed",
  "accounting_off",
  "already_taken_back",
  "over_bound",
  "not_takeable",
  "role",
  "not_found",
  "busy",
  "already_decided",
  "unauthenticated",
  "forbidden",
  "bad_request",
  "unavailable",
] as const;
export type FlowOutcome = (typeof FLOW_OUTCOMES)[number];

const OUTCOME_SENTENCES: Readonly<Record<FlowOutcome, string>> = {
  disabled: "Advances are switched off, so nothing was paid.",
  payouts_off: "Payouts are switched off, so nothing was paid.",
  not_armed: "Advance payouts are not armed yet, so nothing was paid.",
  over_cap: "The amount is over the advance payout cap, so nothing was paid.",
  before_start: "Advance payouts start on a later date, so nothing was paid.",
  stale_eligibility: "The numbers changed since this was proposed. Ask again.",
  capped_to_eligible: "Proposed the most the pay rules allow instead of the amount asked.",
  eligibility_unavailable: "Eligibility could not be checked, so nothing was paid. Try again.",
  no_card: "This driver has no fuel card on file, so nothing was paid.",
  driver_not_armed:
    "This driver is not armed to receive money. An admin can arm them on the driver page.",
  card_not_drivers: "That card is not one of this driver's active cards, so nothing was paid.",
  load_not_drivers: "That load is not one of this driver's loads, so nothing was paid.",
  ref_collision: "This advance's reference is already taken. Nothing was paid; it needs a person.",
  attempts_exhausted: "This payout has been tried the most times allowed. It needs a person.",
  not_retryable: "Only a payout that definitely failed can be tried again.",
  payout_pending: "The payout's outcome is not known yet. Use Check pending.",
  payout_failed: "The payout did not go through. Nothing was paid; Retry when ready.",
  not_paid: "Only a paid advance can be posted to QuickBooks.",
  already_posted: "This advance is already posted to QuickBooks.",
  post_pending: "The QuickBooks post's outcome is not known yet. Use Check pending.",
  post_failed: "The QuickBooks post did not go through. Nothing was booked; Post again when ready.",
  accounting_off: "Posting to QuickBooks is switched off.",
  already_taken_back: "This advance was already taken back, for a different amount.",
  over_bound: "That is more than is still owed on this advance, or more than one take-back may record.",
  not_takeable:
    "This advance cannot be taken back while its payout is in flight or after it was rejected or canceled.",
  role: "An advance this large needs an admin to approve it.",
  not_found: "No such advance.",
  busy: "Another request is working on this advance. Try again in a moment.",
  already_decided: "This advance was already rejected or canceled. Nothing was paid.",
  unauthenticated: "Your sign-in ended. Sign in again, then retry.",
  forbidden: "This login cannot act for this carrier.",
  bad_request: "That advance link is not valid.",
  unavailable: "That did not finish. Nothing was changed that cannot be checked; try again.",
};

export function isFlowOutcome(code: unknown): code is FlowOutcome {
  return typeof code === "string" && (FLOW_OUTCOMES as readonly string[]).includes(code);
}

export function outcomeSentence(code: string): string {
  return isFlowOutcome(code) ? OUTCOME_SENTENCES[code] : OUTCOME_SENTENCES.unavailable;
}

// The sentences an approval card shows for the advance executor's own refusals. The proposal
// gate's categories (role, not_found and the rest) keep the card's own sentences.
const CARD_OUTCOMES = [
  "disabled",
  "payouts_off",
  "not_armed",
  "over_cap",
  "before_start",
  "stale_eligibility",
  "eligibility_unavailable",
  "no_card",
  "driver_not_armed",
  "card_not_drivers",
  "load_not_drivers",
  "ref_collision",
  "payout_failed",
  "payout_pending",
] as const satisfies readonly FlowOutcome[];

export const ADVANCE_APPROVE_NOTICE: Readonly<Record<string, string>> = Object.fromEntries(
  CARD_OUTCOMES.map((c) => [c, OUTCOME_SENTENCES[c]]),
);

// A proposal's decision note in words. Notes are codes written by this app (a reject category,
// "expired", the stale-eligibility codes, or a take-back's cancel), never a person's or a model's
// text.
const STALE_NOTE = /^stale_eligibility: ([a-z_]+(?:,[a-z_]+)*)$/;

export function decisionNoteSentence(note: string | null): string | null {
  if (note === null || note === "") return null;
  const stale = STALE_NOTE.exec(note);
  if (stale) {
    const why = stale[1].split(",").map((c) => (c === "amount_changed" ? "the amount allowed changed" : codeToWords(c).toLowerCase()));
    return `The numbers changed before approval (${why.join(", ")}), so nothing was paid.`;
  }
  if (note === "expired") return "No one decided in time, so it expired.";
  if (note === CANCELLED_BY_TAKEBACK) return "The advance was taken back before any money moved, so nothing was paid.";
  return `Decision: ${codeToWords(note).toLowerCase()}.`;
}

// Take back: the shared sentences, except the size rule, which here is about taking back.
export function takeBackSentence(code: string): string {
  if (code === "role") return "Taking back an advance this large needs an admin.";
  if (code === "bad_request") return "Enter an amount above zero and pick a reason.";
  if (code === "not_found") return "No such advance.";
  return outcomeSentence(code);
}

// The driver's money panel (arming, ids, cards): its own closed list.
const PANEL_SENTENCES: Readonly<Record<string, string>> = {
  role: "Only an admin can arm a driver or change their cards.",
  card_not_drivers: "That card is not one of this driver's active cards.",
  identity_taken: "That id already belongs to another driver.",
  not_found: "No such driver or card.",
  bad_request: "Check what was entered and try again.",
  disabled: "Advances are switched off.",
  unauthenticated: OUTCOME_SENTENCES.unauthenticated,
  forbidden: OUTCOME_SENTENCES.forbidden,
};

export function panelSentence(code: string): string {
  return Object.hasOwn(PANEL_SENTENCES, code)
    ? PANEL_SENTENCES[code]
    : "That did not finish. Nothing was changed; try again.";
}
