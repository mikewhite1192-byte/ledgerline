import { LIST_LIMIT as ADVANCE_LIST_LIMIT, readAdvanceList, type AdvanceListRow } from "@/lib/advances/read";
import { readEngineProposalViews } from "@/lib/agent/gateway/store";
import type { ProposalView, TurnView } from "@/lib/agent/view";
import type { Queryable } from "@/lib/db";
import { readInvoiceList, type InvoiceListRow } from "@/lib/invoices/views";
import { readSettlementsView, type SettlementListRow } from "@/lib/settlements/views";
import { needsPerson } from "@/lib/books/status";
import { MAX_CHECKS, type MoneyActionKind } from "@/lib/money/types";
import type { LocalDate } from "@/lib/time/local-date";
import { cardAnchor } from "./card-anchor";

// "Needs you" at the top of Home: what is waiting on a person, with how many, how much, and one
// link each. Read on the server through the same reads the Settlements, Advances and Invoices
// pages use, inside the request's carrier; nothing here writes. Amounts are integer cents. The
// strip itself (src/components/app/needs-you.tsx) only renders what this returns.

export type NeedsYouAmount = { cents: number; label: string };
export type NeedsYouRow = {
  key: "cards" | "escalated" | "paystubs" | "advances" | "invoice_cards" | "past_due" | "books";
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

// Requests in this person's chat the agent could not make a card for that passed the checks, so
// they went to a person (design-agents-102 3.2, D2). The count is the last 7 days; the link opens
// the agent card (#ask) on the page it is on, since nothing in the thread marks a turn to land on.
// No amount: no card exists for an escalated request.
export function escalatedRow(count: number): NeedsYouRow | null {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  return {
    key: "escalated",
    count,
    atLeast: false,
    what: `${plural(count, "request", "requests")} in your chat escalated to a person`,
    amounts: [],
    href: "#ask",
    linkLabel: "Open your chat",
  };
}

// How far back the escalated row counts.
export const ESCALATED_DAYS = 7;

type EscalatedCount = { n: number | string };

// This person's escalated turns (a demo visit: its own visit's), the same scope the chat and the
// trace read with, since a turn is only readable by the person whose chat it is in.
async function readEscalated(
  q: Queryable,
  e: { now: Date; sub: string; visitId: string | null },
): Promise<NeedsYouRow | null> {
  const [row] = await q.query<EscalatedCount>(
    `SELECT count(*) AS n
       FROM turns t
       JOIN conversations c ON c.id = t.conversation_id AND c.tenant_id = t.tenant_id
      WHERE t.tenant_id = current_tenant_id() AND t.ended_reason = 'escalated'
        AND c.created_by = $1
        AND c.demo_session_id IS NOT DISTINCT FROM CAST($2 AS uuid)
        AND t.finished_at > CAST($3 AS timestamptz) - make_interval(days => ${ESCALATED_DAYS})`,
    [e.sub, e.visitId, e.now.toISOString()],
  );
  return row ? escalatedRow(Number(row.n)) : null;
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

// A record the books step could not get into QuickBooks after its tries (D-104): its latest
// accounting row failed for good or was never read back. Asked as the record pages ask
// (books/status.ts needsPerson), so the count and the page's line agree.
export type BooksStuckRow = {
  kind: MoneyActionKind;
  subjectId: string;
  state: "failed" | "unknown";
  attempt: number;
  failureCategory: string | null;
  checkCount: number;
  amountCents: number;
};

// How many stuck records the read returns at most.
export const BOOKS_LIMIT = 50;

// The kinds booksHref links. The read keeps only these before its limit, so kinds Home cannot show
// never use up the 50.
export const BOOKS_LINKED_KINDS = [
  "settlement_bill",
  "settlement_bill_payment",
  "advance_expense",
  "invoice",
  "customer_payment",
  "money_code_expense",
] as const satisfies readonly MoneyActionKind[];

// Where a stuck record is shown, by its ledger kind. No page shows an escrow release or its post
// yet, so one is not linked or counted here (its kind stays off, books.kinds.escrow).
export function booksHref(r: Pick<BooksStuckRow, "kind" | "subjectId">): string | null {
  switch (r.kind) {
    case "settlement_bill":
    case "settlement_bill_payment":
      return `/records/settlements/${r.subjectId}`;
    case "advance_expense":
      return `/records/advances/${r.subjectId}`;
    case "invoice":
      return `/records/invoices/${r.subjectId}`;
    case "customer_payment":
      return `/records/customer_payments/${r.subjectId}`;
    case "money_code_expense":
      return `/money-codes/${r.subjectId}`;
    default:
      return null;
  }
}

// rows come oldest first; the link opens the oldest.
export function booksRow(
  rows: readonly BooksStuckRow[],
  maxAttempts: number,
  limit = BOOKS_LIMIT,
): NeedsYouRow | null {
  const seen = new Set<string>();
  const stuck = rows.filter((r) => {
    if (!needsPerson(r, maxAttempts) || booksHref(r) === null || seen.has(r.subjectId)) return false;
    seen.add(r.subjectId);
    return true;
  });
  if (stuck.length === 0) return null;
  return {
    key: "books",
    count: stuck.length,
    atLeast: rows.length >= limit,
    what: `${plural(stuck.length, "record", "records")} QuickBooks did not take`,
    amounts: [{ cents: stuck.reduce((s, r) => s + r.amountCents, 0), label: "not in QuickBooks" }],
    href: booksHref(stuck[0]) as string,
    linkLabel: "Open the oldest one",
  };
}

type StuckRead = {
  kind: string;
  subject_id: string;
  state: string;
  attempt: number | string;
  failure_category: string | null;
  check_count: number | string;
  amount_cents: number | string;
};

// Every accounting record's latest ledger row that waits on a person, oldest first.
async function readBooks(q: Queryable, maxAttempts: number): Promise<NeedsYouRow | null> {
  const rows = await q.query<StuckRead>(
    `WITH latest AS (
       SELECT DISTINCT ON (kind, subject_id) kind, subject_id, state, attempt, failure_category,
              check_count, amount_cents, created_at
         FROM money_actions
        WHERE tenant_id = current_tenant_id() AND channel = 'accounting'
          AND kind = ANY(CAST($4 AS text[]))
        ORDER BY kind, subject_id, attempt DESC, created_at DESC
     )
     SELECT kind, subject_id, state, attempt, failure_category, check_count, amount_cents
       FROM latest
      WHERE (state = 'failed' AND (failure_category = 'amount_mismatch' OR attempt >= $1))
         OR (state = 'unknown' AND check_count >= $2)
      ORDER BY created_at, subject_id
      LIMIT $3`,
    [maxAttempts, MAX_CHECKS, BOOKS_LIMIT, `{${BOOKS_LINKED_KINDS.join(",")}}`],
  );
  return booksRow(
    rows.map((r) => ({
      kind: r.kind as MoneyActionKind,
      subjectId: r.subject_id,
      state: r.state === "unknown" ? "unknown" : "failed",
      attempt: Number(r.attempt),
      failureCategory: r.failure_category,
      checkCount: Number(r.check_count),
      amountCents: Number(r.amount_cents),
    })),
    maxAttempts,
  );
}

// The strip's reads, each only while its page is switched on. Runs inside the caller's carrier
// transaction; a failed read throws to the caller, which shows the strip as not read.
export async function readNeedsYou(
  q: Queryable,
  // today is the carrier's own date in its named timezone (carrierToday), for the aging buckets.
  // escalations: only while verification and the agent are on (the caller decides), the person's
  // own chat to count in.
  opts: {
    today: LocalDate;
    settlements: boolean;
    advances: boolean;
    invoices: boolean;
    escalations?: { now: Date; sub: string; visitId: string | null };
    // books: records QuickBooks did not take after the books step's tries (the caller decides).
    books?: { maxAttempts: number };
  },
): Promise<NeedsYouRow[]> {
  const rows: (NeedsYouRow | null)[] = [];
  if (opts.escalations) rows.push(await readEscalated(q, opts.escalations));
  if (opts.settlements) rows.push(paystubsRow((await readSettlementsView(q, null)).rows));
  if (opts.advances) rows.push(advancesRow(await readAdvanceList(q, "requested")));
  if (opts.invoices) {
    rows.push(invoiceCardsRow(await readEngineProposalViews(q, "invoice_post", ENGINE_LIMIT)));
    rows.push(pastDueRow(await readInvoiceList(q, opts.today)));
  }
  if (opts.books) rows.push(await readBooks(q, opts.books.maxAttempts));
  return rows.filter((r): r is NeedsYouRow => r !== null);
}

