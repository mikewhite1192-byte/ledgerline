import { describe, expect, it } from "vitest";
import { LOOP_TEXT } from "./policy";
import { answerTextOf, FOUND_TEXT, STOPPED_TEXT, turnErrorFor, type TurnView } from "./view";

// Which error state the chat shows for a failed turn, from the reason it ended.

describe("turnErrorFor", () => {
  it("shows the budget, the stopped job and the timeout states, and unknown for the rest", () => {
    expect(turnErrorFor("failed", "budget")).toBe("budget");
    expect(turnErrorFor("failed", "job_cap")).toBe("job_cap");
    expect(turnErrorFor("failed", "clock")).toBe("timeout");
    expect(turnErrorFor("failed", "model_timeout")).toBe("timeout");
    expect(turnErrorFor("failed", "job")).toBe("unknown");
    expect(turnErrorFor("failed", null)).toBe("unknown");
  });

  it("shows no error for a turn that did not fail", () => {
    for (const status of ["running", "done", "partial"] as const) {
      expect(turnErrorFor(status, "job_cap")).toBeNull();
    }
  });
});

describe("answerTextOf", () => {
  const turn = (over: Partial<TurnView>): Pick<TurnView, "status" | "text" | "proposals" | "reports"> => ({
    status: "partial",
    text: STOPPED_TEXT,
    proposals: [],
    reports: [],
    ...over,
  });
  const card = { id: "p1" } as TurnView["proposals"][number];
  const report = { stepId: "s1", name: "aging", args: {} } as unknown as TurnView["reports"][number];

  it("holds the same sentence the loop writes", () => {
    expect(STOPPED_TEXT).toBe(LOOP_TEXT.stopped);
  });

  it("says what it found when a stopped turn still has a card or a report", () => {
    expect(answerTextOf(turn({ proposals: [card] }))).toBe(FOUND_TEXT);
    expect(answerTextOf(turn({ reports: [report] }))).toBe(FOUND_TEXT);
    expect(answerTextOf(turn({ proposals: [card], text: `${STOPPED_TEXT}\n\nTwo drivers are short.` }))).toBe(
      `${FOUND_TEXT}\n\nTwo drivers are short.`,
    );
  });

  it("keeps saying it stopped when there is nothing to show", () => {
    expect(answerTextOf(turn({}))).toBe(STOPPED_TEXT);
    expect(answerTextOf(turn({ text: `${STOPPED_TEXT}\n\nPartial words.` }))).toBe(`${STOPPED_TEXT}\n\nPartial words.`);
  });

  it("leaves a finished turn and any other text alone", () => {
    expect(answerTextOf(turn({ status: "done", proposals: [card] }))).toBe(STOPPED_TEXT);
    expect(answerTextOf(turn({ text: "All paid.", proposals: [card] }))).toBe("All paid.");
  });
});
