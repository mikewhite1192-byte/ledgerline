import { describe, expect, it } from "vitest";
import { judgeApprovals, type ApprovalRows } from "./approvals";

// The per-record rules run in SQL; scripts/invariants.db.test.ts plants each kind of bad row on a
// real database. These cover how the aggregate counts become the result.
function clean(): ApprovalRows {
  return {
    advances: [
      { advances: 3, unread: 0, paid_twice: 0, paid_without_payout: 0, payout_unmarked: 0, off_flow: 0, history: 1 },
    ],
    settlements: [{ settlements: "3", unread: "0", paid_twice: 0, payout_unmarked: 0, paid_without_payout: 0, history: 1 }],
    paymentRows: [
      {
        payment_rows: 3,
        unread: 0,
        approver_missing: 0,
        agent_without_proposal: 0,
        proposer_unknown: 0,
        proposal_missing: 0,
        not_approved: 0,
        undecided: 0,
        sent_before_decision: 0,
        mismatch: 0,
      },
    ],
    proposalLinks: [{ linked_proposals: 2, unread: 0, linked_early: 0, action_missing: 0 }],
    judgeApprovals: [{ approvals: 5, by_judge: 0 }],
  };
}

describe("judgeApprovals", () => {
  it("passes when every payout has a ledger row and an approval, with counts of what it read", () => {
    const r = judgeApprovals(clean());
    expect(r.verdict).toBe("PASS");
    expect(r.counts).toEqual({ advances: 3, settlements: 3, payment_rows: 3, linked_proposals: 2, history_paid: 2 });
  });

  it("reports each aggregate's count under its category", () => {
    const cases: [(rows: ApprovalRows) => void, Record<string, number>][] = [
      [(r) => (r.advances[0].paid_twice = 1), { advance_paid_twice: 1 }],
      [(r) => (r.advances[0].paid_without_payout = 2), { advance_paid_without_payout: 2 }],
      [(r) => (r.advances[0].payout_unmarked = 1), { advance_payout_unmarked: 1 }],
      [(r) => (r.advances[0].off_flow = 1), { advance_payout_off_flow: 1 }],
      [(r) => (r.settlements[0].paid_twice = 1), { settlement_paid_twice: 1 }],
      [(r) => (r.settlements[0].payout_unmarked = 1), { settlement_payout_unmarked: 1 }],
      [(r) => (r.settlements[0].paid_without_payout = "1"), { settlement_paid_without_payout: 1 }],
      [(r) => (r.paymentRows[0].approver_missing = 1), { approver_missing: 1 }],
      [(r) => (r.paymentRows[0].agent_without_proposal = 1), { agent_payout_without_proposal: 1 }],
      [(r) => (r.paymentRows[0].proposer_unknown = 1), { proposer_unknown: 1 }],
      [(r) => (r.paymentRows[0].proposal_missing = 1), { proposal_missing: 1 }],
      [(r) => (r.paymentRows[0].not_approved = 1), { proposal_not_approved: 1 }],
      [(r) => (r.paymentRows[0].undecided = 1), { proposal_undecided: 1 }],
      [(r) => (r.paymentRows[0].sent_before_decision = 1), { sent_before_decision: 1 }],
      [(r) => (r.paymentRows[0].mismatch = 1), { proposal_mismatch: 1 }],
      [(r) => (r.proposalLinks[0].linked_early = 1), { proposal_linked_early: 1 }],
      [(r) => (r.proposalLinks[0].action_missing = 1), { proposal_action_missing: 1 }],
      [(r) => (r.judgeApprovals[0].by_judge = "1"), { approved_by_judge: 1 }],
    ];
    for (const [change, expected] of cases) {
      const rows = clean();
      change(rows);
      const r = judgeApprovals(rows);
      expect(r.verdict).toBe("FAIL");
      expect(r.violations).toEqual(expected);
    }
  });

  it("treats a count that is not a whole number, or a record the read refused, as unread, never as a pass", () => {
    const bad: [(rows: ApprovalRows) => void, string][] = [
      [(r) => (r.advances[0].history = null), "not_whole"],
      [(r) => (r.settlements[0].paid_twice = "1.0"), "not_whole"],
      [(r) => (r.paymentRows[0].payment_rows = -3), "not_whole"],
      [(r) => (r.proposalLinks[0].action_missing = "t"), "not_whole"],
      [(r) => (r.advances[0].unread = 1), "not_boolean"],
      [(r) => (r.settlements[0].unread = 1), "not_boolean"],
      [(r) => (r.paymentRows[0].unread = 1), "not_boolean"],
      [(r) => (r.proposalLinks[0].unread = 1), "not_boolean"],
      [(r) => (r.advances = []), "advances_unread"],
      [(r) => r.settlements.push(r.settlements[0]), "settlements_unread"],
      [(r) => (r.paymentRows = []), "payment_rows_unread"],
      [(r) => (r.proposalLinks = []), "proposal_links_unread"],
      [(r) => (r.judgeApprovals = []), "judge_approvals_unread"],
      [(r) => (r.judgeApprovals[0].by_judge = null), "not_whole"],
      [(r) => (r.judgeApprovals[0].approvals = -1), "not_whole"],
    ];
    for (const [change, category] of bad) {
      const rows = clean();
      change(rows);
      expect(() => judgeApprovals(rows)).toThrow(category);
    }
  });
});
