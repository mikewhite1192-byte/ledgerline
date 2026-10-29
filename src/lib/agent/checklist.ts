import { z } from "zod";
import { houseDollars, maskFigures } from "./operator/figures";

// The checklist (design-agents-101 3.1): the short plan an answer or a run sets first and ticks
// as it goes, shown live above the steps. A model sets one through set_checklist; a run's own
// code sets its fixed phases. It is a note on the agent's own work, never a record: nothing in
// it is a number the engine computed, and nothing reads it to decide anything.

export const CHECKLIST_STATES = ["todo", "doing", "done", "skipped", "not_done"] as const;
export type ChecklistState = (typeof CHECKLIST_STATES)[number];

export const CHECKLIST_MAX_ITEMS = 12;
export const CHECKLIST_TEXT_MIN = 3;
export const CHECKLIST_TEXT_MAX = 80;

const KEY = /^[a-z0-9_]{1,20}$/;

export type ChecklistItem = { key: string; text: string; state: ChecklistState };
export type Checklist = { v: 1; by: "model" | "run"; items: ChecklistItem[] };

// What a model sends: the whole list each time, a state per item (todo when left out).
export type ChecklistDraft = { items: { text: string; state: ChecklistState }[] };

const itemText = () => z.string().trim().min(CHECKLIST_TEXT_MIN).max(CHECKLIST_TEXT_MAX);

// The model's arguments to set_checklist. A second call replaces the whole list.
export const checklistArgs = z.strictObject({
  items: z
    .array(
      z.strictObject({
        text: itemText(),
        state: z.enum(CHECKLIST_STATES).optional(),
      }),
    )
    .min(1)
    .max(CHECKLIST_MAX_ITEMS),
});

// The stored shape, checked on every write and on every read back.
export const checklistSchema = z.strictObject({
  v: z.literal(1),
  by: z.enum(["model", "run"]),
  items: z
    .array(
      z.strictObject({
        key: z.string().regex(KEY),
        text: itemText(),
        state: z.enum(CHECKLIST_STATES),
      }),
    )
    .min(1)
    .max(CHECKLIST_MAX_ITEMS),
});

// A stored checklist, or null for anything that is not one (an old row, a hand edit): a bad value
// shows no checklist, never a broken one.
export function parseChecklist(value: unknown): Checklist | null {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (raw === null || raw === undefined) return null;
  const parsed = checklistSchema.safeParse(raw);
  return parsed.success ? (parsed.data as Checklist) : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// One item's text as it is shown: spaces collapsed, any dollar or cents figure that did not come
// from a record withheld (the same rule as an answer), and a kept dollar figure written with its
// cents. A text the mask made too long is cut.
function shownText(text: string, allowedCents: ReadonlySet<number>): string {
  const plain = text.replace(/\s+/g, " ").trim();
  const masked = houseDollars(maskFigures(plain, allowedCents).text);
  if (masked.length <= CHECKLIST_TEXT_MAX) return masked;
  return `${masked.slice(0, CHECKLIST_TEXT_MAX - 1).trimEnd()}…`;
}

// The model's list as it is stored: keys by position, every state set, every text masked.
export function modelChecklist(draft: ChecklistDraft, allowedCents: ReadonlySet<number>): Checklist {
  const items = draft.items.slice(0, CHECKLIST_MAX_ITEMS).map((item, i) => ({
    key: `m${i + 1}`,
    text: shownText(item.text, allowedCents),
    state: item.state,
  }));
  return checklistSchema.parse({ v: 1, by: "model", items }) as Checklist;
}

// How the list reads once the answer has ended. An item still being worked on is done when the
// answer finished, and not finished when it stopped or failed; an item never started is not
// finished either way. Done and skipped stay. Nothing is ever moved up past what the model said
// except the items in hand when the answer finished.
export function finalChecklist(list: Checklist, ended: "done" | "partial" | "failed"): Checklist {
  return {
    ...list,
    items: list.items.map((item) => {
      if (item.state === "doing") return { ...item, state: ended === "done" ? "done" : "not_done" };
      if (item.state === "todo") return { ...item, state: "not_done" };
      return item;
    }),
  };
}

export function sameChecklist(a: Checklist | null, b: Checklist | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
