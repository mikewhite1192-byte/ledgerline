import type { Checklist } from "./checklist";

// The clean stop (design-agents-101 3.3): when a cap ends an answer or a run before it finished,
// the text says in plain words what was done and what is left, built from the checklist's states
// and the run's own count. It is written by code, never by a model call (what ran out is the
// budget), and it carries counts only, never an amount.

export const NOTHING_MOVED = "Nothing was paid or sent.";

function listed(texts: string[]): string {
  return texts.map((t) => t.replace(/[.\s]+$/, "")).join("; ");
}

export function stopSummary(list: Checklist, counts: { steps: number }): string {
  const steps = Math.max(0, Math.floor(counts.steps));
  const done = list.items.filter((i) => i.state === "done").map((i) => i.text);
  const left = list.items.filter((i) => i.state !== "done" && i.state !== "skipped").map((i) => i.text);
  const parts = [`I stopped after ${steps} ${steps === 1 ? "step" : "steps"}.`];
  parts.push(done.length > 0 ? `Done: ${listed(done)}.` : "Done: nothing yet.");
  if (left.length > 0) parts.push(`Not done: ${listed(left)}.`);
  parts.push(NOTHING_MOVED);
  return parts.join(" ");
}
