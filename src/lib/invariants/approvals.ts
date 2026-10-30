import {
  countOf,
  onlyRow,
  readAll,
  refuseUnread,
  resultOf,
  tally,
  unreadable,
  type InvariantResult,
  type ReadQuery,
} from "./types";
import type { Db } from "../db/types";

// I3: every payout has a ledger row and an approval.
// - A paid advance from the flow has exactly one confirmed payout, and a confirmed payout means
//   the advance is marked paid. Only the flow pays (an advance with a proposal), so a payout on
//   any other advance is a violation. Seeded history was paid before the ledger existed and is
//   counted, not judged.
// - A settlement has at most one confirmed payout, which means it is marked paid; a paid
//   settlement that has payout rows has a confirmed one. A paid settlement with no ledger rows at
//   all is seeded history (only the seed writes settlements today), counted, not judged.
// - Every payment-channel ledger row names an approver who is a member of the same tenant. An
//   agent's row names its proposal, which a person decided (approved, then executing, done, or
//   failed when a definite failure stopped it before a retry) before the money was sent; an
//   advance payout names the same proposal its advance came from.
// - A proposal that names a ledger row is executing, done or failed, and the row exists.
//
// "Decided before sent" compares two clocks: proposals.decided_at is the app host's clock (the
// approval writes the server's time, src/lib/proposals/execute.ts) and money_actions.sent_at is
// the database's now() (markSent in src/lib/money/ledger.ts). A real approval and its send are
// milliseconds apart, so with no slack a host clock a little ahead of the database would flag
// every real payout. A send counts as before its decision only when it is more than
// SENT_BEFORE_DECISION_TOLERANCE earlier; a send well before the decision is still caught. A
// fixed constant, never input.
export const SENT_BEFORE_DECISION_TOLERANCE = "5 seconds";

// Decided by a person: approved, then executing, then done, or failed (only reachable through
// approved, and a retry may still pay after it).
export const DECIDED_STATUSES = ["approved", "executing", "done", "failed"] as const;
export const LINKED_STATUSES = ["executing", "done", "failed"] as const;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

// Each check reads one aggregate row, not one row per record (a Data API response holds at most
// 1 MiB). The inner SELECT is the per-record row the check judges; the outer one counts what the
// per-record judgment counted. "unread" counts the records whose flags the per-record read would
// have refused (a NULL where true or false belongs): any at all leaves I3 unread.

// An advance from the flow (it has a proposal) has at most one confirmed payout, and is marked
// paid exactly when it has one. Any other advance with a payout is off the flow; a paid one with
// none is seeded history when the seed wrote it, and a violation otherwise.
export const ADVANCE_PAYOUTS_SQL = `SELECT count(*) AS advances,
       count(*) FILTER (WHERE x.paid IS NULL OR x.flow IS NULL
                          OR (NOT x.flow AND x.confirmed = 0 AND x.paid AND x.seeded IS NULL)) AS unread,
       count(*) FILTER (WHERE x.confirmed > 1) AS paid_twice,
       count(*) FILTER (WHERE x.paid AND x.confirmed = 0 AND (x.flow OR NOT x.seeded)) AS paid_without_payout,
       count(*) FILTER (WHERE x.flow AND NOT x.paid AND x.confirmed > 0) AS payout_unmarked,
       count(*) FILTER (WHERE NOT x.flow AND x.confirmed > 0) AS off_flow,
       count(*) FILTER (WHERE NOT x.flow AND x.confirmed = 0 AND x.paid AND x.seeded) AS history
  FROM (SELECT a.source = 'seed' AS seeded, a.proposal_id IS NOT NULL AS flow,
               (a.status = 'paid' OR a.paid_at IS NOT NULL) AS paid,
               count(m.id) FILTER (WHERE m.state = 'confirmed') AS confirmed
          FROM advances a
          LEFT JOIN money_actions m
            ON m.tenant_id = a.tenant_id AND m.kind = 'advance_payout' AND m.subject_id = a.id
         GROUP BY a.tenant_id, a.id) x`;

// A settlement has at most one confirmed payout, which means it is marked paid; a paid settlement
// with payout rows has a confirmed one, and one with no ledger rows at all is seeded history.
export const SETTLEMENT_PAYOUTS_SQL = `SELECT count(*) AS settlements,
       count(*) FILTER (WHERE x.paid IS NULL) AS unread,
       count(*) FILTER (WHERE x.confirmed > 1) AS paid_twice,
       count(*) FILTER (WHERE x.confirmed > 0 AND NOT x.paid) AS payout_unmarked,
       count(*) FILTER (WHERE x.paid AND x.confirmed = 0 AND x.ledger_rows <> 0) AS paid_without_payout,
       count(*) FILTER (WHERE x.paid AND x.confirmed = 0 AND x.ledger_rows = 0) AS history
  FROM (SELECT (s.status = 'paid' OR s.paid_at IS NOT NULL) AS paid, count(m.id) AS ledger_rows,
               count(m.id) FILTER (WHERE m.state = 'confirmed') AS confirmed
          FROM settlements s
          LEFT JOIN money_actions m
            ON m.tenant_id = s.tenant_id AND m.kind = 'settlement_payout' AND m.subject_id = s.id
         GROUP BY s.tenant_id, s.id) x`;

// Every payment-channel ledger row: an approver always. An agent's row that names no proposal is
// that violation and nothing more is judged; a row with an unknown proposer is flagged and judged
// on. A row that names a proposal: the proposal exists (if not, nothing more is judged), a person
// decided it, before the send (inside the clock tolerance), and for an advance payout it is the
// advance's own proposal.
export const PAYMENT_ROWS_SQL = `SELECT count(*) AS payment_rows,
       count(*) FILTER (WHERE r.approver_found IS NULL OR r.names_proposal IS NULL
                          OR (r.judged AND r.proposal_status IS NOT NULL
                              AND (r.decided IS NULL OR r.sent IS NULL
                                   OR (r.sent AND r.decided_before_sent IS NULL)
                                   OR r.same_proposal IS NULL))) AS unread,
       count(*) FILTER (WHERE NOT r.approver_found) AS approver_missing,
       count(*) FILTER (WHERE r.agent_unlinked) AS agent_without_proposal,
       count(*) FILTER (WHERE NOT r.agent_unlinked AND r.proposed_by IS DISTINCT FROM 'agent'
                          AND r.proposed_by IS DISTINCT FROM 'person') AS proposer_unknown,
       count(*) FILTER (WHERE r.judged AND r.proposal_status IS NULL) AS proposal_missing,
       count(*) FILTER (WHERE r.judged AND r.proposal_status NOT IN (${list(DECIDED_STATUSES)})) AS not_approved,
       count(*) FILTER (WHERE r.judged AND r.proposal_status IS NOT NULL AND NOT r.decided) AS undecided,
       count(*) FILTER (WHERE r.judged AND r.proposal_status IS NOT NULL AND r.sent
                          AND NOT r.decided_before_sent) AS sent_before_decision,
       count(*) FILTER (WHERE r.judged AND r.proposal_status IS NOT NULL AND NOT r.same_proposal) AS mismatch
  FROM (SELECT y.*, (y.proposed_by = 'agent' AND NOT y.names_proposal) IS TRUE AS agent_unlinked,
               ((y.proposed_by = 'agent' AND NOT y.names_proposal) IS NOT TRUE AND y.names_proposal) IS TRUE AS judged
          FROM (SELECT m.proposed_by, (mem.id IS NOT NULL) AS approver_found,
                       (m.proposal_id IS NOT NULL) AS names_proposal, p.status AS proposal_status,
                       (p.decided_by IS NOT NULL AND p.decided_at IS NOT NULL) AS decided,
                       (m.sent_at IS NOT NULL) AS sent,
                       (p.decided_at <= m.sent_at + interval '${SENT_BEFORE_DECISION_TOLERANCE}') IS TRUE AS decided_before_sent,
                       (m.kind <> 'advance_payout' OR a.proposal_id = m.proposal_id) IS TRUE AS same_proposal
                  FROM money_actions m
                  LEFT JOIN memberships mem ON mem.tenant_id = m.tenant_id AND mem.id = m.approver_membership_id
                  LEFT JOIN proposals p ON p.tenant_id = m.tenant_id AND p.id = m.proposal_id
                  LEFT JOIN advances a ON m.kind = 'advance_payout' AND a.tenant_id = m.tenant_id AND a.id = m.subject_id
                 WHERE m.channel = 'payment') y) r`;

// A proposal that names a ledger row is executing, done or failed, and the row exists.
export const PROPOSAL_LINKS_SQL = `SELECT count(*) AS linked_proposals,
       count(*) FILTER (WHERE l.action_found IS NULL) AS unread,
       count(*) FILTER (WHERE (l.status IN (${list(LINKED_STATUSES)})) IS NOT TRUE) AS linked_early,
       count(*) FILTER (WHERE NOT l.action_found) AS action_missing
  FROM (SELECT p.status, (m.id IS NOT NULL) AS action_found
          FROM proposals p
          LEFT JOIN money_actions m ON m.tenant_id = p.tenant_id AND m.id = p.money_action_id
         WHERE p.money_action_id IS NOT NULL) l`;

export type AdvancePayoutRow = {
  advances: unknown;
  unread: unknown;
  paid_twice: unknown;
  paid_without_payout: unknown;
  payout_unmarked: unknown;
  off_flow: unknown;
  history: unknown;
};
export type SettlementPayoutRow = {
  settlements: unknown;
  unread: unknown;
  paid_twice: unknown;
  payout_unmarked: unknown;
  paid_without_payout: unknown;
  history: unknown;
};
export type PaymentRow = {
  payment_rows: unknown;
  unread: unknown;
  approver_missing: unknown;
  agent_without_proposal: unknown;
  proposer_unknown: unknown;
  proposal_missing: unknown;
  not_approved: unknown;
  undecided: unknown;
  sent_before_decision: unknown;
  mismatch: unknown;
};
export type ProposalLinkRow = { linked_proposals: unknown; unread: unknown; linked_early: unknown; action_missing: unknown };

// One aggregate row each.
export type ApprovalRows = {
  advances: AdvancePayoutRow[];
  settlements: SettlementPayoutRow[];
  paymentRows: PaymentRow[];
  proposalLinks: ProposalLinkRow[];
};

// Every payment-channel ledger row's judgment, tallied into v; returns how many rows were read.
function judgePaymentRows(rows: PaymentRow[], v: Record<string, number>): number {
  const m = onlyRow(rows, "payment_rows_unread");
  const paymentRows = countOf(m.payment_rows);
  refuseUnread(m.unread, "not_boolean");
  tally(v, "approver_missing", countOf(m.approver_missing));
  tally(v, "agent_payout_without_proposal", countOf(m.agent_without_proposal));
  tally(v, "proposer_unknown", countOf(m.proposer_unknown));
  tally(v, "proposal_missing", countOf(m.proposal_missing));
  tally(v, "proposal_not_approved", countOf(m.not_approved));
  tally(v, "proposal_undecided", countOf(m.undecided));
  tally(v, "sent_before_decision", countOf(m.sent_before_decision));
  tally(v, "proposal_mismatch", countOf(m.mismatch));
  return paymentRows;
}

// Every proposal that names a ledger row, judged into v; returns how many were read.
function judgeProposalLinks(rows: ProposalLinkRow[], v: Record<string, number>): number {
  const p = onlyRow(rows, "proposal_links_unread");
  const linkedProposals = countOf(p.linked_proposals);
  refuseUnread(p.unread, "not_boolean");
  tally(v, "proposal_linked_early", countOf(p.linked_early));
  tally(v, "proposal_action_missing", countOf(p.action_missing));
  return linkedProposals;
}

export function judgeApprovals(rows: ApprovalRows): InvariantResult {
  const v: Record<string, number> = {};

  const a = onlyRow(rows.advances, "advances_unread");
  const advances = countOf(a.advances);
  refuseUnread(a.unread, "not_boolean");
  tally(v, "advance_paid_twice", countOf(a.paid_twice));
  tally(v, "advance_paid_without_payout", countOf(a.paid_without_payout));
  tally(v, "advance_payout_unmarked", countOf(a.payout_unmarked));
  tally(v, "advance_payout_off_flow", countOf(a.off_flow));

  const s = onlyRow(rows.settlements, "settlements_unread");
  const settlements = countOf(s.settlements);
  refuseUnread(s.unread, "not_boolean");
  tally(v, "settlement_paid_twice", countOf(s.paid_twice));
  tally(v, "settlement_payout_unmarked", countOf(s.payout_unmarked));
  tally(v, "settlement_paid_without_payout", countOf(s.paid_without_payout));

  const paymentRows = judgePaymentRows(rows.paymentRows, v);
  const linkedProposals = judgeProposalLinks(rows.proposalLinks, v);

  return resultOf(
    "I3",
    {
      advances,
      settlements,
      payment_rows: paymentRows,
      linked_proposals: linkedProposals,
      history_paid: countOf(a.history) + countOf(s.history),
    },
    v,
  );
}

export async function readApprovals(q: ReadQuery): Promise<ApprovalRows> {
  return {
    advances: await q.query<AdvancePayoutRow>(ADVANCE_PAYOUTS_SQL),
    settlements: await q.query<SettlementPayoutRow>(SETTLEMENT_PAYOUTS_SQL),
    paymentRows: await q.query<PaymentRow>(PAYMENT_ROWS_SQL),
    proposalLinks: await q.query<ProposalLinkRow>(PROPOSAL_LINKS_SQL),
  };
}

// One carrier's count of money moved without a person's approval, for the desk panel: the
// payment rows and the proposal links, read under the carrier's own session (RLS) and judged
// exactly as I3 judges them. Any read that does not come back whole throws (InvariantReadError
// or the database's error), so the caller shows "not read", never 0.
export async function countApprovalBreaks(q: ReadQuery): Promise<number> {
  const v: Record<string, number> = {};
  judgePaymentRows(await q.query<PaymentRow>(PAYMENT_ROWS_SQL), v);
  judgeProposalLinks(await q.query<ProposalLinkRow>(PROPOSAL_LINKS_SQL), v);
  return Object.values(v).reduce((sum, n) => sum + n, 0);
}

export async function checkApprovals(admin: Db): Promise<InvariantResult> {
  try {
    return judgeApprovals(await readAll(admin, readApprovals));
  } catch (err) {
    return unreadable("I3", err);
  }
}
