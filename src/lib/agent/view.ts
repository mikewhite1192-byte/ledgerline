// What the chat shows for a turn: plain data, safe to send to the browser. The gateway's store
// builds it from the database (store/views.ts); the turn view component maps it to chat parts.
// Ids, enums, cents, fixed labels and fixed sentences only, plus the person's own question, the
// agent's final answer and, for a flagged input, the quoted text the person is warned about.

import type { ReportName } from "../reports/types";

export const TURN_STATUSES = ["running", "done", "partial", "failed"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

export type StepKind = "model" | "tool" | "escalation" | "proposal" | "screen";
export type StepState = "running" | "done" | "failed";

export type StepView = { id: string; seq: number; kind: StepKind; label: string; state: StepState };

// The proposal statuses a card can show. approved with no ledger row yet shows as approved: no row
// means nothing was reserved, and the ledger reserves before any outside call, so no money moved.
// An executing proposal whose ledger outcome is not known shows as unknown.
export type CardStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "done"
  | "failed"
  | "unknown";

export type RefView = { table: string; id: string };

export type ReasonView = { category: string; text: string; source: RefView | null };

// A detention charge's engine figures, read from the proposal's stored args: the customer's
// terms, the invoice total before the charge and each stop that earns detention.
export type DetentionView = {
  freeMinutes: number;
  hourlyCents: number;
  invoiceAmountBeforeCents: number;
  stops: {
    stop: "pickup" | "delivery";
    dwellMinutes: number;
    overMinutes: number;
    quarters: number;
    cents: number;
  }[];
};

export type ProposalView = {
  id: string;
  kind: "advance_payout" | "pay_correction" | "invoice_fix" | "detention_charge";
  subjectTable: string;
  subjectId: string;
  // The subject's code (a driver's or an invoice's number), read at render, never stored.
  subjectLabel: string | null;
  amountCents: number;
  direction: "in" | "out" | "none";
  title: string;
  reasons: ReasonView[];
  sources: RefView[];
  status: CardStatus;
  flagged: boolean;
  flagCategories: string[];
  operatorVerdict: string;
  auditorVerdict: string | null;
  // The auditor's concerns (fixed categories) and when its verdict landed; the card sends that
  // instant back with an override so the gate knows the person saw this verdict.
  auditorConcerns: string[];
  auditorCheckedAt: string | null;
  // A person's override of a block: their words, a role label (never the sub or email), when.
  auditorOverride: { reason: string; byLabel: string; at: string } | null;
  // Where an advance would land, read at render, never stored: "fuel card ···· 4417" (last4 set) or
  // "no fuel card on file" (last4 null). Null for a kind that pays no card.
  destination: { label: string; last4: string | null; testMode: true } | null;
  // Set on a detention_charge only, when its stored args read back whole.
  detention?: DetentionView | null;
};

// An outside message this turn read that failed screening. quote is shown to the person only, in
// a marked block; it never reaches a model through the summary.
export type FlagView = { inputId: string; categories: string[]; quote: string };

// A report a tool call built this turn: its name and typed args (dates and ids). The turn store
// keeps no tool result, so the chat fetches the table from the report route with these args.
export type ReportView = { stepId: string; name: ReportName; args: Record<string, string> };

// The error the chat shows instead of an answer: the fixed state, never upstream text.
export type TurnError = "budget" | "timeout" | "unknown";

export type TurnView = {
  id: string;
  conversationId: string;
  seq: number;
  userText: string;
  status: TurnStatus;
  endedReason: string | null;
  text: string;
  steps: StepView[];
  proposals: ProposalView[];
  flags: FlagView[];
  reports: ReportView[];
  error: TurnError | null;
};

// The server-sent events of one turn. The client reads the full turn back when done arrives.
export type TurnEvent =
  | { event: "start"; data: { turnId: string; conversationId: string } }
  | { event: "step"; data: StepView }
  | { event: "done"; data: { turnId: string; status: TurnStatus } };

// What a failed or partial turn shows, by its ended reason.
export function turnErrorFor(status: TurnStatus, endedReason: string | null): TurnError | null {
  if (status !== "failed") return null;
  if (endedReason === "budget") return "budget";
  if (endedReason === "clock" || endedReason === "model_timeout") return "timeout";
  return "unknown";
}
