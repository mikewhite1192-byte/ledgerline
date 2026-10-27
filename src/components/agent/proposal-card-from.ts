import type { ProposalAudit, ProposalCardProps } from "@/components/app/proposal-card";
import { auditConfirmQuestion, sentences } from "@/lib/agent/auditor/words";
import { flagWords } from "@/lib/agent/reasons";
import type { ProposalView } from "@/lib/agent/view";
import { formatInstant, formatLocalDate } from "@/lib/format/dates";
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

// "2026-11-06" as "Nov 6"; the card's dates sit within weeks of today.
function shortDay(value: string): string {
  return formatLocalDate(value).replace(/, \d{4}$/, "");
}

// A whole percent from basis points, as the card says a factoring rate: 9000 is "90%", 250 "2.5%".
export function percentOf(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}%`;
}

// A Cash Friday card's why, every figure from the proposal's stored args (the engine's numbers
// when the check ran). Each line links to the record it names.
export function cashLines(c: NonNullable<ProposalView["cash"]>): { text: string; source?: { table: string; id: string } }[] {
  if (c.kind === "factoring_request") {
    return [
      ...c.invoices.map((i) => ({
        text:
          `${i.invoiceNumber}: ${formatCents(i.balanceCents)} owed. ${formatCents(i.advanceCents)} paid now, ` +
          `less a ${formatCents(i.feeCents)} fee; ${formatCents(i.reserveCents)} held until the customer pays.`,
        source: { table: "invoices", id: i.invoiceId },
      })),
      {
        text: `The factoring partner pays ${percentOf(c.advanceBps)} up front and charges ${percentOf(c.feeBps)}, against a ${formatCents(c.shortCents)} short.`,
      },
    ];
  }
  if (c.kind === "bill_defer") {
    return [
      {
        text: `${c.billRef} for ${formatCents(c.amountCents)} is due ${shortDay(c.dueOn)}. It would move to ${shortDay(c.deferredTo)}, after pay day.`,
        source: { table: "vendor_bills", id: c.billId },
      },
    ];
  }
  const lines: { text: string; source?: { table: string; id: string } }[] = c.invoices.map((i) => ({
    text: `${i.invoiceNumber}: ${formatCents(i.balanceCents)}, due ${shortDay(i.dueOn)}.`,
    source: { table: "invoices", id: i.invoiceId },
  }));
  const more = c.overdueInvoices - c.invoices.length;
  if (more > 0) lines.push({ text: `${more} more past-due ${more === 1 ? "invoice" : "invoices"} not listed here.` });
  return lines;
}

// What the amount line says on a Cash Friday card. A test-mode card never says money came in.
function cashImpactLabel(p: ProposalView): string | undefined {
  if (p.kind === "bill_defer") return "Bill amount; only its date moves";
  if (p.kind !== "factoring_request" && p.kind !== "collections_chase") return undefined;
  if (p.status === "done") return "Recorded in test mode; no money moved";
  if (p.status === "proposed" || p.status === "approved" || p.status === "executing") {
    return p.kind === "factoring_request" ? "Would come in before Friday" : "Past due from this customer";
  }
  return undefined;
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
  const detention =
    p.kind === "detention_charge" && p.detention
      ? detentionLines(p.detention, p.amountCents).map((text) => ({ text }))
      : [];
  const cash = p.cash ? cashLines(p.cash) : [];
  const cashLabel = cashImpactLabel(p);
  return {
    id: p.id,
    title: `${p.title}${subject}`,
    impact: { cents: p.amountCents, direction: p.direction, ...(cashLabel ? { label: cashLabel } : {}) },
    reasons: [
      ...detention,
      ...cash,
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
}
