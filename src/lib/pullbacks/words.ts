import { TAKEBACK_REASON_LABELS } from "../advances/takeback-words";

// The pull-back reasons, a closed list, and their words. Pure, so a question or a card can say a
// reason without the facts' database code. The take-back's reasons plus a breakdown before the
// trip (A7), which has no advance to take back.

export const PULLBACK_REASONS = [
  "driver_request",
  "duplicate",
  "wrong_driver",
  "wrong_load",
  "breakdown",
  "other",
] as const;
export type PullbackReason = (typeof PULLBACK_REASONS)[number];

export function isPullbackReason(value: unknown): value is PullbackReason {
  return typeof value === "string" && (PULLBACK_REASONS as readonly string[]).includes(value);
}

export const PULLBACK_REASON_LABELS: Readonly<Record<PullbackReason, string>> = {
  ...TAKEBACK_REASON_LABELS,
  breakdown: "Truck broke down before the trip",
};

export function pullbackReasonWords(reason: string): string {
  return isPullbackReason(reason) ? PULLBACK_REASON_LABELS[reason] : "Other";
}

// A pull whose money moved but whose record is not finished (the provider confirmed another
// amount, or the outcome is not confirmed): the card's line and the approval's notice. A person
// settles it; the pull stays live, so no second pull is made for that driver.
export const PULL_FOR_PERSON =
  "The card may have given back a different amount than planned, so this is not confirmed. A person settles it, and nothing is pulled again.";

// The advance page's pull-back card: an approval's outcome said in the pull's own words, before
// the shared sentences.
export const PULL_APPROVE_NOTICES: Readonly<Record<string, string>> = {
  pull_unknown: PULL_FOR_PERSON,
};
