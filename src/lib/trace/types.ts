// How a turn was worked out, as plain data safe to send to the browser: the model calls, gateway
// decisions and proposal checks behind one answer. The gateway's store reads it from model_calls,
// turn_steps, gateway_decisions and proposals (store/trace.ts); format.ts turns it into fixed
// sentences. Ids, enum codes, whole numbers and cents only: no model text, no arguments, no
// upstream messages. Codes are never shown as they are; every one goes through a fixed table.

export type TraceRef = { table: string; id: string };

// One model_calls row. costNanocents is null until the call settles.
export type TraceCall = {
  id: string;
  target: string;
  model: string;
  purpose: string;
  effort: string | null;
  status: string;
  failure: string | null;
  durationMs: number | null;
  costNanocents: number | null;
};

// One gateway_decisions row. issuedBy is the model call that asked for the tool.
export type TraceDecision = {
  id: string;
  tool: string;
  decision: string;
  reason: string;
  limitCents: number | null;
  issuedBy: string | null;
  refs: TraceRef[];
};

// One turn_steps row with what it links to. category, result, toolCalls and escalation come from
// the step's detail and are fixed codes or counts; anything else in detail is never read.
export type TraceStep = {
  seq: number;
  kind: string;
  label: string;
  state: string;
  call: TraceCall | null;
  decision: TraceDecision | null;
  proposalId: string | null;
  category: string | null;
  result: string | null;
  toolCalls: number | null;
  incomplete: boolean;
  escalation: { attempts: number; finishedBy: string } | null;
};

// A model call in the turn's trace that no step names (a screening, or a call whose step failed
// before it could link it). afterSeq is the last step that had started when the call was made.
export type TraceExtraCall = TraceCall & {
  afterSeq: number;
  screen: { verdict: string; via: string } | null;
};

export type TraceProposal = {
  id: string;
  gatewayDecisionId: string;
  operatorVerdict: string;
  auditorVerdict: string | null;
  auditorCall: TraceCall | null;
  flagged: boolean;
  exceptions: string[];
};

export type TurnTrace = {
  turnId: string;
  status: string;
  steps: TraceStep[];
  extraCalls: TraceExtraCall[];
  proposals: TraceProposal[];
};

// The Meta models page: this carrier's week, grouped in SQL, summed in week.ts.
export type WeekCallGroup = {
  target: string;
  model: string;
  status: string;
  calls: number;
  costNanocents: number;
  heldNanocents: number;
  unsettled: number;
};

export type WeekRaw = {
  week: { start: string; end: string; zone: string };
  groups: WeekCallGroup[];
  latencies: { target: string; p50Ms: number | null }[];
  decisions: { decision: string; count: number }[];
  screenings: { verdict: string; via: string; count: number }[];
  escalations: number;
};
