import type { ProposalAudit, ProposalCardProps } from "@/components/app/proposal-card";
import { auditConfirmQuestion, sentences } from "@/lib/agent/auditor/words";
import { flagWords } from "@/lib/agent/reasons";
import type { ProposalView } from "@/lib/agent/view";
import { formatInstant } from "@/lib/format/dates";
import { sourceLabel } from "@/lib/format/labels";
import { formatCents } from "@/lib/format/money";

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
    ? { label: `To fuel card ending ${p.destination.last4}`, testMode: true }
    : { label: "No fuel card on file", testMode: false };
}

// What the confirm says for each kind of card: the noun its count line and Reject use ("1 advance,
// $100.00."), the question when the card asks nothing else (a flag or a second-check question goes
// first), and what happens once it is confirmed, one sentence that says only what that kind's
// approval does. A kind with no row reads the fallback, so a new kind only adds a row here.
// Copy only: the approval and what it sends never depend on this table.
type KindCopy = {
  noun: string;
  ask?: (p: ProposalView, amount: string) => string | undefined;
  next?: (p: ProposalView) => string;
};

const FALLBACK_COPY: KindCopy = { noun: "request" };

const KIND_COPY: Readonly<Record<string, KindCopy>> = {
  advance_payout: {
    noun: "advance",
    ask: (p, amount) => {
      if (p.amountCents <= 0) return undefined;
      if (!p.subjectLabel) return `Pay this ${amount} advance?`;
      return p.destination?.last4
        ? `Pay ${amount} to ${p.subjectLabel}'s fuel card ending ${p.destination.last4}?`
        : `Pay ${amount} to ${p.subjectLabel}?`;
    },
    next: (p) =>
      p.destination && !p.destination.last4
        ? "This driver has no fuel card on file, so nothing can be paid until one is added."
        : "This is a test payout to the driver's fuel card. It is taken back from the driver's pay on a later paystub.",
  },
  pay_correction: {
    noun: "pay correction",
    ask: (p) => (p.subjectLabel ? `Add this pay correction to ${p.subjectLabel}'s pay?` : undefined),
    next: () => "It is added as one line on the driver's paystub for this week. Nothing is paid now.",
  },
  load_rate_fill: {
    noun: "load rate",
    ask: (p) => (p.subjectLabel ? `Write the rate onto load ${p.subjectLabel}?` : undefined),
    next: () => "The rate is written onto the load. No money moves and nothing is sent.",
  },
  invoice_post: {
    noun: "invoice",
    ask: (p, amount) => (p.subjectLabel ? `Create a ${amount} invoice for load ${p.subjectLabel}?` : `Create this ${amount} invoice?`),
    next: () =>
      "The invoice is created and the load is marked invoiced. It is booked to QuickBooks only when accounting is on. Nothing is emailed to the customer.",
  },
  payment_reapply: {
    noun: "payment",
    ask: (p) => (p.subjectLabel ? `Move payment ${p.subjectLabel} to the right invoice?` : undefined),
    next: () => "The payment moves off the wrong invoice and onto the right one. No money moves and nothing is sent.",
  },
  detention_charge: {
    noun: "detention charge",
    ask: (p, amount) => (p.subjectLabel ? `Add a ${amount} detention charge to load ${p.subjectLabel}?` : undefined),
    next: () => "The charge is added to the load and its open invoice goes up by the same amount. Nothing is sent to the customer.",
  },
  settlement_approve: {
    noun: "paystub",
    // A $0 week asks nothing here: the paystub card asks its own no-payout question.
    ask: (p, amount) => (p.amountCents > 0 ? `Approve this paystub and pay ${amount}?` : undefined),
    next: (p) =>
      p.amountCents > 0
        ? "The paystub is checked against the records once more, then paid to the driver's bank by test payout when payouts are on."
        : "No payout is sent. The paystub is booked, and any deductions left over carry to next week.",
  },
};

export function kindCopy(kind: string): KindCopy {
  return Object.hasOwn(KIND_COPY, kind) ? KIND_COPY[kind] : FALLBACK_COPY;
}

// A subject's kind in words where the record list's word does not fit the code it carries: a
// payment application is named by its payment's reference.
const SUBJECT_NOUN: Readonly<Record<string, string>> = { payment_applications: "Payment" };

// The names the card can give its records: the subject, by the code the proposal view read for it
// ("Driver BR-D07", "Load BR-L0412"). Every other record falls back to its kind, never an id tail.
function referencesFor(p: ProposalView): Record<string, string> | undefined {
  const code = p.subjectLabel?.trim();
  if (!code) return undefined;
  const noun = Object.hasOwn(SUBJECT_NOUN, p.subjectTable) ? SUBJECT_NOUN[p.subjectTable] : sourceLabel(p.subjectTable);
  return { [`${p.subjectTable}:${p.subjectId}`]: `${noun} ${code}` };
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

export function proposalCardFrom(
  p: ProposalView,
  audit?: AuditContext,
): Omit<ProposalCardProps, "hrefFor"> {
  const subject = p.subjectLabel ? ` for ${p.subjectLabel}` : "";
  const copy = kindCopy(p.kind);
  let confirmQuestion: string | undefined;
  // Anything other than a pass needs the second confirm, and the question names why.
  const auditQuestion =
    audit && p.auditorVerdict !== "pass" && p.auditorVerdict !== "block"
      ? auditConfirmQuestion(p.auditorVerdict ?? "unknown", p.auditorConcerns)
      : null;
  if (p.flagged) confirmQuestion = FLAG_QUESTION;
  else if (auditQuestion) confirmQuestion = auditQuestion;
  else confirmQuestion = copy.ask?.(p, formatCents(Math.abs(p.amountCents)));
  const confirmNext = copy.next?.(p);
  const references = referencesFor(p);
  const detention =
    p.kind === "detention_charge" && p.detention
      ? detentionLines(p.detention, p.amountCents).map((text) => ({ text }))
      : [];
  return {
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
    confirmNoun: copy.noun,
    ...(confirmNext ? { confirmNext } : {}),
    ...(references ? { references } : {}),
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
}
