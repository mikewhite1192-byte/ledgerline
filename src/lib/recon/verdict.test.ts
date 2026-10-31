import { describe, expect, it } from "vitest";
import type { RunView } from "../data/card-recon";
import { statementVerdict } from "./run";
import { verdictLine } from "./view";
import { verdictWords } from "./words";

// The card statement's verdict, from a finished check's stored counts: code decides verified, hold
// or empty and the amount in whole cents; the words are fixed. Nothing here reads the clock.

function run(counts: Record<string, unknown>, over: Partial<RunView> = {}): RunView {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    status: "done",
    phase: "done",
    failCategory: null,
    windowFrom: "2026-10-18",
    windowTo: "2026-10-31",
    counts,
    unchecked: [],
    modelCents: 0,
    startedAt: "2026-10-31T17:00:00.000Z",
    finishedAt: "2026-10-31T17:00:05.000Z",
    ...over,
  } as RunView;
}

describe("the card statement's verdict", () => {
  it("is verified with the statement's total when every line was compared and none differs", () => {
    const r = run({ statement: 38, statementCents: 421_050, statementBreaks: 0, statementOpen: {} });
    expect(statementVerdict(r)).toEqual({ kind: "verified", cents: 421_050, lines: 38 });
    expect(verdictLine(r)).toBe("Verified, go pay $4,210.50: all 38 card lines match our records.");
  });

  it("says the one line when the statement has one", () => {
    expect(verdictWords({ kind: "verified", cents: 21_240, lines: 1 })).toBe(
      "Verified, go pay $212.40: the one card line matches our records.",
    );
  });

  it("holds with the count of each open category, in a fixed order and fixed words", () => {
    const r = run({
      statement: 38,
      statementCents: 421_050,
      statementOpen: { card_unknown: 1, fuel_amount_differs: 2, load_not_in_ledger: 1, purchase_not_recorded: 0 },
    });
    expect(statementVerdict(r)).toEqual({
      kind: "hold",
      breaks: 4,
      byCategory: [
        { category: "fuel_amount_differs", count: 2 },
        { category: "card_unknown", count: 1 },
        { category: "load_not_in_ledger", count: 1 },
      ],
      cut: false,
    });
    expect(verdictLine(r)).toBe(
      "Hold: 4 breaks on the statement: Fuel amount differs (2), Card not on file (1), Card load with no payment record (1). Do not pay it yet.",
    );
  });

  it("holds when not every line was compared, with or without a difference", () => {
    const cut = [{ system: "fuel_card_sim", category: "too_many_rows" }];
    const clean = run({ statement: 2_000, statementCents: 9_000_000, statementOpen: {} }, { unchecked: cut });
    expect(statementVerdict(clean)).toEqual({ kind: "hold", breaks: 0, byCategory: [], cut: true });
    expect(verdictLine(clean)).toBe("Hold: not every card line was compared. Do not pay the statement yet.");
    const many = run(
      { statement: 900, statementCents: 9_000_000, statementOpen: { purchase_not_recorded: 1 } },
      { unchecked: [{ system: "fuel_card_sim", category: "too_many_differences" }] },
    );
    expect(verdictLine(many)).toBe(
      "Hold: 1 break on the statement: Fuel purchase not on file (1). Not every line was compared. Do not pay it yet.",
    );
    // A payment system the check could not read is not a statement line left out.
    const other = run(
      { statement: 3, statementCents: 30_000, statementOpen: {} },
      { unchecked: [{ system: "stripe_test", category: "not_connected" }] },
    );
    expect(statementVerdict(other)?.kind).toBe("verified");
  });

  it("is empty, with nothing to pay, when the window holds no card line", () => {
    const r = run({ statement: 0, statementCents: 0, statementOpen: {} });
    expect(statementVerdict(r)).toEqual({ kind: "empty" });
    expect(verdictLine(r)).toBe("No card lines on the statement for this window. Nothing to pay.");
  });

  it("gives no verdict while running, after a failure, or when the counts do not say", () => {
    const counts = { statement: 3, statementCents: 30_000, statementOpen: {} };
    expect(statementVerdict(run(counts, { status: "running" }))).toBeNull();
    expect(statementVerdict(run(counts, { status: "failed" }))).toBeNull();
    // A check stored before the verdict existed: unknown is not zero.
    expect(statementVerdict(run({ statement: 3, statementBreaks: 0 }))).toBeNull();
    expect(statementVerdict(run({ statement: 3, statementCents: 30_000 }))).toBeNull();
    expect(statementVerdict(run({ ...counts, statementCents: 12.5 }))).toBeNull();
    expect(statementVerdict(run({ ...counts, statementCents: -1 }))).toBeNull();
    expect(statementVerdict(run({ ...counts, statementOpen: { card_unknown: 1.5 } }))).toBeNull();
    expect(statementVerdict(run({ ...counts, statementOpen: { not_confirmed: 1 } }))).toBeNull();
    expect(statementVerdict(run({ ...counts, statementOpen: [] }))).toBeNull();
    // Lines with no cents, or cents with no lines, do not add up.
    expect(statementVerdict(run({ statement: 3, statementCents: 2, statementOpen: {} }))).toBeNull();
    expect(statementVerdict(run({ statement: 0, statementCents: 100, statementOpen: {} }))).toBeNull();
    expect(verdictLine(null)).toBeNull();
    expect(verdictWords(null)).toBeNull();
  });

  it("reads the same verdict from the same stored check every time", () => {
    const stored = JSON.stringify({ statement: 5, statementCents: 50_000, statementOpen: { card_unknown: 1 } });
    const first = statementVerdict(run(JSON.parse(stored)));
    const again = statementVerdict(run(JSON.parse(stored)));
    expect(again).toEqual(first);
    expect(verdictWords(again)).toBe(verdictWords(first));
  });

  it("writes no dash characters", () => {
    const words = [
      verdictWords({ kind: "verified", cents: 100, lines: 1 }),
      verdictWords({ kind: "hold", breaks: 1, byCategory: [{ category: "card_unknown", count: 1 }], cut: true }),
      verdictWords({ kind: "empty" }),
    ].join(" ");
    expect(words).not.toMatch(/[\u2013\u2014]/);
  });
});
