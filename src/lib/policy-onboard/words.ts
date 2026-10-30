import type { Checklist, ChecklistState } from "../agent/checklist";

// Every sentence a policy run shows: the step labels, the checklist and the end of the turn. Fixed
// strings only, never model text, never a figure; the screens (a later change) add their own
// words here.

export const STEP_LABELS = {
  read: "Read the document",
  screen: "Check the text",
  propose: "Find each pay rule",
  check: "Second check",
} as const;

// The run's checklist, in the order the page shows it.
export const CHECKLIST_ITEMS = [
  { key: "read", text: "Read the document into numbered sections" },
  { key: "screen", text: "Check the text for anything that is not a policy" },
  { key: "map", text: "Find each pay rule and the sentence it comes from" },
  { key: "check", text: "Check every number against its sentence" },
  { key: "flag", text: "Note anything the document says twice or not at all" },
  { key: "card", text: "Prepare the card for your approval" },
] as const;

export type ChecklistKey = (typeof CHECKLIST_ITEMS)[number]["key"];

export function checklistOf(states: Partial<Record<ChecklistKey, ChecklistState>>): Checklist {
  return {
    v: 1,
    by: "run",
    items: CHECKLIST_ITEMS.map((i) => ({ key: i.key, text: i.text, state: states[i.key] ?? "todo" })),
  };
}

// How a run ended: the turn's ended_reason, its text and its summary line.
export const END_WORDS = {
  card_ready: "Your proposed pay rules are ready for your approval. Nothing changes until you approve.",
  unreadable: "We could not read this file. Nothing changed.",
  budget: "Reading stopped at the spending cap. Nothing changed.",
  flagged: "Some of this text did not read as a pay policy, so it was not used. Nothing changed.",
  nothing_found: "We found no pay rules in this document. Nothing changed.",
  no_change: "Every pay rule this document states matches your current rules. Nothing changed.",
  no_pay_config: "This carrier has no pay rules to start from yet. Nothing changed.",
  cannot_start: "These rules have no week they can start in yet. Nothing changed.",
  live_exists: "A card from a policy is already approved and being saved. Nothing changed.",
  already_decided: "A card with these same rules was already decided. Nothing changed.",
  attempt_limit: "This file has been read as many times as allowed. Nothing changed.",
  stalled: "Something went wrong, nothing changed.",
  error: "Something went wrong, nothing changed.",
} as const;

export type EndReason = keyof typeof END_WORDS;
