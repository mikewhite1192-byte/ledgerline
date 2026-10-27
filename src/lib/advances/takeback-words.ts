// The take-back reasons, a closed list, and their words for the Take back form and the
// taken-back line. Pure, so the page's form can use them without the service's database code.

export const TAKEBACK_REASONS = ["driver_request", "duplicate", "wrong_driver", "wrong_load", "other"] as const;
export type TakebackReason = (typeof TAKEBACK_REASONS)[number];

export function isTakebackReason(value: unknown): value is TakebackReason {
  return typeof value === "string" && (TAKEBACK_REASONS as readonly string[]).includes(value);
}

export const TAKEBACK_REASON_LABELS: Readonly<Record<TakebackReason, string>> = {
  driver_request: "The driver asked to return it",
  duplicate: "Duplicate advance",
  wrong_driver: "Paid to the wrong driver",
  wrong_load: "Booked to the wrong load",
  other: "Other",
};

export function takebackReasonWords(reason: string): string {
  return isTakebackReason(reason) ? TAKEBACK_REASON_LABELS[reason] : "Other";
}

// The note an advance's proposal ends with when a take-back cancels the advance before any money
// moved: a code, said in words on the record.
export const CANCELLED_BY_TAKEBACK = "advance_cancelled";
