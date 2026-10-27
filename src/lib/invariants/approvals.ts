import { flag, readAll, resultOf, tally, unreadable, whole, type InvariantResult, type ReadQuery } from "./types";
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

export const ADVANCE_PAYOUTS_SQL = `SELECT a.source = 'seed' AS seeded, a.proposal_id IS NOT NULL AS flow,
       (a.status = 'paid' OR a.paid_at IS NOT NULL) AS paid,
       count(m.id) FILTER (WHERE m.state = 'confirmed') AS confirmed
  FROM advances a
  LEFT JOIN money_actions m
    ON m.tenant_id = a.tenant_id AND m.kind = 'advance_payout' AND m.subject_id = a.id
 GROUP BY a.tenant_id, a.id`;

export const SETTLEMENT_PAYOUTS_SQL = `SELECT (s.status = 'paid' OR s.paid_at IS NOT NULL) AS paid, count(m.id) AS ledger_rows,
       count(m.id) FILTER (WHERE m.state = 'confirmed') AS confirmed
  FROM settlements s
  LEFT JOIN money_actions m
    ON m.tenant_id = s.tenant_id AND m.kind = 'settlement_payout' AND m.subject_id = s.id
 GROUP BY s.tenant_id, s.id`;

export const PAYMENT_ROWS_SQL = `SELECT m.kind, m.proposed_by, (mem.id IS NOT NULL) AS approver_found,
       (m.proposal_id IS NOT NULL) AS names_proposal, p.status AS proposal_status,
       (p.decided_by IS NOT NULL AND p.decided_at IS NOT NULL) AS decided,
       (m.sent_at IS NOT NULL) AS sent, (p.decided_at <= m.sent_at) IS TRUE AS decided_before_sent,
       (m.kind <> 'advance_payout' OR a.proposal_id = m.proposal_id) IS TRUE AS same_proposal
  FROM money_actions m
  LEFT JOIN memberships mem ON mem.tenant_id = m.tenant_id AND mem.id = m.approver_membership_id
  LEFT JOIN proposals p ON p.tenant_id = m.tenant_id AND p.id = m.proposal_id
  LEFT JOIN advances a ON m.kind = 'advance_payout' AND a.tenant_id = m.tenant_id AND a.id = m.subject_id
 WHERE m.channel = 'payment'`;

export const PROPOSAL_LINKS_SQL = `SELECT p.status, (m.id IS NOT NULL) AS action_found
  FROM proposals p
  LEFT JOIN money_actions m ON m.tenant_id = p.tenant_id AND m.id = p.money_action_id
 WHERE p.money_action_id IS NOT NULL`;

export type AdvancePayoutRow = { seeded: unknown; flow: unknown; paid: unknown; confirmed: unknown };
export type SettlementPayoutRow = { paid: unknown; ledger_rows: unknown; confirmed: unknown };
export type PaymentRow = {
  kind: unknown;
  proposed_by: unknown;
  approver_found: unknown;
  names_proposal: unknown;
  proposal_status: unknown;
  decided: unknown;
  sent: unknown;
  decided_before_sent: unknown;
  same_proposal: unknown;
};
export type ProposalLinkRow = { status: unknown; action_found: unknown };

export type ApprovalRows = {
  advances: AdvancePayoutRow[];
  settlements: SettlementPayoutRow[];
  paymentRows: PaymentRow[];
  proposalLinks: ProposalLinkRow[];
};

// Decided by a person: approved, then executing, then done, or failed (only reachable through
// approved, and a retry may still pay after it).
const DECIDED_STATUSES = new Set(["approved", "executing", "done", "failed"]);
const LINKED_STATUSES = new Set(["executing", "done", "failed"]);

export function judgeApprovals(rows: ApprovalRows): InvariantResult {
  const v: Record<string, number> = {};
  let history = 0;

  for (const a of rows.advances) {
    const confirmed = whole(a.confirmed);
    const paid = flag(a.paid);
    if (confirmed > 1) tally(v, "advance_paid_twice");
    if (flag(a.flow)) {
      if (paid && confirmed === 0) tally(v, "advance_paid_without_payout");
      if (!paid && confirmed > 0) tally(v, "advance_payout_unmarked");
    } else {
      if (confirmed > 0) tally(v, "advance_payout_off_flow");
      else if (paid && flag(a.seeded)) history += 1;
      else if (paid) tally(v, "advance_paid_without_payout");
    }
  }

  for (const s of rows.settlements) {
    const confirmed = whole(s.confirmed);
    const ledgerRows = whole(s.ledger_rows);
    const paid = flag(s.paid);
    if (confirmed > 1) tally(v, "settlement_paid_twice");
    if (confirmed > 0 && !paid) tally(v, "settlement_payout_unmarked");
    if (paid && confirmed === 0) {
      if (ledgerRows === 0) history += 1;
      else tally(v, "settlement_paid_without_payout");
    }
  }

  for (const m of rows.paymentRows) {
    if (!flag(m.approver_found)) tally(v, "approver_missing");
    const namesProposal = flag(m.names_proposal);
    if (m.proposed_by === "agent" && !namesProposal) {
      tally(v, "agent_payout_without_proposal");
      continue;
    }
    if (m.proposed_by !== "agent" && m.proposed_by !== "person") tally(v, "proposer_unknown");
    if (!namesProposal) continue;
    if (m.proposal_status === null) {
      tally(v, "proposal_missing");
      continue;
    }
    if (typeof m.proposal_status !== "string" || !DECIDED_STATUSES.has(m.proposal_status)) {
      tally(v, "proposal_not_approved");
    }
    if (!flag(m.decided)) tally(v, "proposal_undecided");
    if (flag(m.sent) && !flag(m.decided_before_sent)) tally(v, "sent_before_decision");
    if (!flag(m.same_proposal)) tally(v, "proposal_mismatch");
  }

  for (const p of rows.proposalLinks) {
    if (typeof p.status !== "string" || !LINKED_STATUSES.has(p.status)) tally(v, "proposal_linked_early");
    if (!flag(p.action_found)) tally(v, "proposal_action_missing");
  }

  return resultOf(
    "I3",
    {
      advances: rows.advances.length,
      settlements: rows.settlements.length,
      payment_rows: rows.paymentRows.length,
      linked_proposals: rows.proposalLinks.length,
      history_paid: history,
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

export async function checkApprovals(admin: Db): Promise<InvariantResult> {
  try {
    return judgeApprovals(await readAll(admin, readApprovals));
  } catch (err) {
    return unreadable("I3", err);
  }
}
