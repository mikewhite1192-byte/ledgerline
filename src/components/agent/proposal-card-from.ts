import type { ProposalAudit, ProposalCardProps } from "@/components/app/proposal-card";
import { auditConfirmQuestion, sentences } from "@/lib/agent/auditor/words";
import { flagWords } from "@/lib/agent/reasons";
import type { ProposalView } from "@/lib/agent/view";
import { formatInstant } from "@/lib/format/dates";
import { formatCents } from "@/lib/format/money";
import { isRuleKey } from "@/lib/pay-rules/rules";
import {
  AUDIT_LINES,
  CONCERNS_QUESTION,
  FAILED_LINE,
  FLAGGED_QUESTION,
  NOT_NOW_LABEL,
  NOTHING_CHANGES,
  PAY_RULES_PATH,
  REJECTED_LINE,
  SAVE_LABEL,
  SAVE_QUESTION,
  SAVED_LINK,
  SAVING_LABEL,
  SAVING_LINE,
  UNCHECKED_QUESTION,
  adminOnlyLabel,
  impactLabel,
  impactLine,
  ruleTitle,
  savedLine,
  shortPeriod,
  startsLine,
} from "@/lib/pay-rules/words";

// A stored proposal as card props. Every word on the card is a fixed label or a fixed sentence
// per reason category; the amount is the engine's, in cents. A flagged proposal asks the flag
// question on confirm and says why above the buttons.

export const FLAG_QUESTION = "This came from a message that failed screening. Approve anyway?";

export function flagNoteFor(categories: readonly string[]): string {
  return `Read with care: the message behind this was flagged for ${flagWords(categories)}.`;
}

// What the page knows about the auditor: whether it is switched on, whether this page is
// waiting on its check for the proposal right now, and the carrier's time zone for the time of an
// override (UTC only when the page does not know it).
export type AuditContext = { on: boolean; checking: boolean; timezone?: string };

function overrideOf(p: ProposalView, timezone: string): ProposalAudit["override"] {
  if (!p.auditorOverride) return undefined;
  let at = p.auditorOverride.at;
  try {
    at = formatInstant(p.auditorOverride.at, timezone);
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
    const override = overrideOf(p, ctx.timezone ?? "UTC");
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

// An advance's load line: the load and, under a per-load cap, what was left after this advance
// when it was proposed. The numbers are the engine's at proposal time, stored on the proposal.
export function advanceLoadDetail(load: ProposalView["load"]): string | undefined {
  if (!load) return undefined;
  if (load.capCents === null || load.leftAfterCents === null) return `For load ${load.number}.`;
  return `Load ${load.number}: ${formatCents(load.leftAfterCents)} of ${formatCents(load.capCents)} cap left after this.`;
}

// Hours and minutes, as the card says a stop's time: 420 is "7 h 00 min".
export function hoursMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

// A detention charge's why, one line per stop and one for the invoice, every figure from the
// proposal's stored args (the engine's numbers at proposal time).
export function detentionLines(d: NonNullable<ProposalView["detention"]>, amountCents: number): string[] {
  const free = hoursMinutes(d.freeMinutes);
  const rate = formatCents(d.hourlyCents);
  const lines = d.stops.map((s) => {
    const place = s.stop === "pickup" ? "the shipper" : "the consignee";
    const quarters = `${s.quarters} started quarter ${s.quarters === 1 ? "hour" : "hours"}`;
    return `${hoursMinutes(s.dwellMinutes)} at ${place}, ${free} free, ${quarters} at ${rate} an hour: ${formatCents(s.cents)}.`;
  });
  const after = formatCents(d.invoiceAmountBeforeCents + amountCents);
  lines.push(`The open invoice goes from ${formatCents(d.invoiceAmountBeforeCents)} to ${after}.`);
  return lines;
}

// Who is looking at the card, for a kind whose button says up front that only an admin may save
// it: admin, and the amount above which the approval gate asks for one (flags.approverRole).
export type Viewer = { admin: boolean; adminAboveCents: number };

type CardProps = Omit<ProposalCardProps, "hrefFor">;

// A pay rule change's card, in the words of its design: the rule and both values as the title,
// when it starts, what it would have done to last week's pay (each figure linked to its paystub),
// the double-check, and that nothing changes until it is saved. The amount is the engine's change
// to last week's total net pay; it moves no money, so it shows unsigned with its own label.
function ruleChangeCard(p: ProposalView, base: CardProps, audit?: AuditContext, viewer?: Viewer): CardProps {
  const c = p.ruleChange ?? null;
  const net = c
    ? c.impact.netDeltaCents
    : p.direction === "out"
      ? p.amountCents
      : p.direction === "in"
        ? -p.amountCents
        : 0;
  const reasons: ProposalCardProps["reasons"] = [];
  const sources: NonNullable<ProposalCardProps["sources"]> = [];
  if (c) {
    reasons.push({ text: startsLine(c) });
    const top = c.impact.top[0];
    reasons.push({
      text: impactLine(c.impact),
      ...(top ? { source: { table: "settlements", id: top.settlementId }, label: `Driver ${top.code}'s paystub` } : {}),
    });
    if (c.impact.periodId && c.impact.periodStart && c.impact.periodEnd) {
      sources.push({
        table: "settlement_periods",
        id: c.impact.periodId,
        label: `Last week's pay (${shortPeriod(c.impact.periodStart, c.impact.periodEnd)})`,
      });
    }
    for (const t of c.impact.top.slice(1)) {
      sources.push({ table: "settlements", id: t.settlementId, label: `Driver ${t.code}'s paystub` });
    }
  }
  let confirmQuestion = SAVE_QUESTION;
  if (p.flagged) confirmQuestion = FLAGGED_QUESTION;
  else if (audit && p.auditorVerdict === "concerns") confirmQuestion = CONCERNS_QUESTION;
  else if (audit && p.auditorVerdict !== "pass" && p.auditorVerdict !== "block") confirmQuestion = UNCHECKED_QUESTION;
  const overAdmin = viewer !== undefined && !viewer.admin && p.amountCents > viewer.adminAboveCents;
  return {
    ...base,
    title: c && isRuleKey(c.ruleKey) ? ruleTitle({ ...c, ruleKey: c.ruleKey }) : p.title,
    impact: { cents: p.amountCents, direction: "none", label: impactLabel(net) },
    reasons,
    sources,
    confirmQuestion,
    wording: { approve: SAVE_LABEL, approving: SAVING_LABEL, question: SAVE_QUESTION, reject: NOT_NOW_LABEL },
    ...(overAdmin && p.status === "proposed" ? { approveBlockedLabel: adminOnlyLabel(viewer.adminAboveCents) } : {}),
    auditWords: AUDIT_LINES,
    footnote: NOTHING_CHANGES,
    noOverride: true,
    statusNotes: {
      approved: { text: SAVING_LINE },
      executing: { text: SAVING_LINE },
      done: c
        ? { text: savedLine(c.effectiveFrom), link: { href: PAY_RULES_PATH, label: SAVED_LINK } }
        : { text: `Saved. See it under ${SAVED_LINK}.`, link: { href: PAY_RULES_PATH, label: SAVED_LINK } },
      failed: { text: FAILED_LINE },
      rejected: { text: REJECTED_LINE },
    },
    // The executor re-sizes the whole change on a resume and writes at most one version.
    ...(p.status === "approved" ? { canResume: true } : {}),
  };
}

export function proposalCardFrom(
  p: ProposalView,
  audit?: AuditContext,
  viewer?: Viewer,
): CardProps {
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
  const detention =
    p.kind === "detention_charge" && p.detention
      ? detentionLines(p.detention, p.amountCents).map((text) => ({ text }))
      : [];
  const card: CardProps = {
    id: p.id,
    title: `${p.title}${subject}`,
    impact: { cents: p.amountCents, direction: p.direction },
    reasons: [
      ...detention,
      ...p.reasons.map((r) => (r.source ? { text: r.text, source: r.source } : { text: r.text })),
    ],
    sources: p.sources,
    status: p.status,
    destination: destinationFor(p),
    ...(p.kind === "advance_payout" && p.load ? { detail: advanceLoadDetail(p.load) } : {}),
    confirmQuestion,
    flagNote: p.flagged ? flagNoteFor(p.flagCategories) : undefined,
    ...(audit ? { audit: auditFor(p, audit) } : {}),
    // An advance and a pay correction have executors that resume an approval left approved by a
    // stop before its run finished (the correction's pay item is keyed by the proposal, so a
    // resume never writes a second). An executing one is already running (an advance's page
    // checks it; a correction never stays executing, since its run is one transaction).
    ...((p.kind === "advance_payout" || p.kind === "pay_correction") && p.status === "approved"
      ? { canResume: true }
      : {}),
  };
  return p.kind === "pay_rule_change" ? ruleChangeCard(p, card, audit, viewer) : card;
}
