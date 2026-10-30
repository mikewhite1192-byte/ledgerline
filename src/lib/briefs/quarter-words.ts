// Fixed words for the quarter review screen. Categories reach the page; these turn them into text.
// Never raw error text, never a model's words.

const CHECK_CATEGORIES = new Set(["format", "unknown_tag", "number_mismatch", "untagged"]);

export const REVIEW_CHECK_FAILED = "The review did not pass its number check. Your figures are unchanged; try again.";
export const REVIEW_DID_NOT_FINISH = "The review did not finish. Your figures are unchanged; try again.";
// A written review that can no longer be read back. It still counts as written, so no try is offered.
export const REVIEW_UNREADABLE = "The review was written, but it could not be read back. Your figures below are unchanged.";

// The four lists, as the page heads them.
export const SECTION_TITLES = {
  went_well: "What went well",
  problems: "Recurring problems",
  recovered: "Money recovered",
  change: "Three things to change",
} as const;

// Why the last try left no review, for the card where the review would be.
export function reviewRefusalWords(category: string): string {
  if (CHECK_CATEGORIES.has(category)) return REVIEW_CHECK_FAILED;
  switch (category) {
    case "cap":
    case "too_expensive":
      return "The agent is paused: the demo budget is used up. Nothing was lost or sent.";
    case "job_cap":
      return "The agent paused: it used more than its hourly budget. Nothing was lost or sent. Try again later.";
    case "disabled":
    case "not_configured":
      return "The agent is off for this carrier, so no review was written. Nothing was lost or sent.";
    default:
      return REVIEW_DID_NOT_FINISH;
  }
}

// What a press of the button did, from the reply's status and category.
export function reviewOutcome(reply: { ok: boolean; error: string | null; data: Record<string, unknown> }): string {
  if (reply.ok) {
    const status = reply.data.status;
    const category = typeof reply.data.category === "string" ? reply.data.category : "";
    if (status === "drafted") return "The review is written and every number checked.";
    if (status === "refused" || status === "over_cap") return reviewRefusalWords(category);
    return "The outcome is not known yet. The page reads it back.";
  }
  switch (reply.error) {
    case "exists":
      return "The review for these figures is already written.";
    case "in_progress":
      return "The review is being written. It shows here when it is done.";
    case "no_activity":
      return "Nothing has happened yet, so there is nothing to review.";
    case "review_off":
    case "disabled":
      return "Quarter review is off for this carrier. Nothing was sent.";
    case "ai_off":
    case "ai_disabled":
      return "The agent is off for this carrier. Nothing was sent.";
    case "forbidden":
    case "unauthenticated":
      return "You are signed out or not a member of this carrier. Sign in again.";
    case "unknown":
      return "The outcome is not known yet. The page reads it back.";
    default:
      return REVIEW_DID_NOT_FINISH;
  }
}
