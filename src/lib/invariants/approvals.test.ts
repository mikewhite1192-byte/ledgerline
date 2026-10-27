import { describe, expect, it } from "vitest";
import { judgeApprovals, type ApprovalRows, type PaymentRow } from "./approvals";

const agentRow = (over: Partial<PaymentRow> = {}): PaymentRow => ({
  kind: "advance_payout",
  proposed_by: "agent",
  approver_found: true,
  names_proposal: true,
  proposal_status: "done",
  decided: true,
  sent: true,
  decided_before_sent: true,
  same_proposal: true,
  ...over,
});

function clean(): ApprovalRows {
  return {
    advances: [
      // Paid through the flow, one confirmed payout.
      { seeded: false, flow: true, paid: true, confirmed: 1 },
      // Requested through the flow, not paid yet.
      { seeded: false, flow: true, paid: false, confirmed: 0 },
      // Seeded history, paid before the ledger existed.
      { seeded: true, flow: false, paid: true, confirmed: 0 },
    ],
    settlements: [
      { paid: true, ledger_rows: 1, confirmed: 1 },
      { paid: true, ledger_rows: 0, confirmed: 0 },
      { paid: false, ledger_rows: 1, confirmed: 0 },
    ],
    paymentRows: [
      agentRow(),
      // A person's payout: no proposal needed, an approver always.
      agentRow({ kind: "settlement_payout", proposed_by: "person", names_proposal: false, proposal_status: null, decided: false, decided_before_sent: false }),
      // Failed before it was sent: nothing to order.
      agentRow({ proposal_status: "failed", sent: false, decided_before_sent: false }),
    ],
    proposalLinks: [
      { status: "done", action_found: true },
      { status: "executing", action_found: true },
    ],
  };
}

describe("judgeApprovals", () => {
  it("passes when every payout has a ledger row and an approval", () => {
    const r = judgeApprovals(clean());
    expect(r.verdict).toBe("PASS");
    expect(r.counts).toEqual({ advances: 3, settlements: 3, payment_rows: 3, linked_proposals: 2, history_paid: 2 });
  });

  it("catches an advance paid twice, paid without a payout, or paid but not marked", () => {
    const rows = clean();
    rows.advances = [
      { seeded: false, flow: true, paid: true, confirmed: 2 },
      { seeded: false, flow: true, paid: true, confirmed: 0 },
      { seeded: false, flow: true, paid: false, confirmed: 1 },
    ];
    expect(judgeApprovals(rows).violations).toEqual({
      advance_paid_twice: 1,
      advance_paid_without_payout: 1,
      advance_payout_unmarked: 1,
    });
  });

  it("catches money on an advance outside the flow, and a paid advance nobody can account for", () => {
    const rows = clean();
    rows.advances = [
      { seeded: true, flow: false, paid: true, confirmed: 1 },
      { seeded: false, flow: false, paid: true, confirmed: 0 },
    ];
    expect(judgeApprovals(rows).violations).toEqual({ advance_payout_off_flow: 1, advance_paid_without_payout: 1 });
  });

  it("catches a settlement paid twice, paid without its payout, or paid out but not marked", () => {
    const rows = clean();
    rows.settlements = [
      { paid: true, ledger_rows: 2, confirmed: 2 },
      { paid: true, ledger_rows: 1, confirmed: 0 },
      { paid: false, ledger_rows: 1, confirmed: 1 },
    ];
    expect(judgeApprovals(rows).violations).toEqual({
      settlement_paid_twice: 1,
      settlement_paid_without_payout: 1,
      settlement_payout_unmarked: 1,
    });
  });

  it("catches a payout with no approver", () => {
    const rows = clean();
    rows.paymentRows = [agentRow({ approver_found: false })];
    expect(judgeApprovals(rows).violations).toEqual({ approver_missing: 1 });
  });

  it("catches an agent's payout that names no proposal", () => {
    const rows = clean();
    rows.paymentRows = [agentRow({ names_proposal: false, proposal_status: null })];
    expect(judgeApprovals(rows).violations).toEqual({ agent_payout_without_proposal: 1 });
  });

  it("catches a payout whose proposal is missing, undecided, decided late or another one", () => {
    const cases: [Partial<PaymentRow>, Record<string, number>][] = [
      [{ proposal_status: null }, { proposal_missing: 1 }],
      [{ proposal_status: "proposed", decided: false, decided_before_sent: false }, { proposal_not_approved: 1, proposal_undecided: 1, sent_before_decision: 1 }],
      [{ proposal_status: "rejected" }, { proposal_not_approved: 1 }],
      [{ proposal_status: "expired" }, { proposal_not_approved: 1 }],
      [{ decided_before_sent: false }, { sent_before_decision: 1 }],
      [{ same_proposal: false }, { proposal_mismatch: 1 }],
      [{ proposed_by: "robot" }, { proposer_unknown: 1 }],
    ];
    for (const [change, expected] of cases) {
      const rows = clean();
      rows.paymentRows = [agentRow(change)];
      expect(judgeApprovals(rows).violations).toEqual(expected);
    }
  });

  it("catches a proposal that names a ledger row before it runs, or one that does not exist", () => {
    for (const status of ["proposed", "approved", "rejected", "expired", null]) {
      const rows = clean();
      rows.proposalLinks = [{ status, action_found: true }];
      expect(judgeApprovals(rows).violations).toEqual({ proposal_linked_early: 1 });
    }
    const rows = clean();
    rows.proposalLinks = [{ status: "done", action_found: false }];
    expect(judgeApprovals(rows).violations).toEqual({ proposal_action_missing: 1 });
  });

  it("treats an unreadable value as unread, never as a pass", () => {
    const rows = clean();
    rows.advances[0].confirmed = null;
    expect(() => judgeApprovals(rows)).toThrow("not_whole");
    const odd = clean();
    odd.paymentRows[0].approver_found = "t";
    expect(() => judgeApprovals(odd)).toThrow("not_boolean");
  });
});
