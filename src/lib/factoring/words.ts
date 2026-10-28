import { formatLocalDate } from "../format/dates";
import { codeToWords } from "../format/labels";
import { FACTORING_REFUSALS } from "../rules-engine/factoring";
import { localDateOf } from "../time/local-date";
import { packetGaps, type FactoringPacket } from "./packet";

// Fixed words for factoring (design 4.7). Categories reach the page and the card; these turn them
// into plain sentences. Every key is factoring's own (none of the shared approval words, such as
// stale or not_found, is reused with a different meaning), so the Cash page and the chat can
// spread these into their own notice maps.

// Why an approval or a check did not submit, and what happened to the invoices.
export const FACTORING_APPROVE_NOTICE: Readonly<Record<string, string>> = {
  factoring_off: "Factoring is switched off right now. Nothing was sent.",
  factoring_payouts_off: "Payouts are switched off right now, so nothing was sent to the factoring partner.",
  factoring_not_armed: "Factoring is not turned on for sending yet. Nothing was sent.",
  over_factoring_cap: "This is more than one factoring request may bring in. Nothing was sent.",
  factoring_before_start: "Factoring has not started yet. Nothing was sent.",
  packet_incomplete:
    "An invoice is missing its rate confirmation, bill of lading or proof of delivery. Nothing was sent.",
  invoices_changed:
    "An invoice or the factoring rates changed after this card was made. Nothing was sent. Make a fresh card.",
  factoring_declined: "The factoring partner declined every invoice. No money came in. Test mode.",
  factoring_failed: "The invoices did not go through to the factoring partner. No money came in. Test mode.",
  factoring_pending:
    "Sent, not confirmed yet. Open Factoring and press Check pending; nothing will be sent twice.",
  factoring_unavailable: "The factoring partner could not be reached. Nothing was sent. Try again later.",
  factoring_check_unavailable: "The invoices could not be checked just now. Nothing was sent. Try again.",
};

// The engine's reasons an invoice cannot be factored, as the agent and the page say them.
export const FACTORING_REFUSAL_SENTENCES: Readonly<Record<(typeof FACTORING_REFUSALS)[number], string>> = {
  no_invoices: "Name at least one invoice to factor.",
  too_many_invoices: "One request can factor at most three invoices.",
  duplicate_invoice: "The same invoice is named twice.",
  rates_missing: "The carrier has no factoring rates on file.",
  invoice_not_found: "That invoice is not here.",
  invoice_not_from_load: "Only an invoice for a load can be factored.",
  invoice_not_open: "That invoice is paid or void, so it cannot be factored.",
  invoice_already_factored: "That invoice is already with the factoring partner.",
  invoice_no_balance: "Nothing is owed on that invoice.",
  invoice_too_old: "That invoice is too old to factor.",
  no_net: "After the fee, that invoice would bring in nothing.",
};

// What a Check pending press says.
export const CHECK_NOTICE: Readonly<Record<string, string>> = {
  factoring_off: FACTORING_APPROVE_NOTICE.factoring_off,
  not_found: "That factoring request is not here.",
  forbidden: "This login is not linked to a carrier. Sign in with the login your carrier set up.",
  unauthenticated: "Your sign-in ended. Sign in again, then check again.",
  unavailable: "The factoring partner could not be checked just now. Nothing was sent. Try again.",
};

// What a Check pending press found, in one sentence: anything confirmed or declined first, then
// a send too new to read back, then still waiting. Counts come from the check's own summary.
export const CHECK_RESULT = {
  confirmed: "Confirmed by the factoring partner. Test mode.",
  declined: "The factoring partner did not take an invoice. See the invoices below.",
  tooNew: "Sent less than a minute ago. Check again in a minute.",
  waiting: "The factoring partner has not confirmed it yet. Check again in a few minutes.",
  nothing: "Nothing here is waiting on the factoring partner.",
  lost: "The check's answer did not come back. The page below shows what is on file.",
} as const;

export function checkResultSentence(r: { confirmed: number; failed: number; tooNew: number; stillWaiting: number; stillUnknown: number }): string {
  if (r.confirmed > 0) return CHECK_RESULT.confirmed;
  if (r.failed > 0) return CHECK_RESULT.declined;
  if (r.tooNew > 0) return CHECK_RESULT.tooNew;
  if (r.stillWaiting > 0 || r.stillUnknown > 0) return CHECK_RESULT.waiting;
  return CHECK_RESULT.nothing;
}

export function factoringSentence(category: string): string {
  if (Object.hasOwn(FACTORING_APPROVE_NOTICE, category)) return FACTORING_APPROVE_NOTICE[category];
  if (Object.hasOwn(FACTORING_REFUSAL_SENTENCES, category)) {
    return FACTORING_REFUSAL_SENTENCES[category as keyof typeof FACTORING_REFUSAL_SENTENCES];
  }
  if (Object.hasOwn(CHECK_NOTICE, category)) return CHECK_NOTICE[category];
  return `${codeToWords(category)}.`;
}

// A request's or an invoice line's status, as the pages say it.
export const REQUEST_STATUS_WORDS: Readonly<Record<string, string>> = {
  submitted: "Sent, not confirmed yet",
  unknown: "Sent, not confirmed yet",
  funded: "Funded",
  partly_funded: "Partly funded",
  declined: "Declined",
  failed: "Did not go through",
};

export function requestStatusWords(status: string): string {
  return Object.hasOwn(REQUEST_STATUS_WORDS, status) ? REQUEST_STATUS_WORDS[status] : codeToWords(status);
}

const PAPER_WORDS = {
  rate_confirmation: "rate confirmation",
  bill_of_lading: "bill of lading",
  pod: "POD",
} as const;

// One invoice's papers in one line: "Invoice, rate confirmation on file; bill of lading, POD
// missing". The invoice itself is always on file.
export function packetLine(p: FactoringPacket): string {
  const gaps = new Set(packetGaps(p));
  const order = ["rate_confirmation", "bill_of_lading", "pod"] as const;
  const onFile = ["Invoice", ...order.filter((k) => !gaps.has(k)).map((k) => PAPER_WORDS[k])];
  const missing = order.filter((k) => gaps.has(k)).map((k) => PAPER_WORDS[k]);
  const have = `${onFile.join(", ")} on file`;
  return missing.length === 0 ? have : `${have}; ${missing.join(", ")} missing`;
}

// The money summary a factoring card and the request page share.
export function receiveLine(netCents: string, reserveCents: string, feeCents: string): string {
  return `You receive ${netCents} now, ${reserveCents} held back until the customer pays, fee ${feeCents}.`;
}

// The Test mode convention, said on the page so a person can see each outcome on purpose.
export const TEST_MODE_HELP =
  "Test mode: no real money moves. An invoice whose balance ends in 99 cents is declined, and one ending in 98 cents is slow to confirm (press Check pending to read it back); every other invoice is funded.";

// The day a stored instant falls on in the carrier's zone, in words ("Oct 28, 2026"). An instant
// that cannot be read shows as "Unknown day", never as its stored text.
export function dayOf(iso: string, zone: string): string {
  try {
    return formatLocalDate(localDateOf(iso, zone));
  } catch {
    return "Unknown day";
  }
}
