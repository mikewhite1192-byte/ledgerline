import type { Checklist } from "../../checklist";
import type { StepKind, StepView } from "../../view";
import type { ProposalDraft } from "../types";

// The agent's own records (migration 0009), as the operator loop writes them. Every write goes
// through the gateway's tenant transaction with the membership check (design 3.7); the loop sees
// only this interface.

export type OpenedTurn = {
  turnId: string;
  conversationId: string;
  seq: number;
  traceId: string;
  timeZone: string;
  // The state summary for the model (one system message) and its size.
  summary: string;
  summaryChars: number;
  // Every cents figure the summary states, so the loop's figures check accepts it.
  summaryCents: number[];
};

export type OpenTurnRefusal = "not_found" | "busy" | "duplicate";

export type StepStart = { kind: StepKind; label: string; detail?: Record<string, unknown> };

export type StepFinish = {
  state: "done" | "failed";
  modelCallId?: string | null;
  gatewayDecisionId?: string | null;
  proposalId?: string | null;
  detail?: Record<string, unknown>;
  // A model step's own short note, when one came back (figures already masked).
  reasoningNote?: string | null;
};

export type PersistInput = {
  turnId: string;
  conversationId: string;
  traceId: string;
  draft: ProposalDraft;
  gatewayDecisionId: string;
  // The first flagged input this turn read, if any. Set by the loop, never by the model.
  flaggedInputId: string | null;
};

// created: a new card. duplicate: the same proposal already exists (same kind, subject and
// args) and is still waiting or running. already_decided: the same proposal exists but was
// already rejected, expired, done or failed, so there is no card to show (status is that row's
// status category). live_exists: another proposal for this subject is still waiting or running.
export type PersistResult =
  | { kind: "created"; proposalId: string; flagged: boolean }
  | { kind: "duplicate"; proposalId: string; flagged: boolean }
  | { kind: "already_decided"; proposalId: string; status: string }
  | { kind: "live_exists"; proposalId: string };

export type TurnFinish = {
  status: "done" | "partial" | "failed";
  endedReason: string | null;
  text: string;
  summary: string;
  stepCount: number;
  modelCallCount: number;
  costNanocents: number;
  // The checklist as the answer ended (absent: the stored one stays as it is).
  checklist?: Checklist;
};

export interface TurnStore {
  startStep(turnId: string, step: StepStart): Promise<StepView>;
  finishStep(turnId: string, stepId: string, finish: StepFinish): Promise<StepView>;
  persistProposal(input: PersistInput): Promise<PersistResult>;
  // Marks this turn's unflagged waiting proposals with a flagged input read later in the turn.
  flagTurnProposals(turnId: string, inputId: string): Promise<number>;
  // Replaces the turn's checklist while it runs (set_checklist; the loop masks it first).
  setChecklist(turnId: string, checklist: Checklist): Promise<void>;
  finishTurn(turnId: string, finish: TurnFinish): Promise<void>;
}
