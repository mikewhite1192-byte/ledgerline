// Fixed words for the profit brief screen. Categories reach the page; these turn them into text.
// Never raw error text, never a model's words.

// The categories the number check refuses with (verify.ts BRIEF_CATEGORIES).
const CHECK_CATEGORIES = new Set(["format", "unknown_tag", "number_mismatch", "untagged"]);

export const CHECK_FAILED = "The brief did not pass its number check. Try again.";

// Why the last try left no brief, for the card where the brief would be.
export function refusalWords(category: string): string {
  if (CHECK_CATEGORIES.has(category)) return CHECK_FAILED;
  switch (category) {
    case "timeout":
    case "interrupted":
      return "The agent took too long to write the brief. Nothing was lost or sent. Try again.";
    case "incomplete":
      return "The agent stopped before the brief was finished. Nothing was lost or sent. Try again.";
    case "cap":
    case "too_expensive":
      return "The agent is paused: the demo budget is used up. Nothing was lost or sent.";
    case "job_cap":
      return "The agent paused: it used more than its hourly budget. Nothing was lost or sent. Try again later.";
    case "disabled":
    case "not_configured":
      return "The agent is off for this carrier, so no brief was written. Nothing was lost or sent.";
    default:
      return "The brief could not be written this time. Nothing was lost or sent. Try again.";
  }
}

// What a press of the button did, from the reply's status and category.
export function writeOutcome(reply: { ok: boolean; error: string | null; data: Record<string, unknown> }): string {
  if (reply.ok) {
    const status = reply.data.status;
    const category = typeof reply.data.category === "string" ? reply.data.category : "";
    if (status === "drafted") return "The brief is written and every number checked.";
    if (status === "refused" || status === "over_cap") return refusalWords(category);
    return "The outcome is not known yet. The page reads it back.";
  }
  switch (reply.error) {
    case "exists":
      return "This week's brief is already written.";
    case "in_progress":
      return "A brief for this week is being written. It shows here when it is done.";
    case "open_period":
      return "This week is still open. A brief can be written once it closes.";
    case "no_loads":
      return "No delivered load was priced this week, so there is nothing to write about.";
    case "not_found":
      return "That week is not one of the closed weeks. Pick one above.";
    case "brief_off":
    case "disabled":
      return "Profit brief is off for this carrier. Nothing was sent.";
    case "ai_off":
    case "ai_disabled":
      return "The agent is off for this carrier. Nothing was sent.";
    case "forbidden":
    case "unauthenticated":
      return "You are signed out or not a member of this carrier. Sign in again.";
    case "unknown":
      return "The outcome is not known yet. The page reads it back.";
    default:
      return "The brief could not be written. Nothing was lost or sent. Try again.";
  }
}
