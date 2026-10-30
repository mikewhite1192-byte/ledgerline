import type { ProposalAudit, ProposalCardProps, ProposalVerification } from "@/components/app/proposal-card";
import { auditConfirmQuestion, sentences } from "@/lib/agent/auditor/words";
import { flagWords } from "@/lib/agent/reasons";
import { verification } from "@/lib/agent/verify";
import type { ProposalView } from "@/lib/agent/view";
import { plannedLine, requestStatusWords } from "@/lib/factoring/words";
import { formatInstant, formatLocalDate } from "@/lib/format/dates";
import { sourceLabel } from "@/lib/format/labels";
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

function overrideAt(o: { reason: string; byLabel: string; at: string }, timezone: string) {
  let at = o.at;
  try {
    at = formatInstant(o.at, timezone);
  } catch {
    // shown as stored
  }
  return { reason: o.reason, byLabel: o.byLabel, at };
}

function overrideOf(p: ProposalView, timezone: string): ProposalAudit["override"] {
  return p.auditorOverride ? overrideAt(p.auditorOverride, timezone) : undefined;
}

// Both checks as one label (src/lib/agent/verify.ts), with a person's reason for approving over a
// mismatch. Nothing when the page did not read the engine check.
export function verificationFor(p: ProposalView, ctx?: AuditContext): ProposalVerification | undefined {
  const v = verification(p, ctx?.on ?? false);
  if (!v) return undefined;
  const override = p.engineOverride ? overrideAt(p.engineOverride, ctx?.timezone ?? "UTC") : undefined;
  return override ? { ...v, override } : v;
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

// A card match's line: the card by its last four digits and its pool name, the day and state of
// the purchase, the driver it would go to, and the other drivers who worked near that day.
export function cardMatchDetail(m: ProposalView["cardMatch"]): string | undefined {
  if (!m) return undefined;
  let day: string;
  try {
    day = formatLocalDate(m.postedOn);
  } catch {
    return undefined;
  }
  const where = m.state ? ` in ${m.state}` : "";
  const others = m.others.length > 0 ? ` Others who worked then: ${m.others.join(", ")}.` : " No other driver worked then.";
  return `Card ending ${m.last4} (${m.portalName}), ${day}${where}. To driver ${m.driverCode}.${others}`;
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
      // The card's figures are the plan, whatever the partner did later: the Factoring page shows
      // what came in, so the card never says "you receive" for an invoice that was not funded.
      {
        text: plannedLine(
          formatCents(c.invoices.reduce((t, i) => t + i.netCents, 0)),
          formatCents(c.invoices.reduce((t, i) => t + i.reserveCents, 0)),
          formatCents(c.invoices.reduce((t, i) => t + i.feeCents, 0)),
        ),
      },
      ...(c.requestStatus
        ? [{ text: `Factoring request: ${requestStatusWords(c.requestStatus)}. The Factoring page shows each invoice. Test mode.` }]
        : []),
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
  // A factoring card the simulated partner answered says what came of it, never more.
  const request = p.kind === "factoring_request" && p.cash?.kind === "factoring_request" ? p.cash.requestStatus : null;
  if (request === "funded") return "Came in from the factoring partner (Test mode)";
  if (request === "partly_funded") return "Part of this came in; see Factoring (Test mode)";
  if (request === "submitted" || request === "unknown") return "Sent, not confirmed yet (Test mode)";
  if (request === "declined" || request === "failed") return "Nothing came in (Test mode)";
  if (p.status === "done") return "Recorded in test mode; no money moved";
  if (p.status === "proposed" || p.status === "approved" || p.status === "executing") {
    return p.kind === "factoring_request" ? "Would come in before Friday" : "Past due from this customer";
  }
  return undefined;
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
  const verify = verificationFor(p, audit);
  const detention =
    p.kind === "detention_charge" && p.detention
      ? detentionLines(p.detention, p.amountCents).map((text) => ({ text }))
      : [];
  const cash = p.cash ? cashLines(p.cash) : [];
  const cashLabel = cashImpactLabel(p);
  const card: CardProps = {
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
    ...(p.kind === "card_match" && p.cardMatch ? { detail: cardMatchDetail(p.cardMatch) } : {}),
    confirmQuestion,
    confirmNoun: copy.noun,
    ...(confirmNext ? { confirmNext } : {}),
    ...(references ? { references } : {}),
    flagNote: p.flagged ? flagNoteFor(p.flagCategories) : undefined,
    ...(audit ? { audit: auditFor(p, audit) } : {}),
    ...(verify ? { verification: verify } : {}),
    // An advance, a pay correction, a money code, a card match and a factoring card have executors
    // that resume an approval left approved by a stop before its run finished (the correction's pay
    // item is keyed by the proposal, a money code is one row per proposal, the match's card and
    // purchase by its statement row, and a factoring request by the proposal, so a resume never
    // writes a second). An executing one is already running (an advance's page and a code's page
    // check it; a correction or a match never stays executing, since its run is one transaction).
    ...((p.kind === "advance_payout" ||
      p.kind === "pay_correction" ||
      p.kind === "money_code" ||
      p.kind === "card_match" ||
      p.kind === "factoring_request") &&
      p.status === "approved"
      ? { canResume: true }
      : {}),
    // A factoring card stays executing when its run stopped before every invoice was sent. Resume
    // sends only an invoice still waiting to go: each invoice's ledger row is keyed by the invoice
    // and its attempt, only the caller that claims a reserved row sends it, a row already sent is
    // never sent again, and every switch is asked again first. Offered only while the request reads
    // submitted; one waiting on the partner's answer is Check pending's, on the Factoring page.
    ...(p.kind === "factoring_request" &&
    p.status === "executing" &&
    p.cash?.kind === "factoring_request" &&
    p.cash.requestStatus === "submitted"
      ? { canResume: true }
      : {}),
  };
  return p.kind === "pay_rule_change" ? ruleChangeCard(p, card, audit, viewer) : card;
}
