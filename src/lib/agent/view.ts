// What the chat shows for a turn: plain data, safe to send to the browser. The gateway's store
// builds it from the database (store/views.ts); the turn view component maps it to chat parts.
// Ids, enums, cents, fixed labels and fixed sentences only, plus the person's own question, the
// agent's final answer and, for a flagged input, the quoted text the person is warned about.

import type { ReportName } from "../reports/types";
import type { Checklist } from "./checklist";
import type { ProposalKind } from "./gateway/types";

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

// A Cash Friday card's engine figures, read from the proposal's stored args: the invoices a
// factoring card would sell and what each brings in now, the bill a delay card moves and its new
// date, or the past-due invoices a chase card asks about.
export type CashCardView =
  | {
      kind: "factoring_request";
      // The factoring request the approval wrote (src/lib/factoring/execute.ts), by its status;
      // null or absent before an approval sent one (or when factoring was off and only recorded it).
      requestStatus?: string | null;
      shortCents: number;
      advanceBps: number;
      feeBps: number;
      invoices: {
        invoiceId: string;
        invoiceNumber: string;
        balanceCents: number;
        advanceCents: number;
        feeCents: number;
        netCents: number;
        reserveCents: number;
      }[];
    }
  | {
      kind: "bill_defer";
      billId: string;
      billRef: string;
      amountCents: number;
      dueOn: string;
      deferredTo: string;
      shortCents: number;
    }
  | {
      kind: "collections_chase";
      overdueInvoices: number;
      invoices: { invoiceId: string; invoiceNumber: string; balanceCents: number; dueOn: string }[];
    };

// A pay rule change's figures, read from the proposal's stored args (every field checked by the
// change's schema): the rule, its two values, the dates, and the engine's impact on the newest
// settled week. Plain shapes only: this file sits outside the gateway, so it names no type from
// the pay rules code.
export type RuleChangeView = {
  ruleKey: string;
  oldValue: number | string | null;
  newValue: number | string | null;
  askedFrom: string;
  effectiveFrom: string;
  snapped: boolean;
  applied: "new_version" | "edited_version";
  appliesTo: string;
  impact: {
    basis: "settled_week" | "no_settled_week" | "advances_only";
    periodId: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    driversCompared: number;
    driversChanged: number;
    netDeltaCents: number;
    ownerOperatorsOnly: boolean;
    top: { driverId: string; code: string; deltaCents: number; settlementId: string }[];
  };
};

export type ProposalView = {
  id: string;
  kind: ProposalKind;
  subjectTable: string;
  subjectId: string;
  // The subject's code (a driver's code, an invoice's or a load's number, a payment's reference),
  // read at render, never stored.
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
  // The rules engine's own recompute, compared in code to the cent (0045): null until it ran.
  // engineHeld: a mismatch on a waiting proposal that needs a person's reason to approve
  // (verifyEngineMismatchBlocks); engineOverride: that reason, a role label and when.
  engineCheck?: "matched" | "mismatch" | "unavailable" | null;
  engineHeld?: boolean;
  engineOverride?: { reason: string; byLabel: string; at: string } | null;
  // Where an advance lands, read at render, never stored: "fuel card ···· 4417" (last4 set) or
  // "no fuel card on file" (last4 null, only while proposed or approved). A done proposal names the
  // card its advance recorded. Null for a kind that pays no card, a done proposal with no recorded
  // card, and a rejected, expired, executing or failed proposal.
  destination: { label: string; last4: string | null; testMode: true } | null;
  // Set on a detention_charge only, when its stored args read back whole.
  detention?: DetentionView | null;
  // Set on an advance_payout only: the load it is for, with the per-load cap and what was left
  // under it after this advance at proposal time (both null when the carrier has no cap).
  load?: { number: string; capCents: number | null; leftAfterCents: number | null } | null;
  // Set on a card_match only, when its stored args read back whole: the statement row by its last
  // four digits, the driver picked, and the other drivers code ranked for that day.
  cardMatch?: CardMatchView | null;
  // Set on a Cash Friday card only, when its stored args read back whole.
  cash?: CashCardView | null;
  // Set on a pay_rule_change only, when its stored args read back whole.
  ruleChange?: RuleChangeView | null;
};

export type CardMatchView = {
  last4: string;
  portalName: string;
  postedOn: string;
  state: string | null;
  driverCode: string;
  others: string[];
};

// An outside message this turn read that failed screening. quote is shown to the person only, in
// a marked block; it never reaches a model through the summary.
export type FlagView = { inputId: string; categories: string[]; quote: string };

// A report a tool call built this turn: its name and typed args (dates and ids). The turn store
// keeps no tool result, so the chat fetches the table from the report route with these args.
export type ReportView = { stepId: string; name: ReportName; args: Record<string, string> };

// The error the chat shows instead of an answer: the fixed state, never upstream text.
export type TurnError = "budget" | "job_cap" | "timeout" | "unknown";

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
  // The answer's checklist, when it set one: live while it runs, final once it ended.
  checklist?: Checklist | null;
  // Figures held back from the answer as not coming from a record, summed over its finished model
  // steps; null when a step did not record it (unknown, never zero).
  withheldFigures?: number | null;
};

// The server-sent events of one turn. The client reads the full turn back when done arrives.
export type TurnEvent =
  | { event: "start"; data: { turnId: string; conversationId: string } }
  | { event: "step"; data: StepView }
  | { event: "checklist"; data: Checklist }
  | { event: "done"; data: { turnId: string; status: TurnStatus } };

// What a failed or partial turn shows, by its ended reason.
export function turnErrorFor(status: TurnStatus, endedReason: string | null): TurnError | null {
  if (status !== "failed") return null;
  if (endedReason === "budget") return "budget";
  if (endedReason === "job_cap") return "job_cap";
  if (endedReason === "clock" || endedReason === "model_timeout") return "timeout";
  return "unknown";
}

// The sentence the loop opens a stopped turn with (policy.ts LOOP_TEXT.stopped; this file is
// read in the browser, so it holds its own copy and a test keeps the two the same).
export const STOPPED_TEXT = "I stopped before finishing this answer. Here is what I found so far.";
export const FOUND_TEXT = "Here is what I found.";

// The answer text the chat shows. A turn that stopped early but still produced a card or a report
// opens with "Here is what I found." instead, so a complete card is not read as a broken one; with
// nothing to show, it keeps saying it stopped. The turn's status is unchanged either way.
export function answerTextOf(t: Pick<TurnView, "status" | "text" | "proposals" | "reports">): string {
  if (t.status !== "partial") return t.text;
  if (t.proposals.length === 0 && t.reports.length === 0) return t.text;
  if (!t.text.startsWith(STOPPED_TEXT)) return t.text;
  const rest = t.text.slice(STOPPED_TEXT.length).replace(/^\s+/, "");
  return rest ? `${FOUND_TEXT}\n\n${rest}` : FOUND_TEXT;
}
