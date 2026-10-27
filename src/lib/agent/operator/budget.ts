import { CALL_MARGIN_MS } from "../policy";

// One turn's hard caps (design 2.2): tool steps, model calls, cents and the wall clock. Reaching
// any of them ends the turn with what it found so far. The clock is injected.

export type TurnLimits = {
  maxToolSteps: number;
  maxModelCalls: number;
  maxTurnCents: number;
  wallClockMs: number;
  summaryChars: number;
};

export type CapReason = "steps" | "model_calls" | "cents" | "clock";

const NANOCENTS_PER_CENT = 1_000_000_000;

export class TurnBudget {
  readonly deadlineAt: number;
  toolSteps = 0;
  modelCalls = 0;
  costNanocents = 0;

  constructor(
    private readonly limits: TurnLimits,
    startedAt: number,
    private readonly clock: () => number,
  ) {
    this.deadlineAt = startedAt + limits.wallClockMs;
  }

  remainingMs(): number {
    return this.deadlineAt - this.clock();
  }

  // Whole cents left under the turn's cap.
  centsLeft(): number {
    return Math.floor((this.limits.maxTurnCents * NANOCENTS_PER_CENT - this.costNanocents) / NANOCENTS_PER_CENT);
  }

  // The cap that stops the next model call, if any.
  beforeModelCall(): CapReason | null {
    if (this.modelCalls >= this.limits.maxModelCalls) return "model_calls";
    if (this.centsLeft() < 1) return "cents";
    if (this.remainingMs() <= CALL_MARGIN_MS) return "clock";
    return null;
  }

  // The cap that stops the next tool step, if any.
  beforeToolStep(): CapReason | null {
    if (this.toolSteps >= this.limits.maxToolSteps) return "steps";
    if (this.remainingMs() <= 0) return "clock";
    return null;
  }

  addModelCall(costNanocents: number): void {
    this.modelCalls += 1;
    if (Number.isSafeInteger(costNanocents) && costNanocents > 0) this.costNanocents += costNanocents;
  }

  addToolStep(): void {
    this.toolSteps += 1;
  }
}
