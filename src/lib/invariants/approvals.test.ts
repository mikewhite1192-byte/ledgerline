import { describe, expect, it } from "vitest";
import { InvariantReadError, type ReadQuery } from "./types";
import { countApprovalBreaks, judgeApprovals, PAYMENT_ROWS_SQL, PROPOSAL_LINKS_SQL, type ApprovalRows } from "./approvals";

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
    ];
    for (const [change, category] of bad) {
      const rows = clean();
      change(rows);
      expect(() => judgeApprovals(rows)).toThrow(category);
    }
  });
});

describe("countApprovalBreaks", () => {
  // A read handle that answers the two SQL texts with the given rows, and refuses any other.
  function answering(rows: ApprovalRows, seen: string[] = []): ReadQuery {
    return {
      query<T>(sql: string): Promise<T[]> {
        seen.push(sql);
        if (sql === PAYMENT_ROWS_SQL) return Promise.resolve(rows.paymentRows as T[]);
        if (sql === PROPOSAL_LINKS_SQL) return Promise.resolve(rows.proposalLinks as T[]);
        return Promise.reject(new Error("unexpected read"));
      },
    };
  }

  it("counts no approval breaks when every payment row and link is clean", async () => {
    const seen: string[] = [];
    expect(await countApprovalBreaks(answering(clean(), seen))).toBe(0);
    // Only the payment rows and the proposal links are read: the carrier's own session.
    expect(seen).toEqual([PAYMENT_ROWS_SQL, PROPOSAL_LINKS_SQL]);
  });

  it("adds every approval break as I3 names them, so one row that breaks several rules counts once for each", async () => {
    const rows = clean();
    rows.paymentRows[0].approver_missing = 1;
    rows.paymentRows[0].sent_before_decision = "2";
    rows.proposalLinks[0].action_missing = 1;
    // The advance and settlement checks are not this count's: a bad one there changes nothing.
    rows.advances[0].paid_twice = 5;
    expect(await countApprovalBreaks(answering(rows))).toBe(4);
    // One payment row on an undecided proposal that was already sent: three of the row's breaks,
    // and its proposal's early link a fourth. The count is of breaks, not of payments.
    const one = clean();
    one.paymentRows[0].not_approved = 1;
    one.paymentRows[0].undecided = 1;
    one.paymentRows[0].sent_before_decision = 1;
    one.proposalLinks[0].linked_early = 1;
    expect(await countApprovalBreaks(answering(one))).toBe(4);
  });

  it("throws, never answers 0, when a read is not whole", async () => {
    const cases: ((r: ApprovalRows) => void)[] = [
      (r) => (r.paymentRows = []),
      (r) => (r.proposalLinks = [r.proposalLinks[0], r.proposalLinks[0]]),
      (r) => (r.paymentRows[0].unread = 1),
      (r) => (r.paymentRows[0].approver_missing = null),
      (r) => (r.proposalLinks[0].linked_early = "x"),
      (r) => (r.paymentRows[0].mismatch = -1),
    ];
    for (const change of cases) {
      const rows = clean();
      change(rows);
      await expect(countApprovalBreaks(answering(rows))).rejects.toBeInstanceOf(InvariantReadError);
    }
    const failing: ReadQuery = { query: () => Promise.reject(new Error("unavailable")) };
    await expect(countApprovalBreaks(failing)).rejects.toThrow();
  });
});
