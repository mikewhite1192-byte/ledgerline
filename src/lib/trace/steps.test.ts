import { describe, expect, it } from "vitest";
import { assembleSummary } from "@/lib/agent/gateway/store/summary";
import { NOTES_TITLE } from "@/lib/memory/notes";
import { SAMPLE_CONTEXT_SUMMARY, SAMPLE_REASONING_NOTE, sampleTrace } from "./sample";
import { NO_NOTE, OTHER_PART, summaryShape, turnsOf } from "./steps";
import type { TraceDecision, TraceStep, TurnTrace } from "./types";

function step(over: Partial<TraceStep> & Pick<TraceStep, "seq" | "kind" | "label">): TraceStep {
  return {
    state: "done",
    call: null,
    decision: null,
    proposalId: null,
    category: null,
    result: null,
    toolCalls: null,
    toolSearches: null,
    incomplete: false,
    escalation: null,
    ...over,
  };
}

function allowed(n: number, tool: string, over: Partial<TraceDecision> = {}): TraceDecision {
  return {
    id: `d0000009-0000-4000-8000-00000000000${n}`,
    tool,
    decision: "allowed",
    reason: "ok",
    limitCents: null,
    issuedBy: null,
    refs: [],
    ...over,
  };
}

function traceOf(steps: TraceStep[], over: Partial<TurnTrace> = {}): TurnTrace {
  return { ...sampleTrace(), steps, extraCalls: [], proposals: [], contextSummary: undefined, ...over };
}

describe("turnsOf", () => {
  it("makes one turn per model call, with what it asked for and what came back", () => {
    const through = turnsOf(sampleTrace());
    expect(through.turns.map((t) => t.key)).toEqual(["turn:1", "turn:3", "turn:5", "turn:8"]);
    const [first, second, third, last] = through.turns;
    expect(first.asked).toEqual(["Reading pay items"]);
    // The safety check, then the screening of outside text that ran after it.
    expect(first.got.map((l) => l.key)).toEqual(["step:2", "call:c0000001-0000-4000-8000-000000000005"]);
    expect(first.got[0].meta).toEqual(["2 records", "1,240 characters back"]);
    expect(second.asked).toEqual(["Checking advance eligibility"]);
    expect(second.got[0].text).toBe("Checking advance eligibility: blocked, the amount is over the eligible limit ($412.00)");
    // A blocked call records no result size, so none is shown.
    expect(second.got[0].meta).toEqual([]);
    expect(third.got.map((l) => l.key)).toEqual(["step:6", "step:7"]);
    expect(third.got[1].text).toBe("Saved the card for a person to approve");
    expect(last.asked).toEqual([]);
    expect(last.got).toEqual([]);
    expect(last.answered).toBe(true);
    expect([first, second, third].every((t) => !t.answered)).toBe(true);
  });

  it("gives each call what the earlier calls' tools sent back, and nothing of its own", () => {
    const [first, second, third, last] = turnsOf(sampleTrace()).turns;
    expect(first.earlier).toEqual([]);
    expect(second.earlier.map((l) => l.key)).toEqual(["step:2"]);
    expect(third.earlier.map((l) => l.key)).toEqual(["step:2", "step:4"]);
    expect(last.earlier.map((l) => l.key)).toEqual(["step:2", "step:4", "step:6"]);
  });

  it("keeps a model call's own note, and none for a call without one", () => {
    const turns = turnsOf(sampleTrace()).turns;
    expect(turns.map((t) => t.note)).toEqual([null, SAMPLE_REASONING_NOTE, null, null]);
    // A blank note is no note.
    const blank = traceOf([step({ seq: 1, kind: "model", label: "Thinking it through", reasoningNote: "  \n " })]);
    expect(turnsOf(blank).turns[0].note).toBeNull();
    expect(NO_NOTE).toBe("No note was returned for this step.");
  });

  it("groups three tool calls, a hand-off and a card under the call that asked for them", () => {
    const trace = traceOf([
      step({ seq: 1, kind: "model", label: "Thinking it through", toolCalls: 3 }),
      step({ seq: 2, kind: "tool", label: "Reading the pay ledger", decision: allowed(1, "get_pay_items", { resultChars: 0 }) }),
      step({ seq: 3, kind: "tool", label: "Reading the driver", decision: allowed(2, "get_driver") }),
      step({ seq: 4, kind: "tool", label: "Checking advance eligibility", decision: allowed(3, "propose_advance", { resultChars: 1 }) }),
      step({ seq: 5, kind: "escalation", label: "Asking Muse Wonder", escalation: { attempts: 1, finishedBy: "wonder" } }),
      step({ seq: 6, kind: "proposal", label: "Preparing a proposal card", result: "created" }),
      step({ seq: 7, kind: "model", label: "Thinking it through", toolCalls: 0 }),
    ]);
    const [first, second] = turnsOf(trace).turns;
    // Each tool by its step's words, the way the list names it.
    expect(first.asked).toEqual(["Reading the pay records", "Reading the driver", "Checking advance eligibility"]);
    expect(first.got.map((l) => l.key)).toEqual(["step:2", "step:3", "step:4", "step:5", "step:6"]);
    expect(first.got[0].meta).toContain("0 characters back");
    expect(first.got[1].meta).toEqual([]);
    expect(first.got[2].meta).toContain("1 character back");
    expect(first.answered).toBe(false);
    // The hand-off and the card are not tools, so the next call does not see them as sent back.
    expect(second.earlier.map((l) => l.key)).toEqual(["step:2", "step:3", "step:4"]);
    expect(second.got).toEqual([]);
    expect(second.answered).toBe(true);
  });

  it("shows no result size it cannot trust", () => {
    for (const resultChars of [-1, 1.5, Number.NaN]) {
      const trace = traceOf([
        step({ seq: 1, kind: "model", label: "Thinking it through", toolCalls: 1 }),
        step({ seq: 2, kind: "tool", label: "Reading the driver", decision: allowed(1, "get_driver", { resultChars }) }),
      ]);
      expect(turnsOf(trace).turns[0].got[0].meta.join(" ")).not.toContain("back");
    }
  });

  it("puts what was read ahead of the first call on the first turn only", () => {
    const trace = traceOf([
      step({ seq: 1, kind: "screen", label: "screen" }),
      step({ seq: 2, kind: "model", label: "Thinking it through", toolCalls: 0 }),
      step({ seq: 3, kind: "model", label: "Thinking it through", toolCalls: 0 }),
    ]);
    const [first, second] = turnsOf(trace).turns;
    expect(first.before.map((l) => l.key)).toEqual(["step:1"]);
    expect(second.before).toEqual([]);
  });

  it("does not call a model step that failed or was cut off the answer", () => {
    const trace = traceOf([step({ seq: 1, kind: "model", label: "Thinking it through", state: "failed", toolCalls: 0 })]);
    expect(turnsOf(trace).turns[0].answered).toBe(false);
  });

  it("has no turns when no model was called", () => {
    const trace = traceOf([step({ seq: 1, kind: "tool", label: "get_pay_items" })]);
    expect(turnsOf(trace).turns).toEqual([]);
    expect(turnsOf(traceOf([])).turns).toEqual([]);
  });

  it("keeps the summary and its shape, or neither when none was kept", () => {
    const through = turnsOf(sampleTrace());
    expect(through.summaryText).toBe(SAMPLE_CONTEXT_SUMMARY);
    expect(through.summary?.chars).toBe(SAMPLE_CONTEXT_SUMMARY.length);
    const none = turnsOf(traceOf([]));
    expect(none.summary).toBeNull();
    expect(none.summaryText).toBeNull();
    const blank = turnsOf(traceOf([], { contextSummary: " \n " }));
    expect(blank.summary).toBeNull();
    expect(blank.summaryText).toBeNull();
  });
});

describe("summaryShape", () => {
  it("reads each section the summary is built with, in a person's words, and skips the header", () => {
    const titles = [
      "Carrier",
      "Pay rules",
      "Subject",
      "Voice note to handle",
      "Earlier in this conversation",
      "Proposals in this conversation",
      "Refused tool calls in this conversation",
      NOTES_TITLE,
    ];
    const text = assembleSummary(
      titles.map((title, i) => ({ title, lines: Array.from({ length: i + 1 }, (_, n) => `line ${n}`), maxChars: 10_000 })),
      100_000,
    );
    const shape = summaryShape(text);
    expect(shape.chars).toBe(text.length);
    expect(shape.parts).toEqual([
      { title: "Your carrier, its time zone and today's date", lines: 1 },
      { title: "Your pay rules", lines: 2 },
      { title: "Who or what the question is about", lines: 3 },
      { title: "The voice note to handle", lines: 4 },
      { title: "Earlier answers in this conversation", lines: 5 },
      { title: "Cards in this conversation", lines: 6 },
      { title: "Requests refused earlier in this conversation", lines: 7 },
      { title: "Notes from the office", lines: 8 },
    ]);
  });

  it("names a section it does not know as other details, never by its own title", () => {
    const shape = summaryShape(assembleSummary([{ title: "Gateway internals", lines: ["a", "b"], maxChars: 100 }], 1_000));
    expect(shape.parts).toEqual([{ title: OTHER_PART, lines: 2 }]);
    expect(JSON.stringify(shape)).not.toContain("Gateway");
  });

  it("leaves out a section cut down to its title and text that is not a section", () => {
    expect(summaryShape("Carrier:\n\nloose words\nmore words\n\n").parts).toEqual([]);
    expect(summaryShape("").parts).toEqual([]);
    // A summary cut to the turn's cap keeps the sections that are left.
    const cut = assembleSummary(
      [
        { title: "Carrier", lines: ["a", "b"], maxChars: 100 },
        { title: "Pay rules", lines: ["c".repeat(200)], maxChars: 300 },
      ],
      100,
    );
    expect(summaryShape(cut).parts.map((p) => p.title)).toEqual(["Your carrier, its time zone and today's date", "Your pay rules"]);
  });
});
