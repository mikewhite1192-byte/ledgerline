import { proposalCardFrom, type AuditContext } from "@/components/agent/proposal-card-from";
import type { ProposalView } from "@/lib/agent/view";

export const NO_PAYOUT_QUESTION = "Approve and carry forward (no payout)?";

// A paystub's waiting card. A $0 week sends nothing, so its confirm says so in words, but only when
// the card asks nothing else: a flag or an auditor verdict other than a pass keeps its own question,
// because that question is why the second confirm is sent.
export function paystubCardFrom(p: ProposalView, audit: AuditContext, netCents: number) {
  const card = proposalCardFrom(p, audit);
  return netCents === 0 ? { ...card, confirmQuestion: card.confirmQuestion ?? NO_PAYOUT_QUESTION } : card;
}
