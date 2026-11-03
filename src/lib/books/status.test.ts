import { describe, expect, it } from "vitest";
import { MAX_CHECKS } from "../money/types";
import {
  atOrAfterBooksStart,
  booksStatus,
  latestByKind,
  needsPerson,
  needsPersonReason,
  onOrAfterBooksStart,
  type BooksRow,
} from "./status";

// The QuickBooks line a record page shows, from its ledger rows alone (D-104).

const row = (over: Partial<BooksRow> = {}): BooksRow => ({
  kind: "advance_expense",
  attempt: 1,
  state: "confirmed",
  failureCategory: null,
  ...over,
});
const ON = { on: true, maxAttempts: 3 };
const OFF = { on: false, maxAttempts: 3 };

describe("books status line", () => {
  it("reads the latest attempt of each kind", () => {
    const rows = [row({ attempt: 1, state: "failed" }), row({ attempt: 2, state: "confirmed" })];
    expect(latestByKind(rows, "advance_expense")?.attempt).toBe(2);
    expect(latestByKind(rows, "invoice")).toBeNull();
  });

  it("says In QuickBooks with the record's tail once every kind is confirmed", () => {
    const legs = [row({ kind: "settlement_bill" }), row({ kind: "settlement_bill_payment" })];
    expect(booksStatus(legs, ["settlement_bill", "settlement_bill_payment"], { ...ON, tail: "4471" })).toEqual({
      state: "in_books",
      text: "In QuickBooks, record ending 4471",
    });
    expect(booksStatus([row({ kind: "settlement_bill" })], ["settlement_bill", "settlement_bill_payment"], OFF)).toEqual({
      state: "not_yet",
      text: "Not in QuickBooks yet",
    });
    expect(booksStatus([], ["invoice"], { ...OFF, inBooks: true }).text).toBe("In QuickBooks");
  });

  it("says Posting by itself while the step is on and tries are left", () => {
    expect(booksStatus([], ["advance_expense"], ON)).toEqual({ state: "posting", text: "Posting by itself" });
    const failedOnce = [row({ state: "failed", failureCategory: "validation", attempt: 2 })];
    expect(booksStatus(failedOnce, ["advance_expense"], ON).text).toBe("Posting by itself");
  });

  it("never claims the step is posting while it is off", () => {
    expect(booksStatus([], ["advance_expense"], OFF).text).toBe("Not in QuickBooks yet");
    expect(booksStatus([row({ state: "failed", failureCategory: "timeout" })], ["advance_expense"], OFF).text).toBe(
      "Not in QuickBooks yet",
    );
    expect(booksStatus([row({ state: "unknown" })], ["advance_expense"], OFF).text).toBe(
      "Waiting for QuickBooks to answer",
    );
  });

  it("asks a person after the last try, for another amount at once, and after every read-back", () => {
    const out = row({ state: "failed", failureCategory: "validation", attempt: 3 });
    expect(needsPerson(out, 3)).toBe(true);
    expect(booksStatus([out], ["advance_expense"], ON)).toEqual({
      state: "needs_person",
      text: "Needs a person: QuickBooks did not accept it",
    });
    const mismatch = row({ state: "failed", failureCategory: "amount_mismatch", attempt: 1 });
    expect(booksStatus([mismatch], ["advance_expense"], OFF).text).toBe(
      "Needs a person: QuickBooks shows a different amount",
    );
    expect(needsPerson(row({ state: "unknown", checkCount: MAX_CHECKS - 1 }), 3)).toBe(false);
    const unread = row({ state: "unknown", checkCount: MAX_CHECKS });
    expect(needsPersonReason(unread, 3)).toBe("we could not confirm it in QuickBooks");
    expect(needsPersonReason(row({ state: "failed", failureCategory: "timeout", attempt: 3 }), 3)).toBe(
      "QuickBooks did not take it after 3 tries",
    );
    expect(needsPerson(row({ state: "failed", failureCategory: "timeout", attempt: 2 }), 3)).toBe(false);
  });

  it("says the step reaches a record only from the books start date, in the carrier's zone", () => {
    expect(onOrAfterBooksStart("2026-11-04", "2026-11-04")).toBe(true);
    expect(onOrAfterBooksStart("2026-11-03", "2026-11-04")).toBe(false);
    expect(onOrAfterBooksStart(null, "2026-11-04")).toBe(false);
    expect(onOrAfterBooksStart("2026-11-4", "2026-11-04")).toBe(false);
    // 03:30 UTC on Nov 4 is still Nov 3 in Chicago.
    expect(atOrAfterBooksStart("2026-11-04T03:30:00.000Z", "America/Chicago", "2026-11-04")).toBe(false);
    expect(atOrAfterBooksStart("2026-11-04T07:00:00.000Z", "America/Chicago", "2026-11-04")).toBe(true);
    expect(atOrAfterBooksStart(null, "America/Chicago", "2026-11-04")).toBe(false);
    expect(atOrAfterBooksStart("not a time", "America/Chicago", "2026-11-04")).toBe(false);
  });
});
