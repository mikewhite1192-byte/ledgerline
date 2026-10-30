import { describe, expect, it } from "vitest";
import { checklistSchema } from "../agent/checklist";
import { endSweep, sweepChecklist, SWEEP_CHECKLIST_TEXT, tickSweep } from "./checklist";

const states = (l: ReturnType<typeof sweepChecklist>) => Object.fromEntries(l.items.map((i) => [i.key, i.state]));

describe("the sweep's checklist", () => {
  it("starts with finding under way, the second look listed only with room for it", () => {
    const plain = sweepChecklist(false);
    expect(plain).toEqual({
      v: 1,
      by: "run",
      items: [
        { key: "find", text: SWEEP_CHECKLIST_TEXT.find, state: "doing" },
        { key: "draft", text: SWEEP_CHECKLIST_TEXT.draft, state: "todo" },
        { key: "audit", text: SWEEP_CHECKLIST_TEXT.audit, state: "todo" },
      ],
    });
    expect(sweepChecklist(true).items.map((i) => i.key)).toEqual(["find", "plan", "check", "draft", "audit"]);
    expect(checklistSchema.safeParse(sweepChecklist(true)).success).toBe(true);
  });

  it("ticks each phase as the run moves through it, the comparison under the check", () => {
    let l = sweepChecklist(true);
    l = tickSweep(l, "plan");
    expect(states(l)).toEqual({ find: "done", plan: "doing", check: "todo", draft: "todo", audit: "todo" });
    l = tickSweep(l, "check");
    expect(states(l)).toEqual({ find: "done", plan: "done", check: "doing", draft: "todo", audit: "todo" });
    l = tickSweep(l, "reconcile");
    expect(states(l)).toEqual({ find: "done", plan: "done", check: "doing", draft: "todo", audit: "todo" });
    l = tickSweep(l, "draft");
    expect(states(l)).toEqual({ find: "done", plan: "done", check: "done", draft: "doing", audit: "todo" });
    l = tickSweep(l, "audit");
    expect(states(l)).toEqual({ find: "done", plan: "done", check: "done", draft: "done", audit: "doing" });
    expect(states(endSweep(l, "done"))).toEqual({ find: "done", plan: "done", check: "done", draft: "done", audit: "done" });
  });

  it("skips the whole second look when the run goes to drafting without it", () => {
    const straight = tickSweep(sweepChecklist(true), "draft");
    expect(states(straight)).toEqual({ find: "done", plan: "skipped", check: "skipped", draft: "doing", audit: "todo" });
    // Planning started, then the daily limit or the switch sent the run to drafting.
    const afterPlan = tickSweep(tickSweep(sweepChecklist(true), "plan"), "draft");
    expect(states(afterPlan)).toEqual({ find: "done", plan: "skipped", check: "skipped", draft: "doing", audit: "todo" });
  });

  it("changes nothing for a phase the list does not name, and never moves an item back", () => {
    const plain = tickSweep(sweepChecklist(false), "draft");
    expect(tickSweep(plain, "plan")).toEqual(plain);
    expect(tickSweep(plain, "done")).toEqual(plain);
    const audited = tickSweep(plain, "audit");
    expect(states(tickSweep(audited, "draft"))).toEqual({ find: "done", draft: "done", audit: "doing" });
  });

  it("says what was not finished when a cap or a failure ends the run", () => {
    const drafting = tickSweep(sweepChecklist(false), "draft");
    expect(states(endSweep(drafting, "stopped"))).toEqual({ find: "done", draft: "not_done", audit: "not_done" });
    expect(states(endSweep(sweepChecklist(true), "failed"))).toEqual({
      find: "not_done",
      plan: "not_done",
      check: "not_done",
      draft: "not_done",
      audit: "not_done",
    });
  });

  it("marks the second check done when the turn ceiling stopped the run after it ran", () => {
    const auditing = tickSweep(tickSweep(sweepChecklist(false), "draft"), "audit");
    expect(states(endSweep(auditing, "stopped", { stoppedAfter: "audit" }))).toEqual({ find: "done", draft: "done", audit: "done" });
    // Only a stop ticks it: a failure still leaves it not finished.
    expect(states(endSweep(auditing, "failed", { stoppedAfter: "audit" }))).toEqual({ find: "done", draft: "done", audit: "not_done" });
    // A stop while drafting ticks nothing past the item in hand.
    const drafting = tickSweep(sweepChecklist(false), "draft");
    expect(states(endSweep(drafting, "stopped", { stoppedAfter: "draft" }))).toEqual({ find: "done", draft: "done", audit: "not_done" });
  });

  it("marks the second check skipped, not done, when it was switched off", () => {
    const auditing = tickSweep(tickSweep(sweepChecklist(false), "draft"), "audit");
    expect(states(endSweep(auditing, "done", { skipped: "audit" }))).toEqual({ find: "done", draft: "done", audit: "skipped" });
  });
});
