import { formatInstant } from "../format/dates";
import type { CollectionTone } from "../rules-engine/collections";

// The words the collections page shows, in code: no database, safe for a client component. Plain
// words only: a person reads "Waiting for you" and "Did not pass its check", never a status code,
// a category or a model name.

export const TONE_WORDS: Record<CollectionTone, string> = { friendly: "Friendly", direct: "Direct", firm: "Firm" };

export const TONE_HELP = "Chosen from how this customer has paid in the last 6 months";

export const REMINDER_STATUS_WORDS: Record<string, string> = {
  none: "No reminder yet",
  drafting: "Drafting",
  drafted: "Waiting for you",
  refused: "Did not pass its check",
  over_cap: "Not drafted yet",
  approved: "Approved",
  rejected: "Rejected",
};

// One sentence per reason a reminder was not kept. Exported so the plain-words test reads every one.
export const REFUSAL_WORDS: Record<string, string> = {
  number_mismatch: "it had a number that is not on the invoice.",
  line_mismatch: "it had a number that is not on the invoice.",
  subject: "its subject line did not name the invoice.",
  banned_phrase: "it used words a reminder must not use, like fees, interest or legal action.",
  language: "it was not in English.",
  format: "it was not a readable email.",
  incomplete: "it stopped early.",
  interrupted: "drafting stopped before it finished.",
  stage_passed: "the invoice reached its next reminder before this one was drafted.",
  disabled: "the models were switched off.",
  not_configured: "the model connection is not set up.",
  cap: "the model budget was used up.",
  job_cap: "drafting used up its budget for the hour.",
  too_expensive: "it would have cost more than its limit.",
  rate_limited: "the model was busy.",
  unavailable: "the model did not answer.",
  timeout: "the model did not answer in time.",
  network: "the model could not be reached.",
  bad_request: "the model could not read the request.",
  auth: "the model connection was not accepted.",
  billing: "the model account needs attention.",
  too_long: "the request was too long for the model.",
  unknown: "the model call failed.",
};

// "Did not pass its check, so it was not kept. Nothing was sent: it had a number that is not on
// the invoice." A failed reminder is final for its stage: the invoice's next stage gets a new one.
export function refusalWords(category: string | null): string {
  const reason = (category && REFUSAL_WORDS[category]) || "the model call failed.";
  return `Not kept, and nothing was sent: ${reason}`;
}

// What happened after approval. Email is off unless switched on for that exact address, so the
// usual line is "Approved, not sent (Test mode)".
export function approvedWords(channel: string | null, sentAt: string | null, timezone: string): string {
  if (channel === "email" && sentAt) return `Sent ${formatInstant(sentAt, timezone)}`;
  if (channel === "email") return "Email attempted, not confirmed as sent";
  return "Approved, not sent (Test mode)";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The toast after a run: "Drafted 3 reminders. 0 needed a second look."
export function draftedWords(drafted: number, refused: number): string {
  return `Drafted ${plural(drafted, "reminder", "reminders")}. ${refused} needed a second look.`;
}

// The line under the toast when a run did not reach every late invoice.
export function stillWaitingWords(waiting: number, stoppedBy: string | null): string | null {
  if (waiting <= 0) return null;
  const left = `${plural(waiting, "invoice still needs", "invoices still need")} a reminder.`;
  if (stoppedBy === "cap") return `${left} This run reached its spending limit. Press Draft reminders again.`;
  if (stoppedBy === "model") return `${left} The model did not answer. Try again in a moment.`;
  return `${left} Press Draft reminders again.`;
}

// Fixed words per refusal category from the routes; the raw reply never reaches the page.
export const DRAFT_ERROR_WORDS: Record<string, string> = {
  not_found: "Collections is switched off.",
  ai_off: "The models are switched off.",
  forbidden: "This login cannot draft reminders for this carrier.",
  unauthenticated: "Your session ended. Sign in again.",
};

export const DECIDE_ERROR_WORDS: Record<string, string> = {
  paid_since: "This invoice was paid after the reminder was drafted, so it was not approved. Reject it to clear it.",
  changed: "This invoice's balance changed after the reminder was drafted, so it was not approved. Reject it to clear it.",
  stage_passed:
    "This invoice reached its next reminder after this one was drafted, so it was not approved. Reject it to clear it.",
  already_decided: "Someone already decided this reminder.",
  not_approvable: "Only a reminder that passed its check can be decided.",
  not_found: "This reminder is not here.",
  forbidden: "This login cannot decide reminders for this carrier.",
  unauthenticated: "Your session ended. Sign in again.",
};

// A decision whose answer did not come back (the server failed partway): it may or may not have
// been saved, so the toast says neither, and the page is read again to show where it stands.
export const UNCONFIRMED_DECISION_WORDS = {
  title: "The decision was not confirmed",
  body: "It may or may not have been saved. The reminder below shows where it stands now.",
};

// The toast after an approval whose email may or may not have gone out.
export const EMAIL_UNCONFIRMED_WORDS = "An email was attempted, but it is not confirmed as sent.";
