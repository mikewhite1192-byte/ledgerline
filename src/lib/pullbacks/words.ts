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
