import type { ProposalCardProps } from "@/components/app/proposal-card";
import { flagWords } from "@/lib/agent/reasons";
import type { ProposalView } from "@/lib/agent/view";
import { formatCents } from "@/lib/format/money";

// A stored proposal as card props. Every word on the card is a fixed label or a fixed sentence
// per reason category; the amount is the engine's, in cents. A flagged proposal asks the flag
// question on confirm and says why above the buttons.

export const FLAG_QUESTION = "This came from a message that failed screening. Approve anyway?";

export function flagNoteFor(categories: readonly string[]): string {
  return `Read with care: the message behind this was flagged for ${flagWords(categories)}.`;
}

export function proposalCardFrom(p: ProposalView): Omit<ProposalCardProps, "hrefFor"> {
  const subject = p.subjectLabel ? ` for ${p.subjectLabel}` : "";
  let confirmQuestion: string | undefined;
  if (p.flagged) confirmQuestion = FLAG_QUESTION;
  else if (p.kind === "advance_payout" && p.subjectLabel && p.amountCents > 0) {
    confirmQuestion = `Pay ${formatCents(p.amountCents)} to ${p.subjectLabel}?`;
  }
  return {
    id: p.id,
    title: `${p.title}${subject}`,
    impact: { cents: p.amountCents, direction: p.direction },
    reasons: p.reasons.map((r) => (r.source ? { text: r.text, source: r.source } : { text: r.text })),
    sources: p.sources,
    status: p.status,
    confirmQuestion,
    flagNote: p.flagged ? flagNoteFor(p.flagCategories) : undefined,
  };
}
