import { atOrAfterBooksStart, booksStatus, latestByKind, needsPersonReason, type BooksRow } from "../books/status";
import type { DocumentView } from "../documents/types";
import { formatInstant, formatPeriod, isRealInstant } from "../format/dates";
import { formatCents } from "../format/money";
import { ACTOR_LABELS, type FeedLine } from "../feed/words";
import type { MoneyActionKind, MoneyActionState } from "../money/types";
import { parkLabel } from "../settlements/labels";
import { instantOfLocal, isLocalClock } from "../tms/clocks";

// One load's whole road, from the bill of lading to the paystub in QuickBooks, as eight fixed steps
// built from rows other code already wrote (src/lib/journey/read.ts reads them). Pure: no database,
// no clock but the one passed in. Every figure is a stored cents value, never one computed here;
// every sentence is fixed words around stored codes, so nothing a model or an outside system wrote
// reaches a line as an instruction.

export const STEP_KEYS = [
  "bol",
  "advance_drafted",
  "advance_paid",
  "advance_books",
  "pod",
  "paystub_drafted",
  "paystub_paid",
  "paystub_books",
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export const STEP_TITLES: Readonly<Record<StepKey, string>> = {
  bol: "Bill of lading received",
  advance_drafted: "Advance drafted",
  advance_paid: "Advance paid",
  advance_books: "Advance recorded in QuickBooks",
  pod: "Proof of delivery received",
  paystub_drafted: "Paystub drafted",
  paystub_paid: "Paystub approved and paid",
  paystub_books: "Paystub recorded in QuickBooks",
};

// done: it happened. now: the first step still to come, what the road waits on. waiting: a later
// step still to come. stopped: it ended without happening (rejected, failed, parked). skipped: it
// does not apply to this load (no advance at pickup, a paystub paid before the app).
export type StepState = "done" | "now" | "waiting" | "stopped" | "skipped";

// Who took a step, by role word, resolved in the SQL so a login id never leaves the database.
export type ActorCode = "admin" | "staff" | "judge" | "autopilot" | "desk" | "someone";

export type LoadStatus = "planned" | "in_transit" | "delivered" | "invoiced" | "cancelled";
export type MoveSource = "driver_photo" | "driver_text" | "driver_voice" | "staff" | "demo_feed" | "seed" | "tms";

export type JourneyLoad = {
  id: string;
  number: string;
  status: LoadStatus;
  driverId: string | null;
  driverName: string | null;
  origin: string;
  destination: string;
  pickedUpAt: string | null;
  deliveredAt: string | null;
};

export type JourneyDocument = Pick<DocumentView, "id" | "filename" | "mime" | "kind" | "readStatus" | "stalled" | "read" | "match">;

export type JourneyMove = {
  id: string;
  toStatus: "in_transit" | "delivered";
  source: MoveSource;
  at: string;
  document: JourneyDocument | null;
  // What the desk did with the move: its done line's category word, or failed.
  desk: { kind: "done" | "failed"; category: string | null; at: string } | null;
};

export type JourneyCard = {
  id: string;
  status: "proposed" | "approved" | "rejected" | "expired" | "executing" | "done" | "failed";
  amountCents: number;
  createdAt: string;
  auditVerdict: string | null;
  autopilotMode: string | null;
  decidedAt: string | null;
  decidedBy: ActorCode | null;
};

export type JourneyAdvance = {
  id: string;
  status: "requested" | "approved" | "paid" | "rejected" | "cancelled" | "parked";
  amountCents: number;
  paidAt: string | null;
  createdAt: string;
  proposalId: string | null;
};

export type JourneyMoney = BooksRow & {
  kind: MoneyActionKind;
  state: MoneyActionState;
  amountCents: number;
  outsideSystem: string | null;
  outsideId: string | null;
  settledAt: string | null;
  createdAt: string;
};

export type JourneyLine = {
  seq: number;
  kind: string;
  label: string;
  amountCents: number;
  sources: { table: string; id: string }[];
  meta: Record<string, unknown> | null;
};

export type JourneySettlement = {
  id: string;
  status: "draft" | "approved" | "paid";
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  paidAt: string | null;
  parkedReason: string | null;
  createdAt: string;
  periodStart: string;
  periodEnd: string;
  lines: JourneyLine[];
  card: JourneyCard | null;
  legs: JourneyMoney[];
};

// What the dispatch board holds for the load: the truck and the last delivery stop's window, as
// the board wrote it (local wall time in the carrier's zone). Null when the board has none.
export type JourneyDispatch = { truck: string | null; dueLocal: string | null };

export type JourneyFacts = {
  load: JourneyLoad;
  moves: JourneyMove[];
  card: JourneyCard | null;
  advance: JourneyAdvance | null;
  advanceMoney: JourneyMoney[];
  settlement: JourneySettlement | null;
  dispatch: JourneyDispatch;
};

export type JourneyOptions = {
  zone: string;
  books: { enabled: boolean; startDate: string; maxAttempts: number };
};

export type PaystubSummaryLine = {
  seq: number;
  kind: string;
  label: string;
  amountCents: number;
  // Stored facts in words: "5 days at $11.00 a day" for insurance. Never a figure worked out here.
  note: string | null;
  thisLoad: boolean;
};

export type PaystubSummary = {
  id: string;
  href: string;
  period: string;
  lines: PaystubSummaryLine[];
  grossCents: number;
  deductionsCents: number;
  netCents: number;
};

export type JourneyStep = {
  key: StepKey;
  title: string;
  state: StepState;
  at: string | null;
  time: string | null;
  actor: string | null;
  fact: string;
  tag: string | null;
  // A stored amount the step moved or drafted, shown as its figure.
  figureCents: number | null;
  href: string | null;
  hrefLabel: string | null;
  // The bill of lading or proof of delivery behind a driver's photo, as the document model read it
  // and code matched it.
  document: JourneyDocument | null;
  paystub: PaystubSummary | null;
};

// A step as the builder first sees it: done, ended, not for this load, or still to come.
type Draft = Omit<JourneyStep, "key" | "title" | "state" | "time"> & { state: "done" | "stopped" | "skipped" | "pending" };

const blank = { at: null, actor: null, tag: null, figureCents: null, href: null, hrefLabel: null, document: null, paystub: null };
const pending = (fact: string, more: Partial<Draft> = {}): Draft => ({ ...blank, state: "pending", fact, ...more });
const done = (at: string | null, fact: string, more: Partial<Draft> = {}): Draft => ({ ...blank, state: "done", at, fact, ...more });
const stopped = (fact: string, more: Partial<Draft> = {}): Draft => ({ ...blank, state: "stopped", fact, ...more });
const skipped = (fact: string, more: Partial<Draft> = {}): Draft => ({ ...blank, state: "skipped", fact, ...more });

const actorWord = (a: ActorCode | null) => (a === null ? null : ACTOR_LABELS[a]);
const LEDGERLINE = ACTOR_LABELS.desk;

// Who reported a move, by the move's source.
const MOVE_ACTORS: Readonly<Record<MoveSource, string>> = {
  driver_photo: "Driver",
  driver_text: "Driver",
  driver_voice: "Driver",
  staff: "Staff",
  demo_feed: "Sample dispatch board",
  seed: "Sample history",
  tms: "Dispatch board",
};

const MOVE_WORDS: Readonly<Record<"in_transit" | "delivered", Readonly<Record<MoveSource, string>>>> = {
  in_transit: {
    driver_photo: "The driver sent a photo of the bill of lading.",
    driver_text: "The driver texted that the load was picked up.",
    driver_voice: "The driver left a voice note that the load was picked up.",
    staff: "A person marked the load picked up.",
    demo_feed: "The sample dispatch board marked the load picked up.",
    seed: "Picked up, from the sample history.",
    tms: "The dispatch board marked the load picked up.",
  },
  delivered: {
    driver_photo: "The driver sent a photo of the proof of delivery.",
    driver_text: "The driver texted that the load was delivered.",
    driver_voice: "The driver left a voice note that the load was delivered.",
    staff: "A person marked the load delivered.",
    demo_feed: "The sample dispatch board marked the load delivered.",
    seed: "Delivered, from the sample history.",
    tms: "The dispatch board marked the load delivered.",
  },
};

// Why the desk drafted no advance at pickup (src/lib/advances/at-pickup.ts), in plain words.
const NO_ADVANCE_WORDS: Readonly<Record<string, string>> = {
  recorded: "advances at pickup are switched off",
  switched_off: "advances at pickup are switched off",
  before_start: "the load moved before advances at pickup started",
  not_found: "the move was not a pickup",
  not_pickup: "the move was not a pickup",
  not_in_transit: "the load was no longer on its way",
  no_driver: "no driver is on the load",
  driver_changed: "the driver changed after pickup",
  stage_delivered: "the load was already delivered",
  no_load_cap: "the pay rules set no advance per load",
  load_has_card: "the load already has an advance card",
  live_card: "the driver already has an advance waiting",
  daily_cap: "today's advance limit was reached",
  pickup_not_yet_due: "the pickup was not due yet",
  nothing_to_advance: "there was nothing left to advance",
  engine_refused: "the pay rules did not allow one",
  duplicate: "it was already drafted",
  already_decided: "it was already decided",
};

const AUDIT_WORDS: Readonly<Record<string, string>> = {
  pass: "Audit passed.",
  concerns: "Audit raised concerns.",
  block: "Audit blocked it.",
  unknown: "Audit could not finish.",
};

const PAYOUT_WORDS: Readonly<Record<string, string>> = {
  fuel_card_sim: "Fuel card load",
  stripe_test: "Bank transfer",
  mock: "Payout",
};

// Where a books record went, by the ledger row's outside system.
const BOOKS_WORDS: Readonly<Record<string, string>> = {
  qbo_sandbox: "QuickBooks sandbox",
};

// A payout the ledger could not read back: it is never shown as paid or as still sending.
const PAYOUT_UNCONFIRMED = "Payout not confirmed, a person is checking.";
const CANCELLED = "The load was cancelled.";

function cardWaiting(card: JourneyCard): string {
  if (card.auditVerdict === null) return "Waiting for the audit";
  if (card.autopilotMode === null) return "Waiting for the autopilot to look";
  return "Waiting for a person to approve";
}

function autopilotTag(card: JourneyCard): string | null {
  if (card.decidedBy === "autopilot") return "Autopilot approved it within your rules";
  if (card.autopilotMode === "ask") return "Autopilot: asks a person";
  if (card.autopilotMode === "off") return "Autopilot: off for this kind";
  return null;
}

function payoutTag(rows: readonly JourneyMoney[], kind: MoneyActionKind): string | null {
  const system = latestByKind(rows, kind)?.outsideSystem ?? null;
  return system !== null && Object.hasOwn(PAYOUT_WORDS, system) ? PAYOUT_WORDS[system] : null;
}

function docOf(move: JourneyMove): JourneyDocument | null {
  return move.source === "driver_photo" ? move.document : null;
}

// What the move's document says about this load: read and matched by code to this very load.
function matchedThisLoad(doc: JourneyDocument | null, loadId: string): boolean {
  return doc !== null && doc.match !== null && doc.match.found && doc.match.loadId === loadId;
}

function moveStep(facts: JourneyFacts, to: "in_transit" | "delivered"): Draft {
  const { load, moves } = facts;
  const move = moves.find((m) => m.toStatus === to) ?? null;
  const reached =
    to === "in_transit" ? load.status !== "planned" && load.status !== "cancelled" : load.status === "delivered" || load.status === "invoiced";
  if (move === null) {
    if (reached) {
      const at = to === "in_transit" ? load.pickedUpAt : load.deliveredAt;
      return done(at, to === "in_transit" ? "Picked up." : "Delivered.");
    }
    if (load.status === "cancelled") return skipped(CANCELLED);
    return pending(to === "in_transit" ? "Waiting for the driver's bill of lading" : "Waiting for the driver's proof of delivery");
  }
  const doc = docOf(move);
  const paper = to === "in_transit" ? "bill of lading" : "proof of delivery";
  const fact =
    doc !== null && doc.read !== null
      ? matchedThisLoad(doc, load.id)
        ? `Muse Spark read the ${paper}, and code matched it to load ${load.number}.`
        : `Muse Spark read the ${paper}.`
      : MOVE_WORDS[to][move.source];
  return done(move.at, fact, {
    actor: MOVE_ACTORS[move.source],
    document: doc,
    href: doc !== null ? `/documents/${doc.id}` : null,
    hrefLabel: doc !== null ? "Open the document" : null,
  });
}

function advanceDrafted(facts: JourneyFacts, pickup: Draft): Draft {
  const { card, advance } = facts;
  if (card !== null) {
    const audit = card.auditVerdict !== null && Object.hasOwn(AUDIT_WORDS, card.auditVerdict) ? ` ${AUDIT_WORDS[card.auditVerdict]}` : "";
    return done(card.createdAt, `Drafted an advance card for fuel at pickup.${audit}`, {
      actor: LEDGERLINE,
      figureCents: card.amountCents,
      tag: autopilotTag(card),
    });
  }
  if (advance !== null) {
    return done(advance.createdAt, "An advance was requested for this load.", { figureCents: advance.amountCents });
  }
  if (facts.load.status === "cancelled") return skipped(CANCELLED);
  if (pickup.state !== "done") return pending("Drafted after pickup");
  const move = facts.moves.find((m) => m.toStatus === "in_transit") ?? null;
  if (move === null || move.source === "seed") return skipped("No advance: the load was picked up before LedgerLine watched it.");
  if (move.desk === null) return pending("Waiting for LedgerLine");
  if (move.desk.kind === "failed") return stopped("LedgerLine could not draft the advance.", { at: move.desk.at, actor: LEDGERLINE });
  const category = move.desk.category;
  if (category === "advance_proposed") return pending("Waiting for LedgerLine");
  const why = category !== null && Object.hasOwn(NO_ADVANCE_WORDS, category) ? NO_ADVANCE_WORDS[category] : "none was drafted";
  return skipped(`No advance: ${why}.`, { at: move.desk.at, actor: LEDGERLINE });
}

function advancePaid(facts: JourneyFacts, drafted: Draft): Draft {
  const { card, advance, advanceMoney } = facts;
  if (drafted.state === "skipped" || drafted.state === "stopped") return skipped("No advance on this load.");
  const href = advance !== null ? `/records/advances/${advance.id}` : null;
  const link = { href, hrefLabel: href !== null ? "Open the advance" : null };
  const payout = latestByKind(advanceMoney, "advance_payout");
  if (advance !== null && advance.status === "paid") {
    return done(advance.paidAt ?? payout?.settledAt ?? null, card?.decidedBy ? `Approved by ${actorWord(card.decidedBy)}, paid to the driver.` : "Paid to the driver.", {
      ...link,
      actor: actorWord(card?.decidedBy ?? null),
      figureCents: payout?.amountCents ?? advance.amountCents,
      tag: payoutTag(advanceMoney, "advance_payout"),
    });
  }
  if (advance !== null && advance.status === "parked") return stopped("Parked: it needs a person before it pays.", link);
  if (advance !== null && (advance.status === "rejected" || advance.status === "cancelled")) {
    return stopped(advance.status === "rejected" ? "The advance was rejected." : "The advance was cancelled.", link);
  }
  if (payout !== null && payout.state === "failed") return stopped("The payout did not go through.", { ...link, at: payout.settledAt });
  if (payout !== null && payout.state === "unknown") return stopped(PAYOUT_UNCONFIRMED, link);
  if (payout !== null && payout.state !== "confirmed") return pending("Waiting for the payout to confirm", link);
  if (card === null) return pending(advance !== null ? "Waiting for a person to approve" : "Paid after a person approves", link);
  switch (card.status) {
    case "proposed":
      return pending(cardWaiting(card), link);
    case "approved":
    case "executing":
      return pending("Approved, sending the payout", { ...link, actor: actorWord(card.decidedBy) });
    case "rejected":
      return stopped(`Rejected by ${actorWord(card.decidedBy) ?? "a person"}.`, { ...link, at: card.decidedAt });
    case "expired":
      return stopped("The card expired before anyone approved it.", link);
    case "failed":
      return stopped("The payout did not go through.", { ...link, at: card.decidedAt });
    case "done":
      return pending("Waiting for the payout to confirm", link);
  }
}

// A books step from its ledger rows: in QuickBooks with the record's tail, posting, or a person.
// Done only when every kind's latest row is confirmed and names its QuickBooks record; a post that
// could not be read back waits on a person, never on the page.
function booksStep(
  rows: readonly JourneyMoney[],
  kinds: readonly MoneyActionKind[],
  paidAt: string | null,
  opts: JourneyOptions,
): Draft {
  const on = opts.books.enabled && atOrAfterBooksStart(paidAt, opts.zone, opts.books.startDate);
  const latest = kinds.map((k) => latestByKind(rows, k));
  const unread = latest.find((a) => a !== null && a.state === "unknown");
  if (unread) return stopped(`Needs a person: ${needsPersonReason(unread, opts.books.maxAttempts)}.`);
  const tails = latest
    .map((a) => a?.outsideId ?? null)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => id.slice(-4));
  const line = booksStatus(rows, kinds, { on, maxAttempts: opts.books.maxAttempts, tail: tails[0] ?? null });
  switch (line.state) {
    case "in_books": {
      if (tails.length !== kinds.length) return stopped("Needs a person: QuickBooks sent back no record number.");
      const at = latest
        .map((a) => a?.settledAt ?? null)
        .reduce<string | null>((top, t) => (t !== null && (top === null || t > top) ? t : top), null);
      const refs = tails.length > 1 ? `In QuickBooks, records ending ${tails.join(" and ")}` : line.text;
      const system = latest[0]?.outsideSystem ?? null;
      const tag = system !== null && Object.hasOwn(BOOKS_WORDS, system) ? BOOKS_WORDS[system] : null;
      return done(at, `${refs}.`, { actor: LEDGERLINE, tag });
    }
    case "posting":
      return pending(line.text);
    case "needs_person":
      return stopped(`${line.text}.`);
    case "not_yet":
      return skipped(`${line.text}.`);
  }
}

function advanceBooks(facts: JourneyFacts, paid: Draft, opts: JourneyOptions): Draft {
  if (paid.state === "skipped" || paid.state === "stopped") return skipped("No advance to record.");
  if (paid.state !== "done") return pending("Recorded after the advance pays");
  return booksStep(facts.advanceMoney, ["advance_expense"], facts.advance?.paidAt ?? null, opts);
}

const isLoadLine = (l: JourneyLine, loadId: string) => l.sources.some((s) => s.table === "loads" && s.id === loadId);

function lineNote(l: JourneyLine): string | null {
  if (l.kind !== "insurance" || l.meta === null) return null;
  const days = l.meta.days;
  const rate = l.meta.perDayCents;
  if (!Number.isSafeInteger(days) || !Number.isSafeInteger(rate)) return null;
  return `${days as number} ${days === 1 ? "day" : "days"} at ${formatCents(rate as number)} a day`;
}

function summaryOf(s: JourneySettlement, loadId: string): PaystubSummary {
  return {
    id: s.id,
    href: `/records/settlements/${s.id}`,
    period: formatPeriod(s.periodStart, s.periodEnd),
    lines: s.lines.map((l) => ({
      seq: l.seq,
      kind: l.kind,
      label: l.label,
      amountCents: l.amountCents,
      note: lineNote(l),
      thisLoad: isLoadLine(l, loadId),
    })),
    grossCents: s.grossCents,
    deductionsCents: s.deductionsCents,
    netCents: s.netCents,
  };
}

// The paystub that carries this load: a stored line cites the load itself.
function stubOf(facts: JourneyFacts): JourneySettlement | null {
  const s = facts.settlement;
  return s !== null && s.lines.some((l) => isLoadLine(l, facts.load.id)) ? s : null;
}

function paystubDrafted(facts: JourneyFacts, pod: Draft): Draft {
  const s = stubOf(facts);
  if (s !== null) {
    const summary = summaryOf(s, facts.load.id);
    return done(s.createdAt, `Drafted the paystub for ${summary.period}.`, {
      actor: LEDGERLINE,
      figureCents: s.netCents,
      paystub: summary,
      href: summary.href,
      hrefLabel: "Open the paystub",
    });
  }
  if (facts.load.status === "cancelled") return skipped(CANCELLED);
  if (pod.state !== "done") return pending("Drafted after delivery");
  return pending("Waiting for the week's pay run");
}

const PAID_BEFORE = "Paid before LedgerLine, from the sample history.";

function paystubPaid(facts: JourneyFacts, drafted: Draft): Draft {
  const s = stubOf(facts);
  if (s === null) return drafted.state === "skipped" ? skipped("No paystub for this load.") : pending("Paid after a person approves");
  const link = { href: `/records/settlements/${s.id}`, hrefLabel: "Open the paystub" };
  const card = s.card;
  if (s.status === "paid") {
    if (card === null && s.legs.length === 0) return done(s.paidAt, PAID_BEFORE, link);
    const by = actorWord(card?.decidedBy ?? null);
    return done(s.paidAt, by !== null ? `Approved by ${by}, paid to the driver.` : "Paid to the driver.", {
      ...link,
      actor: by,
      figureCents: latestByKind(s.legs, "settlement_payout")?.amountCents ?? s.netCents,
      tag: payoutTag(s.legs, "settlement_payout"),
    });
  }
  if (s.parkedReason !== null) return stopped(`Parked: ${parkLabel(s.parkedReason)}.`, link);
  const payout = latestByKind(s.legs, "settlement_payout");
  if (payout !== null && payout.state === "failed") return stopped("The payout did not go through.", link);
  if (payout !== null && payout.state === "unknown") return stopped(PAYOUT_UNCONFIRMED, link);
  if (s.status === "approved") return pending("Approved, sending the pay", { ...link, actor: actorWord(card?.decidedBy ?? null) });
  if (card === null) return pending("Waiting for a person to approve", link);
  switch (card.status) {
    case "rejected":
      return stopped(`Rejected by ${actorWord(card.decidedBy) ?? "a person"}.`, { ...link, at: card.decidedAt });
    case "expired":
      return stopped("The card expired before anyone approved it.", link);
    case "failed":
      return stopped("The payout did not go through.", link);
    case "proposed":
      return pending(cardWaiting(card), link);
    default:
      return pending("Approved, sending the pay", { ...link, actor: actorWord(card.decidedBy) });
  }
}

function paystubBooks(facts: JourneyFacts, paid: Draft, opts: JourneyOptions): Draft {
  const s = stubOf(facts);
  if (paid.state === "skipped" || paid.state === "stopped" || s === null) {
    return paid.state === "pending" ? pending("Recorded after the paystub pays") : skipped("No paystub to record.");
  }
  if (paid.state !== "done") return pending("Recorded after the paystub pays");
  if (s.card === null && s.legs.length === 0) return skipped("Paid before LedgerLine: nothing to record.");
  if (s.netCents === 0) return skipped("Nothing paid, so nothing to record.");
  return booksStep(s.legs, ["settlement_bill", "settlement_bill_payment"], s.paidAt, opts);
}

function timeOf(at: string | null, zone: string): string | null {
  return at !== null && isRealInstant(at) ? formatInstant(at, zone) : null;
}

// The eight steps in their fixed order. The first step still to come is "now"; any later step
// still to come is "waiting". A cancelled load has none still to come.
export function journeyStepsOf(facts: JourneyFacts, opts: JourneyOptions): JourneyStep[] {
  const bol = moveStep(facts, "in_transit");
  const drafted = advanceDrafted(facts, bol);
  const paid = advancePaid(facts, drafted);
  const advanceBook = advanceBooks(facts, paid, opts);
  const pod = moveStep(facts, "delivered");
  const stub = paystubDrafted(facts, pod);
  const stubPaid = paystubPaid(facts, stub);
  const stubBook = paystubBooks(facts, stubPaid, opts);
  // A cancelled load goes no further: every step still to come ends, so nothing waits on it.
  const cancelled = facts.load.status === "cancelled";
  const drafts = [bol, drafted, paid, advanceBook, pod, stub, stubPaid, stubBook].map((d) =>
    cancelled && d.state === "pending" ? stopped(CANCELLED) : d,
  );
  let first = true;
  return drafts.map((d, i) => {
    const key = STEP_KEYS[i];
    let state: StepState;
    if (d.state === "pending") {
      state = first ? "now" : "waiting";
      first = false;
    } else state = d.state;
    return { ...d, key, title: STEP_TITLES[key], state, time: timeOf(d.at, opts.zone) };
  });
}

// Whether any step is still to come, so the page keeps reading itself.
export function stillMoving(steps: readonly JourneyStep[]): boolean {
  return steps.some((s) => s.state === "now" || s.state === "waiting");
}

// The step the road stands at: the first one neither done nor skipped, or null when all are.
export function currentStep(steps: readonly JourneyStep[]): JourneyStep | null {
  return steps.find((s) => s.state !== "done" && s.state !== "skipped") ?? null;
}

export type BoardRow = {
  loadId: string;
  number: string;
  driver: string | null;
  truck: string | null;
  route: string;
  // "Due Nov 4, 2026, 3:00 PM CST", "Late: due ...", "Delivered ...", or null with no window on file.
  due: string | null;
  late: boolean;
  dueAt: string | null;
  // Where the load is, from what happened, never a map position: the last stop done and when.
  where: string;
  steps: StepState[];
  stepTitle: string;
  stepState: StepState | "finished";
  href: string;
};

function dueOf(facts: JourneyFacts, zone: string): string | null {
  const local = facts.dispatch.dueLocal;
  if (local === null || !isLocalClock(local)) return null;
  try {
    return instantOfLocal(local, zone);
  } catch {
    return null;
  }
}

// One row of the On the road board from a load's facts and its built steps. now: the instant the
// page was read, so a load past its window reads late.
export function boardRowOf(facts: JourneyFacts, steps: readonly JourneyStep[], opts: { zone: string; now: number }): BoardRow {
  const { load } = facts;
  const dueAt = dueOf(facts, opts.zone);
  const delivered = load.status === "delivered" || load.status === "invoiced";
  const late = !delivered && dueAt !== null && Date.parse(dueAt) < opts.now;
  const pod = steps.find((s) => s.key === "pod") ?? null;
  const bol = steps.find((s) => s.key === "bol") ?? null;
  let due: string | null = null;
  if (delivered) due = pod?.time ? `Delivered ${pod.time}` : "Delivered";
  else if (dueAt !== null) due = `${late ? "Late: due" : "Due"} ${formatInstant(dueAt, opts.zone)}`;
  let where: string;
  if (delivered) where = pod?.time ? `Delivered in ${load.destination} at ${pod.time}` : `Delivered in ${load.destination}`;
  else if (load.status === "in_transit") where = bol?.time ? `Picked up in ${load.origin} at ${bol.time}` : `Picked up in ${load.origin}`;
  else where = `Waiting for pickup in ${load.origin}`;
  const current = currentStep(steps);
  return {
    loadId: load.id,
    number: load.number,
    driver: load.driverName,
    truck: facts.dispatch.truck,
    route: `${load.origin} to ${load.destination}`,
    due,
    late,
    dueAt,
    where,
    steps: steps.map((s) => s.state),
    stepTitle: current === null ? "Paid and recorded" : current.title,
    stepState: current === null ? "finished" : current.state,
    href: `/records/loads/${load.id}/journey`,
  };
}

// Soonest delivery first; a load with no window on file after those with one, then by number.
export function sortBoard(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => {
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      const d = Date.parse(a.dueAt) - Date.parse(b.dueAt);
      if (d !== 0) return d;
    }
    return a.number < b.number ? -1 : a.number > b.number ? 1 : 0;
  });
}

// Whether a load still belongs on the board: not cancelled, and not yet paid and recorded.
export function onTheRoad(facts: JourneyFacts, steps: readonly JourneyStep[]): boolean {
  if (facts.load.status === "cancelled") return false;
  if (facts.load.status === "planned" && facts.load.driverId === null) return false;
  const paid = steps.find((s) => s.key === "paystub_paid");
  const booked = steps.find((s) => s.key === "paystub_books");
  return !(paid?.state === "done" && (booked?.state === "done" || booked?.state === "skipped"));
}

// The newest done steps across the board's loads, as feed lines, newest first.
export function journeyEvents(
  journeys: readonly { facts: JourneyFacts; steps: readonly JourneyStep[] }[],
  zone: string,
  max = 20,
): FeedLine[] {
  const lines: FeedLine[] = [];
  for (const { facts, steps } of journeys) {
    for (const s of steps) {
      if (s.state !== "done" || s.at === null || s.time === null) continue;
      const figure = s.figureCents !== null ? `, ${formatCents(s.figureCents)}` : "";
      lines.push({
        key: `${facts.load.id}:${s.key}`,
        at: s.at,
        time: s.time,
        actor: s.actor ?? "",
        words: `Load ${facts.load.number}: ${s.title}${figure}`,
        tag: s.tag,
        href: `/records/loads/${facts.load.id}/journey`,
      });
    }
  }
  return lines.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.key < b.key ? 1 : a.key > b.key ? -1 : 0)).slice(0, max);
}
