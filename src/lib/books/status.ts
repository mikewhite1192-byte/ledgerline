import { MAX_CHECKS, type MoneyAction, type MoneyActionKind } from "../money/types";
import { isLocalDate, localDateOf } from "../time/local-date";

// Where one record stands in QuickBooks, in plain words, from its ledger rows alone (D-104). The
// books step posts every money movement by itself and tries again after a failure; a person is
// asked only when it still fails after its tries, when QuickBooks holds another amount, or when a
// post could never be read back. Pure: no database, no clock. The record pages and the Home count
// (needs-you.ts) ask the same questions, so they never disagree.

export type BooksState = "in_books" | "posting" | "needs_person" | "not_yet";
// The ledger facts the line reads: a whole ledger row, or a record page's leg row.
// checkCount: the read-backs made so far; a view that does not carry it reads as none.
export type BooksRow = {
  kind: string;
  attempt: number;
  state: MoneyAction["state"];
  failureCategory: string | null;
  checkCount?: number;
};
export type BooksLine = { state: BooksState; text: string };

// Why a person is needed, from the failure's category. Never the raw outside text.
const REASONS: Readonly<Record<string, string>> = {
  amount_mismatch: "QuickBooks shows a different amount",
  not_connected: "QuickBooks is not connected",
  not_configured: "an account is not set up in QuickBooks",
  auth: "the QuickBooks sign-in needs renewing",
  validation: "QuickBooks did not accept it",
  duplicate: "QuickBooks already has a record with this number",
};

export function latestByKind<R extends BooksRow>(rows: readonly R[], kind: MoneyActionKind): R | null {
  return rows
    .filter((a) => a.kind === kind)
    .reduce<R | null>((top, a) => (top === null || a.attempt > top.attempt ? a : top), null);
}

// A row that waits on a person: failed for good (another amount, or its tries used up), or left
// unknown after every read-back the reconcile pass may make.
export function needsPerson(a: BooksRow, maxAttempts: number): boolean {
  if (a.state === "failed") return a.failureCategory === "amount_mismatch" || a.attempt >= maxAttempts;
  return a.state === "unknown" && (a.checkCount ?? 0) >= MAX_CHECKS;
}

export function needsPersonReason(a: BooksRow, maxAttempts: number): string {
  if (a.state === "unknown") return "we could not confirm it in QuickBooks";
  return REASONS[a.failureCategory ?? ""] ?? `QuickBooks did not take it after ${maxAttempts} tries`;
}

// Whether the books step reaches a record of this date: it posts nothing dated before
// books.startDate (only the backfill does), so a record page says "Posting by itself" only from
// then on. day: the record's own date (an invoice's issue day, a payment's day received); at: an
// instant, read as a date in the carrier's zone, as the step reads it. A date that cannot be read
// counts as before.
export function onOrAfterBooksStart(day: string | null, startDate: string): boolean {
  return isLocalDate(day) && day >= startDate;
}

export function atOrAfterBooksStart(at: string | null, zone: string, startDate: string): boolean {
  if (at === null) return false;
  try {
    return onOrAfterBooksStart(localDateOf(at, zone), startDate);
  } catch {
    return false;
  }
}

// kinds: the record's books kinds in order (a paystub's bill, then its payment). inBooks: the
// record already holds its QuickBooks id (an invoice or a payment). tail: the end of that id, shown
// so a person can find it there. on: the books step is switched on.
export function booksStatus(
  rows: readonly BooksRow[],
  kinds: readonly MoneyActionKind[],
  opts: { on: boolean; maxAttempts: number; inBooks?: boolean; tail?: string | null },
): BooksLine {
  const latest = kinds.map((k) => latestByKind(rows, k));
  const stuck = latest.find((a): a is BooksRow => a !== null && needsPerson(a, opts.maxAttempts));
  if (stuck) return { state: "needs_person", text: `Needs a person: ${needsPersonReason(stuck, opts.maxAttempts)}` };
  if (opts.inBooks === true || (latest.length > 0 && latest.every((a) => a?.state === "confirmed"))) {
    const tail = opts.tail ? `, record ending ${opts.tail}` : "";
    return { state: "in_books", text: `In QuickBooks${tail}` };
  }
  if (opts.on) return { state: "posting", text: "Posting by itself" };
  // With the step off, a post already under way waits for its answer (the page's check reads it).
  if (latest.some((a) => a !== null && a.state !== "failed" && a.state !== "confirmed")) {
    return { state: "posting", text: "Waiting for QuickBooks to answer" };
  }
  return { state: "not_yet", text: "Not in QuickBooks yet" };
}
