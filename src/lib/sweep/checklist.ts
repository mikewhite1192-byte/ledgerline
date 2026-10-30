import { checklistSchema, parseChecklist, type Checklist, type ChecklistItem } from "../agent/checklist";
import type { Queryable } from "../db";

// The sweep's checklist (design-agents-101 3.1): the run's own phases in a clerk's words, written
// by the run's code when the run starts and ticked in the same update that moves the phase. No
// model writes it and nothing reads it to decide anything; a run started before the column
// existed has none and keeps none.

export type SweepPhase = "find" | "plan" | "check" | "reconcile" | "draft" | "audit" | "done";

export const SWEEP_CHECKLIST_TEXT = {
  find: "Find every pay problem in the open week",
  plan: "Plan a second look at each driver",
  check: "Check each driver's week",
  draft: "Draft a fix for each problem",
  audit: "Run the second check on every draft",
} as const;

type Key = keyof typeof SWEEP_CHECKLIST_TEXT;

// The second look (plan, then check each driver) is one piece: it is done when the run reached
// the check, and skipped as a whole when the run went to drafting without it.
const SECOND_LOOK: readonly Key[] = ["plan", "check"];

// The list a run starts with: finding is under way, the rest to do. The second look is listed
// only when the run starts with room for it.
export function sweepChecklist(secondLook: boolean): Checklist {
  const keys: Key[] = secondLook ? ["find", "plan", "check", "draft", "audit"] : ["find", "draft", "audit"];
  const items: ChecklistItem[] = keys.map((key, i) => ({ key, text: SWEEP_CHECKLIST_TEXT[key], state: i === 0 ? "doing" : "todo" }));
  return checklistSchema.parse({ v: 1, by: "run", items }) as Checklist;
}

const itemOf = (phase: SweepPhase): Key | null =>
  phase === "reconcile" ? "check" : phase === "done" ? null : phase;

// The list once the run has moved to a phase: everything before it is done (or skipped, when the
// run never started it), the phase's own item is in hand, the rest stay to do. A phase the list
// does not name changes nothing.
export function tickSweep(list: Checklist, phase: SweepPhase): Checklist {
  const at = itemOf(phase);
  const index = at ? list.items.findIndex((i) => i.key === at) : -1;
  if (index < 0) return list;
  const reachedCheck = at === "check" || list.items.some((i) => i.key === "check" && (i.state === "doing" || i.state === "done"));
  return {
    ...list,
    items: list.items.map((item, i) => {
      if (i === index) return item.state === "done" ? item : { ...item, state: "doing" };
      if (i > index || item.state === "done" || item.state === "skipped") return item;
      if (SECOND_LOOK.includes(item.key as Key)) return { ...item, state: reachedCheck ? "done" : "skipped" };
      return { ...item, state: item.state === "doing" ? "done" : "skipped" };
    }),
  };
}

// The list once the run has ended. Finished: the item in hand is done (skipped when the step was
// switched off), anything never started is skipped. Stopped at its cap or failed: whatever was not
// done is not finished; the next run picks those findings up. Stopped after an item ran to its
// end (stoppedAfter: the turn ceiling left findings for the next run, but the second check ran on
// every draft): that item and the ones before it are done, the rest not finished.
export function endSweep(
  list: Checklist,
  ended: "done" | "stopped" | "failed",
  opts: { skipped?: Key; stoppedAfter?: Key } = {},
): Checklist {
  const after = ended === "stopped" && opts.stoppedAfter ? list.items.findIndex((i) => i.key === opts.stoppedAfter) : -1;
  return {
    ...list,
    items: list.items.map((item, i) => {
      if (item.state === "done" || item.state === "skipped") return item;
      if (ended !== "done") return { ...item, state: i <= after ? "done" : "not_done" };
      if (item.key === opts.skipped) return { ...item, state: "skipped" };
      return { ...item, state: item.state === "doing" ? "done" : "skipped" };
    }),
  };
}

export type SweepChecklistChange =
  | { phase: SweepPhase }
  | { ended: "done" | "stopped" | "failed"; skipped?: Key; stoppedAfter?: Key };

// The run's ticked list as JSON for the update that moves the phase, read inside the same
// transaction (the run row is locked by then). Null when the run has no list: the update keeps
// the column as it is (COALESCE), so an older run stays without one.
export async function nextSweepChecklist(q: Queryable, runId: string, change: SweepChecklistChange): Promise<string | null> {
  const rows = await q.query<{ checklist: string | null }>(
    "SELECT CAST(checklist AS text) AS checklist FROM sweep_runs WHERE id = CAST($1 AS uuid)",
    [runId],
  );
  const list = parseChecklist(rows[0]?.checklist ?? null);
  if (!list) return null;
  const next =
    "phase" in change
      ? tickSweep(list, change.phase)
      : endSweep(list, change.ended, { skipped: change.skipped, stoppedAfter: change.stoppedAfter });
  return JSON.stringify(checklistSchema.parse(next));
}
