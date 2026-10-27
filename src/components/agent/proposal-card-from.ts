import type { ProposalAudit, ProposalCardProps } from "@/components/app/proposal-card";
import { auditConfirmQuestion, sentences } from "@/lib/agent/auditor/words";
import { flagWords } from "@/lib/agent/reasons";
import type { ProposalView } from "@/lib/agent/view";
import { formatInstant } from "@/lib/format/dates";
import { formatCents } from "@/lib/format/money";

// A stored proposal as card props. Every word on the card is a fixed label or a fixed sentence
// per reason category; the amount is the engine's, in cents. A flagged proposal asks the flag
// question on confirm and says why above the buttons.

export const FLAG_QUESTION = "This came from a message that failed screening. Approve anyway?";

export function flagNoteFor(categories: readonly string[]): string {
  return `Read with care: the message behind this was flagged for ${flagWords(categories)}.`;
}

// What the page knows about the auditor: whether it is switched on, and whether this page is
// waiting on its check for the proposal right now.
export type AuditContext = { on: boolean; checking: boolean };

function overrideOf(p: ProposalView): ProposalAudit["override"] {
  if (!p.auditorOverride) return undefined;
  let at = p.auditorOverride.at;
  try {
    at = formatInstant(p.auditorOverride.at, "UTC");
  } catch {
    // shown as stored
  }
  return { reason: p.auditorOverride.reason, byLabel: p.auditorOverride.byLabel, at };
}

// The auditor's line on the card, from the stored verdict. Concerns are fixed sentences per
// category; a verdict the card does not know reads as not checked.
export function auditFor(p: ProposalView, ctx: AuditContext): ProposalAudit {
  const v = p.auditorVerdict;
  if (v === "pass") return { state: "pass" };
  if (v === "concerns") return { state: "concerns", text: sentences(p.auditorConcerns) };
  if (v === "block") {
    const override = overrideOf(p);
    return { state: "block", text: sentences(p.auditorConcerns), ...(override ? { override } : {}) };
  }
  if (v === "unknown" && p.auditorConcerns.includes("budget")) return { state: "budget" };
  if (v !== null) return { state: "unknown", text: sentences(p.auditorConcerns) };
  if (!ctx.on) return { state: "off" };
  return ctx.checking && p.status === "proposed" ? { state: "checking" } : { state: "unknown" };
}

// Where an advance would land, as the card's line under the amount. Only a card on file says
// "Test mode": a missing card is a plain fact, not a test-mode payout.
function destinationFor(p: ProposalView): ProposalCardProps["destination"] {
  if (!p.destination) return undefined;
  return p.destination.last4
    ? { label: `To ${p.destination.label}`, testMode: true }
    : { label: "No fuel card on file", testMode: false };
}

export function proposalCardFrom(
  p: ProposalView,
  audit?: AuditContext,
): Omit<ProposalCardProps, "hrefFor"> {
  const subject = p.subjectLabel ? ` for ${p.subjectLabel}` : "";
  let confirmQuestion: string | undefined;
  // Anything other than a pass needs the second confirm, and the question names why.
  const auditQuestion =
    audit && p.auditorVerdict !== "pass" && p.auditorVerdict !== "block"
      ? auditConfirmQuestion(p.auditorVerdict ?? "unknown", p.auditorConcerns)
      : null;
  if (p.flagged) confirmQuestion = FLAG_QUESTION;
  else if (auditQuestion) confirmQuestion = auditQuestion;
  else if (p.kind === "advance_payout" && p.subjectLabel && p.amountCents > 0) {
    confirmQuestion = p.destination?.last4
      ? `Pay ${formatCents(p.amountCents)} to ${p.subjectLabel}'s ${p.destination.label}? Test mode.`
      : `Pay ${formatCents(p.amountCents)} to ${p.subjectLabel}?`;
  }
  return {
    id: p.id,
    title: `${p.title}${subject}`,
    impact: { cents: p.amountCents, direction: p.direction },
    reasons: p.reasons.map((r) => (r.source ? { text: r.text, source: r.source } : { text: r.text })),
    sources: p.sources,
    status: p.status,
    destination: destinationFor(p),
    confirmQuestion,
    flagNote: p.flagged ? flagNoteFor(p.flagCategories) : undefined,
    ...(audit ? { audit: auditFor(p, audit) } : {}),
    // Only an advance has an executor that resumes an approval left approved by a stop before its
    // run finished; an executing one is already running (its advance's page checks it).
    ...(p.kind === "advance_payout" && p.status === "approved" ? { canResume: true } : {}),
  };
}
