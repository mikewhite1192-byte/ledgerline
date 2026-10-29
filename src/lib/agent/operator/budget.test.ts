import { describe, expect, it } from "vitest";
import { TurnBudget } from "./budget";

const LIMITS = { maxToolSteps: 2, maxModelCalls: 2, maxTurnCents: 3, wallClockMs: 10_000, summaryChars: 100 };

describe("TurnBudget", () => {
  it("lets the first call and step through", () => {
    const b = new TurnBudget(LIMITS, 0, () => 0);
    expect(b.beforeModelCall()).toBeNull();
    expect(b.beforeToolStep()).toBeNull();
    expect(b.deadlineAt).toBe(10_000);
  });

  it("ends at the model call cap", () => {
    const b = new TurnBudget(LIMITS, 0, () => 0);
    b.addModelCall(1);
    b.addModelCall(1);
    expect(b.beforeModelCall()).toBe("model_calls");
  });

  it("ends when less than a cent is left", () => {
    const b = new TurnBudget(LIMITS, 0, () => 0);
    b.addModelCall(2_500_000_000);
    expect(b.centsLeft()).toBe(0);
    expect(b.beforeModelCall()).toBe("cents");
  });

  it("ends on the clock, leaving a margin for the call", () => {
    let now = 0;
    const b = new TurnBudget(LIMITS, 0, () => now);
    now = 8_600;
    expect(b.beforeModelCall()).toBe("clock");
    expect(b.beforeToolStep()).toBeNull();
    now = 10_000;
    expect(b.beforeToolStep()).toBe("clock");
  });

  it("ends at the tool step cap", () => {
    const b = new TurnBudget(LIMITS, 0, () => 0);
    b.addToolStep();
    b.addToolStep();
    expect(b.beforeToolStep()).toBe("steps");
  });

  it("ignores a cost that is not a whole positive number", () => {
    const b = new TurnBudget(LIMITS, 0, () => 0);
    b.addModelCall(Number.NaN);
    b.addModelCall(-5);
    b.addModelCall(1.5);
    expect(b.costNanocents).toBe(0);
    expect(b.modelCalls).toBe(3);
  });

  it("stops at the smaller of max turns and the model call cap, and never loosens either", () => {
    const tight = new TurnBudget({ ...LIMITS, maxModelCalls: 4, maxTurns: 2 }, 0, () => 0);
    tight.addModelCall(1);
    expect(tight.beforeModelCall()).toBeNull();
    tight.addModelCall(1);
    expect(tight.beforeModelCall()).toBe("max_turns");
    // With the chat's own cap the tighter one, max turns never changes when it stops.
    const chat = new TurnBudget({ ...LIMITS, maxModelCalls: 2, maxTurns: 30 }, 0, () => 0);
    chat.addModelCall(1);
    chat.addModelCall(1);
    expect(chat.beforeModelCall()).toBe("model_calls");
    // Equal: the existing cap names the stop.
    const equal = new TurnBudget({ ...LIMITS, maxModelCalls: 2, maxTurns: 2 }, 0, () => 0);
    equal.addModelCall(1);
    equal.addModelCall(1);
    expect(equal.beforeModelCall()).toBe("model_calls");
    // Absent: today's caps only.
    const none = new TurnBudget(LIMITS, 0, () => 0);
    none.addModelCall(1);
    expect(none.beforeModelCall()).toBeNull();
  });
});
