import { dollars } from "../money/format";

// The words of the agent's questions and told lines (design-event-lanes 3). Code writes every
// sentence: the amount is the proposal's own cents, formatted by money/format.ts, and every name
// comes from the records. The model never writes these. Pure.

// The proposal kinds the desk asks about.
export const ASKED_KINDS = [
  "advance_payout",
  "invoice_post",
  "detention_charge",
  "settlement_approve",
  "pay_correction",
  "load_move",
  "card_load_ruling",
  "card_pullback",
] as const;

export type AskedKind = (typeof ASKED_KINDS)[number];

export const isAskedKind = (kind: string): kind is AskedKind => (ASKED_KINDS as readonly string[]).includes(kind);

export const ASK_TEXT_MAX = 400;
const NAME_MAX = 60;

// What a sentence may say, read from the proposal and its records. A missing name is null, and a
// template that needs it gives way to the generic line.
export type AskFacts = {
  kind: string;
  amountCents: number;
  driverName: string | null;
  loadNumber: string | null;
  customerName: string | null;
  // The advance's share of the trip pay, a whole percent, when the proposal names one.
  percent: number | null;
  // The stage a load move takes the load to (a word such as picked_up), when it names one.
  stage: string | null;
  // For an advance drafted at pickup when the dispatch feed moved the load: the pickup's wall time
  // in the carrier's zone ("9:20 AM"), read from the move itself.
  dispatchPickup?: string | null;
  // For a card pull-back: the card's last four, the reason in words, and the engine's numbers from
  // the card's args. onAdvance says what the card cannot give back stays owed on the advance (A6)
  // rather than booked as owed by itself (A7).
  pull?: { last4: string; reason: string; pullCents: number; shortfallCents: number; onAdvance: boolean } | null;
};

// For a told line: the owner's own Auto limit for one item, in cents, when the decision read one.
export type ToldFacts = AskFacts & { limitCents: number | null };

const KIND_WORDS: Readonly<Record<string, string>> = {
  advance_payout: "an advance",
  pay_correction: "a pay fix",
  invoice_fix: "an invoice fix",
  load_rate_fill: "a missing rate",
  invoice_post: "an invoice",
  payment_reapply: "a payment move",
  detention_charge: "a detention charge",
  settlement_approve: "a weekly settlement",
  card_match: "a card match",
  factoring_request: "a factoring request",
  bill_defer: "a bill delay",
  collections_chase: "a payment reminder",
  pay_rule_change: "a pay rule change",
  money_code: "a money code",
  pay_policy_setup: "pay rules",
  load_create: "a new load",
  escrow_release: "an escrow release",
  load_move: "a load update",
  card_load_ruling: "a card load ruling",
  card_pullback: "a card pull-back",
};

const WORD = /^[a-z][a-z_]{1,39}$/;

// "an invoice", or the kind's own words for a kind added later ("a new kind").
export function kindInWords(kind: string): string {
  const known = KIND_WORDS[kind];
  if (known) return known;
  return WORD.test(kind) ? `a ${kind.replace(/_/g, " ")}` : "a change";
}

// A record's name as one short line: no control characters, spaces collapsed, at most 60 characters.
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX - 1).trimEnd()}.` : flat;
}

const money = (cents: number): string => dollars(Number.isSafeInteger(cents) ? Math.abs(cents) : 0);

const percentOf = (p: number | null): number | null =>
  p !== null && Number.isInteger(p) && p > 0 && p <= 100 ? p : null;

const CLOCK = /^(1[0-2]|[1-9]):[0-5]\d (AM|PM)$/;
const clockOr = (v: string | null | undefined): string | null => (typeof v === "string" && CLOCK.test(v) ? v : null);

const stageWords = (stage: string | null): string | null =>
  stage !== null && WORD.test(stage) ? stage.replace(/_/g, " ") : null;

function subjectOf(f: AskFacts): string {
  if (f.driverName) return f.driverName;
  if (f.loadNumber) return `load ${f.loadNumber}`;
  if (f.customerName) return f.customerName;
  return "this record";
}

// "I drafted an invoice for load BR-1042, $1,250.00. Approve?"
export function genericAsk(f: AskFacts): string {
  return fit(`I drafted ${kindInWords(f.kind)} for ${subjectOf(f)}, ${money(f.amountCents)}. Approve?`);
}

// The question for one proposal.
export function askWords(f: AskFacts): string {
  const amount = money(f.amountCents);
  const percent = percentOf(f.percent);
  switch (f.kind) {
    case "advance_payout": {
      const pickup = clockOr(f.dispatchPickup);
      if (pickup && f.driverName && f.loadNumber) {
        return fit(
          `Dispatch shows load ${f.loadNumber} picked up at ${pickup}. Should I send ${f.driverName} the advance at pickup, ${amount}?`,
        );
      }
      if (f.driverName && f.loadNumber && percent !== null) {
        return fit(
          `All paperwork is in for load ${f.loadNumber}. Should I send ${f.driverName} the ${percent}% advance, ${amount}?`,
        );
      }
      if (f.driverName) return fit(`Should I send ${f.driverName} an advance of ${amount}?`);
      break;
    }
    case "invoice_post":
      if (f.loadNumber && f.customerName) {
        return fit(`Load ${f.loadNumber} is ready to bill. Should I post the ${amount} invoice to ${f.customerName}?`);
      }
      if (f.loadNumber) return fit(`Load ${f.loadNumber} is ready to bill. Should I post its ${amount} invoice?`);
      break;
    case "detention_charge":
      if (f.loadNumber && f.customerName) {
        return fit(`Load ${f.loadNumber} waited past its free time. Should I bill ${f.customerName} ${amount} for detention?`);
      }
      if (f.loadNumber) return fit(`Load ${f.loadNumber} waited past its free time. Should I bill ${amount} for detention?`);
      break;
    case "settlement_approve":
      if (f.driverName) return fit(`${f.driverName}'s pay for the week comes to ${amount}. Should I approve it?`);
      break;
    case "pay_correction":
      if (f.driverName) return fit(`I found a ${amount} pay fix for ${f.driverName}. Should I apply it?`);
      break;
    case "load_move": {
      const stage = stageWords(f.stage);
      if (f.loadNumber && stage) return fit(`Should I mark load ${f.loadNumber} ${stage}?`);
      if (f.loadNumber) return fit(`Should I update load ${f.loadNumber}?`);
      break;
    }
    case "card_pullback": {
      const pull = f.pull;
      if (f.driverName && pull) {
        const head = `Pull ${amount} back off ${f.driverName}'s fuel card ending ${pull.last4} (${pull.reason}).`;
        const left = f.amountCents - pull.pullCents;
        const rest =
          left <= 0
            ? ""
            : pull.onAdvance
              ? ` ${money(left)} of it is more than the card holds and stays owed on the advance.`
              : ` ${money(pull.shortfallCents)} of it is more than the card holds and would be booked as owed.`;
        return fit(`${head}${rest} Yes pulls it in test mode.`);
      }
      break;
    }
    case "card_load_ruling":
      if (f.driverName) {
        return fit(
          `${f.driverName}'s fuel card got a ${amount} load I have no record of. Yes books it as money ${f.driverName} owes; open the card to rule otherwise.`,
        );
      }
      break;
  }
  return genericAsk(f);
}

// The told line after the autopilot did one inside the owner's limits.
export function toldWords(f: ToldFacts): string {
  const amount = money(f.amountCents);
  const percent = percentOf(f.percent);
  const limit =
    f.limitCents !== null && Number.isSafeInteger(f.limitCents) && f.limitCents >= 0
      ? `, inside your ${money(f.limitCents)} limit`
      : "";
  switch (f.kind) {
    case "advance_payout":
      if (f.driverName && percent !== null) return fit(`Sent ${f.driverName} the ${percent}% advance, ${amount}${limit}.`);
      if (f.driverName) return fit(`Sent ${f.driverName} an advance of ${amount}${limit}.`);
      break;
    case "invoice_post":
      if (f.loadNumber) return fit(`Posted the ${amount} invoice for load ${f.loadNumber} to QuickBooks sandbox${limit}.`);
      return fit(`Posted a ${amount} invoice to QuickBooks sandbox${limit}.`);
  }
  return fit(`Done: ${kindInWords(f.kind)} for ${subjectOf(f)}, ${amount}${limit}.`);
}

// Never over the table's 400 characters (names are already at most 60 each, so this never cuts a
// real sentence).
function fit(text: string): string {
  return text.length <= ASK_TEXT_MAX ? text : `${text.slice(0, ASK_TEXT_MAX - 1).trimEnd()}.`;
}
