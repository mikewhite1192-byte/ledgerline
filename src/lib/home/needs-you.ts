import { LIST_LIMIT as ADVANCE_LIST_LIMIT, readAdvanceList, type AdvanceListRow } from "@/lib/advances/read";
import { readEngineProposalViews } from "@/lib/agent/gateway/store";
import type { ProposalView, TurnView } from "@/lib/agent/view";
import type { Queryable } from "@/lib/db";
import { readInvoiceList, type InvoiceListRow } from "@/lib/invoices/views";
import { readSettlementsView, type SettlementListRow } from "@/lib/settlements/views";
import type { LocalDate } from "@/lib/time/local-date";
import { cardAnchor } from "./card-anchor";

// "Needs you" at the top of Home: what is waiting on a person, with how many, how much, and one
// link each. Read on the server through the same reads the Settlements, Advances and Invoices
// pages use, inside the request's carrier; nothing here writes. Amounts are integer cents. The
// strip itself (src/components/app/needs-you.tsx) only renders what this returns.

export type NeedsYouAmount = { cents: number; label: string };
export type NeedsYouRow = {
  key: "cards" | "paystubs" | "advances" | "invoice_cards" | "past_due";
  count: number;
  // The count was cut off at the read's limit, so there may be more.
  atLeast: boolean;
  what: string;
  amounts: NeedsYouAmount[];
  href: string;
  linkLabel: string;
};
export type NeedsYouView = { rows: NeedsYouRow[]; unread: boolean };

// How many cards the invoice read returns at most (its own default, passed so the cutoff is known).
const ENGINE_LIMIT = 200;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// Cards waiting for approval in this person's chat (the turns Home already read back). Each card
// once; the link lands on the newest.
export function cardsRow(turns: readonly TurnView[]): NeedsYouRow | null {
  const seen = new Map<string, ProposalView>();
  // Turns come oldest first; a card seen again moves to where it was seen last.
  for (const t of turns) {
    for (const p of t.proposals) {
      seen.delete(p.id);
      if (p.status === "proposed") seen.set(p.id, p);
    }
  }
  const cards = [...seen.values()];
  if (cards.length === 0) return null;
  const out = cards.filter((p) => p.direction === "out").reduce((s, p) => s + Math.abs(p.amountCents), 0);
  const into = cards.filter((p) => p.direction === "in").reduce((s, p) => s + Math.abs(p.amountCents), 0);
  const amounts: NeedsYouAmount[] = [];
  if (out > 0) amounts.push({ cents: out, label: "to pay out" });
  if (into > 0) amounts.push({ cents: into, label: "coming in" });
  return {
    key: "cards",
    count: cards.length,
    atLeast: false,
    what: `${plural(cards.length, "card", "cards")} in your chat waiting for approval`,
    amounts,
    href: `#${cardAnchor(cards[cards.length - 1].id)}`,
    linkLabel: "Go to the newest card",
  };
}

// This pay week's paystubs whose card waits for approval.
export function paystubsRow(rows: readonly SettlementListRow[]): NeedsYouRow | null {
  const waiting = rows.filter((r) => r.proposalStatus === "proposed");
  if (waiting.length === 0) return null;
  const net = waiting.reduce((s, r) => s + r.netCents, 0);
  return {
    key: "paystubs",
    count: waiting.length,
    atLeast: false,
    what: `${plural(waiting.length, "paystub", "paystubs")} waiting for approval`,
    amounts: [{ cents: net, label: "to pay drivers" }],
    href: "/settlements",
    linkLabel: "Open settlements",
  };
}

// Advance requests no one has decided yet (the Advances page's "requested" filter).
export function advancesRow(rows: readonly AdvanceListRow[]): NeedsYouRow | null {
  const requested = rows.filter((r) => r.status === "requested");
  if (requested.length === 0) return null;
  return {
    key: "advances",
    count: requested.length,
    atLeast: rows.length >= ADVANCE_LIST_LIMIT,
    what: `advance ${plural(requested.length, "request", "requests")} waiting for a decision`,
    amounts: [{ cents: requested.reduce((s, r) => s + r.amountCents, 0), label: "requested" }],
    href: "/advances?status=requested",
    linkLabel: "Open requested advances",
  };
}

// Invoices the pay rules priced, waiting for approval before they are recorded.
export function invoiceCardsRow(cards: readonly ProposalView[], limit = ENGINE_LIMIT): NeedsYouRow | null {
  const waiting = cards.filter((p) => p.status === "proposed");
  if (waiting.length === 0) return null;
  return {
    key: "invoice_cards",
    count: waiting.length,
    atLeast: cards.length >= limit,
    what: `${plural(waiting.length, "invoice", "invoices")} waiting for approval`,
    amounts: [{ cents: waiting.reduce((s, p) => s + Math.abs(p.amountCents), 0), label: "to bill" }],
    href: "/invoices?tab=to-invoice",
    linkLabel: "Open invoices to approve",
  };
}

// Invoices with money still owed after their due date, as of the carrier's today.
export function pastDueRow(rows: readonly InvoiceListRow[]): NeedsYouRow | null {
  const late = rows.filter((r) => r.bucket !== null && r.bucket !== "current" && r.balanceCents > 0);
  if (late.length === 0) return null;
  return {
    key: "past_due",
    count: late.length,
    atLeast: false,
    what: `${plural(late.length, "invoice", "invoices")} past due`,
    amounts: [{ cents: late.reduce((s, r) => s + r.balanceCents, 0), label: "still owed" }],
    href: "/invoices?tab=invoices",
    linkLabel: "Open the invoice list",
  };
}

// The strip's reads, each only while its page is switched on. Runs inside the caller's carrier
// transaction; a failed read throws to the caller, which shows the strip as not read.
export async function readNeedsYou(
  q: Queryable,
  // today is the carrier's own date in its named timezone (carrierToday), for the aging buckets.
  opts: { today: LocalDate; settlements: boolean; advances: boolean; invoices: boolean },
): Promise<NeedsYouRow[]> {
  const rows: (NeedsYouRow | null)[] = [];
  if (opts.settlements) rows.push(paystubsRow((await readSettlementsView(q, null)).rows));
  if (opts.advances) rows.push(advancesRow(await readAdvanceList(q, "requested")));
  if (opts.invoices) {
    rows.push(invoiceCardsRow(await readEngineProposalViews(q, "invoice_post", ENGINE_LIMIT)));
    rows.push(pastDueRow(await readInvoiceList(q, opts.today)));
  }
  return rows.filter((r): r is NeedsYouRow => r !== null);
}

