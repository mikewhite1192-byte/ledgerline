// The card's greeting, by the carrier's name (the only name the app holds for a signed-in person),
// or a plain hello when it has none.
export function greetingLine(name: string | null | undefined): string {
  const n = name?.trim();
  return n ? `Hey, ${n}. How can I be helpful?` : "Hey there. How can I be helpful?";
}

// The product's promise, under the greeting.
export const TRUST_LINE = "Every number comes from your records, and nothing is paid or sent until you approve it.";

// The agent's questions on the launcher and in the thread (./ask-card.tsx). The question itself
// comes from the server, written by code (src/lib/asks/words.ts); these are the words around it.
export const ASK_WORDS = {
  yes: "Yes",
  notNow: "Not now",
  question: "Ask a question",
  gotIt: "Got it",
  close: "Close this question",
  arrivedAsk: "New question from the agent",
  arrivedTold: "New note from the agent",
  region: "The agent's questions",
} as const;

// "2 more waiting", under the bubble while others show too.
export function moreWaiting(n: number): string | null {
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n === 1 ? "1 more waiting" : `${n} more waiting`;
}

// The badge on the launcher: how many questions show now, at most "9+".
export function badgeCount(n: number): string | null {
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n > 9 ? "9+" : String(n);
}

// After Yes went through the usual approve path. "done" means the executor finished; any other
// status is still finishing, so the line never says more than happened.
export function yesConfirmation(proposalKind: string, status: unknown): string {
  if (status !== "done") return "Approved. It is finishing now.";
  if (proposalKind === "advance_payout") return "Sent. The advance is on its way.";
  if (proposalKind === "invoice_post") return "Posted to QuickBooks sandbox.";
  return "Done. It went through the usual checks.";
}

// When Yes did not go through: a fixed sentence per category, never the server's own text.
const YES_REFUSED: Readonly<Record<string, string>> = {
  needs_confirm: "This one needs a closer look first. Open it from Needs you on Home.",
  override_required: "This one needs a closer look first. Open it from Needs you on Home.",
  engine_override_required: "This one needs a closer look first. Open it from Needs you on Home.",
  // Stale can also come from the step that runs after the approval, so this never says nothing was done.
  stale: "Something changed since this showed. Check Needs you before trying again.",
  auditor_required: "This waits for the second check. Try again in a minute.",
  not_auditable: "This was made before the second check started. Open it from Needs you on Home.",
  already_decided: "This was already decided.",
  expired: "This expired. Nothing changed.",
  role: "An admin must approve an amount this size.",
  not_found: "This is no longer waiting.",
  unauthenticated: "Your sign-in ended. Sign in again.",
};

// The request may have reached the server before the reply was lost.
export const YES_UNKNOWN = "We could not tell if that went through. Check Needs you before trying again.";
export const STEP_FAILED = "That did not go through. Try again.";

// A category not listed may come from the step that runs after the approval is recorded, so its
// outcome is unknown, never "nothing changed".
export function yesRefused(category: unknown, staffOnly: string): string {
  if (category === "judge") return staffOnly;
  return typeof category === "string" && Object.prototype.hasOwnProperty.call(YES_REFUSED, category)
    ? YES_REFUSED[category]
    : YES_UNKNOWN;
}

// Yes found the question already settled elsewhere: the bubble lets it go with its line.
export const YES_SETTLED: ReadonlySet<string> = new Set(["not_found", "already_decided", "expired"]);
