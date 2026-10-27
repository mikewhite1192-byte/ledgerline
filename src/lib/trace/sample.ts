import type { TraceCall, TurnTrace } from "./types";

// A made-up turn for the design page and the tests: an advance asked for over the limit, blocked,
// asked again at the limit, saved as a card, checked by the auditor. Synthetic ids only.

export const SAMPLE_TURN_ID = "7a1e0c2b-4f7d-4c1a-9e55-0c3f2b8d6a10";
export const SAMPLE_PROPOSAL_ID = "5b2f8e41-0d6c-4a3e-8b17-9c4d2e6f1a20";
export const SAMPLE_PAY_ITEM_ID = "3c9d1f70-6e2a-4b8c-a5d4-1e7f0b3c9a30";
export const SAMPLE_DRIVER_ID = "8e4a2c16-9b3d-4f7e-b2a8-6d1c5e9f0a40";

const call = (id: string, over: Partial<TraceCall>): TraceCall => ({
  id,
  target: "spark",
  model: "muse-spark-1.3",
  purpose: "agent_operator_turn",
  effort: "low",
  status: "ok",
  failure: null,
  durationMs: 1_000,
  costNanocents: 100_000_000,
  inputTokens: null,
  cachedTokens: null,
  savedNanocents: null,
  ...over,
});

export const SAMPLE_CALLS = {
  plan: call("c0000001-0000-4000-8000-000000000001", { durationMs: 1_840, costNanocents: 700_000_000 }),
  ask: call("c0000001-0000-4000-8000-000000000002", { durationMs: 2_100, costNanocents: 650_000_000 }),
  retry: call("c0000001-0000-4000-8000-000000000003", { durationMs: 1_900, costNanocents: 720_000_000 }),
  answer: call("c0000001-0000-4000-8000-000000000004", { durationMs: 1_200, costNanocents: 300_000_000 }),
  screen: call("c0000001-0000-4000-8000-000000000005", {
    target: "spark_open",
    model: "meta-models/muse-spark-open-1026",
    purpose: "screen_untrusted_input",
    effort: null,
    durationMs: 400,
    costNanocents: 50_000_000,
  }),
  auditor: call("c0000001-0000-4000-8000-000000000006", {
    target: "wonder",
    model: "muse-wonder-1.0",
    purpose: "agent_auditor_check",
    effort: "high",
    durationMs: 4_100,
    costNanocents: 5_800_000_000,
  }),
};

const D = {
  items: "d0000001-0000-4000-8000-000000000001",
  blocked: "d0000001-0000-4000-8000-000000000002",
  allowed: "d0000001-0000-4000-8000-000000000003",
};

const step = {
  proposalId: null,
  category: null,
  result: null,
  toolCalls: null,
  toolSearches: null,
  incomplete: false,
  escalation: null,
  call: null,
  decision: null,
  state: "done",
};

export function sampleTrace(): TurnTrace {
  const c = SAMPLE_CALLS;
  return {
    turnId: SAMPLE_TURN_ID,
    status: "done",
    steps: [
      { ...step, seq: 1, kind: "model", label: "Thinking it through", call: c.plan, toolCalls: 1 },
      {
        ...step,
        seq: 2,
        kind: "tool",
        label: "Reading pay items",
        decision: {
          id: D.items,
          tool: "get_pay_items",
          decision: "allowed",
          reason: "ok",
          limitCents: null,
          issuedBy: c.plan.id,
          refs: [
            { table: "drivers", id: SAMPLE_DRIVER_ID },
            { table: "pay_items", id: SAMPLE_PAY_ITEM_ID },
          ],
        },
      },
      { ...step, seq: 3, kind: "model", label: "Thinking it through", call: c.ask, toolCalls: 1 },
      {
        ...step,
        seq: 4,
        kind: "tool",
        label: "Checking advance eligibility",
        state: "failed",
        decision: {
          id: D.blocked,
          tool: "propose_advance",
          decision: "blocked",
          reason: "amount_over_limit",
          limitCents: 41_200,
          issuedBy: c.ask.id,
          refs: [],
        },
      },
      { ...step, seq: 5, kind: "model", label: "Thinking it through", call: c.retry, toolCalls: 1 },
      {
        ...step,
        seq: 6,
        kind: "tool",
        label: "Checking advance eligibility",
        decision: {
          id: D.allowed,
          tool: "propose_advance",
          decision: "allowed",
          reason: "ok",
          limitCents: 41_200,
          issuedBy: c.retry.id,
          refs: [{ table: "drivers", id: SAMPLE_DRIVER_ID }],
        },
      },
      {
        ...step,
        seq: 7,
        kind: "proposal",
        label: "Preparing a proposal card",
        proposalId: SAMPLE_PROPOSAL_ID,
        result: "created",
      },
      { ...step, seq: 8, kind: "model", label: "Thinking it through", call: c.answer, toolCalls: 0 },
    ],
    extraCalls: [{ ...c.screen, afterSeq: 2, screen: { verdict: "clean", via: "model" } }],
    proposals: [
      {
        id: SAMPLE_PROPOSAL_ID,
        gatewayDecisionId: D.allowed,
        operatorVerdict: "partial",
        auditorVerdict: "pass",
        auditorCall: c.auditor,
        flagged: false,
        exceptions: ["capped_to_eligible"],
      },
    ],
  };
}
