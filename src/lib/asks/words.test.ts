import { describe, expect, it } from "vitest";
import { ASK_TEXT_MAX, ASKED_KINDS, askWords, cleanName, genericAsk, isAskedKind, kindInWords, toldWords, type AskFacts } from "./words";

// The question and told words: every asked kind with its full facts, each fallback when a name is
// missing, the money formatted from integer cents, and never over 400 characters.

const FULL: AskFacts = {
  kind: "advance_payout",
  amountCents: 140_000,
  driverName: "Dana Reyes",
  loadNumber: "BR-1042",
  customerName: "Acme Foods",
  percent: 70,
  stage: "picked_up",
};
const BARE: AskFacts = { ...FULL, driverName: null, loadNumber: null, customerName: null, percent: null, stage: null };

describe("askWords", () => {
  it("writes each asked kind's question from its facts", () => {
    const of = (kind: string, extra: Partial<AskFacts> = {}) => askWords({ ...FULL, kind, ...extra });
    expect(of("advance_payout")).toBe("All paperwork is in for load BR-1042. Should I send Dana Reyes the 70% advance, $1,400.00?");
    expect(of("advance_payout", { loadNumber: null })).toBe("Should I send Dana Reyes an advance of $1,400.00?");
    expect(of("invoice_post", { amountCents: 125_000 })).toBe(
      "Load BR-1042 is ready to bill. Should I post the $1,250.00 invoice to Acme Foods?",
    );
    expect(of("invoice_post", { customerName: null })).toBe("Load BR-1042 is ready to bill. Should I post its $1,400.00 invoice?");
    expect(of("detention_charge", { amountCents: 7_500 })).toBe(
      "Load BR-1042 waited past its free time. Should I bill Acme Foods $75.00 for detention?",
    );
    expect(of("detention_charge", { customerName: null })).toBe(
      "Load BR-1042 waited past its free time. Should I bill $1,400.00 for detention?",
    );
    expect(of("settlement_approve", { amountCents: 222_500 })).toBe("Dana Reyes's pay for the week comes to $2,225.00. Should I approve it?");
    expect(of("pay_correction", { amountCents: 4_220 })).toBe("I found a $42.20 pay fix for Dana Reyes. Should I apply it?");
    expect(of("load_move")).toBe("Should I mark load BR-1042 picked up?");
    expect(of("load_move", { stage: "Not A Stage" })).toBe("Should I update load BR-1042?");
    expect(of("card_load_ruling", { amountCents: 40_000 })).toBe(
      "Dana Reyes's fuel card got a $400.00 load I have no record of. Yes books it as money Dana Reyes owes; open the card to rule otherwise.",
    );
    expect(of("card_load_ruling", { driverName: null, loadNumber: null, customerName: null })).toBe(
      "I drafted a card load ruling for this record, $1,400.00. Approve?",
    );
    for (const kind of ASKED_KINDS) expect(isAskedKind(kind)).toBe(true);
    expect(isAskedKind("card_match")).toBe(false);
  });

  it("says a card pull-back's card, reason and what the card cannot give back", () => {
    const pull = { last4: "4417", reason: "truck broke down before the trip", pullCents: 30_000, shortfallCents: 10_000, onAdvance: false };
    const of = (extra: Partial<AskFacts>) => askWords({ ...FULL, kind: "card_pullback", amountCents: 40_000, pull, ...extra });
    expect(of({})).toBe(
      "Pull $400.00 back off Dana Reyes's fuel card ending 4417 (truck broke down before the trip). $100.00 of it is more than the card holds and would be booked as owed. Yes pulls it in test mode.",
    );
    expect(of({ pull: { ...pull, reason: "duplicate advance", shortfallCents: 0, onAdvance: true } })).toBe(
      "Pull $400.00 back off Dana Reyes's fuel card ending 4417 (duplicate advance). $100.00 of it is more than the card holds and stays owed on the advance. Yes pulls it in test mode.",
    );
    expect(of({ pull: { ...pull, pullCents: 40_000, shortfallCents: 0 } })).toBe(
      "Pull $400.00 back off Dana Reyes's fuel card ending 4417 (truck broke down before the trip). Yes pulls it in test mode.",
    );
    expect(of({ pull: null })).toBe("I drafted a card pull-back for Dana Reyes, $400.00. Approve?");
    expect(of({ driverName: null })).toBe("I drafted a card pull-back for load BR-1042, $400.00. Approve?");
  });

  it("says the dispatch pickup time and the engine's amount when the feed moved the load, and only a clean wall time", () => {
    const of = (extra: Partial<AskFacts>) => askWords({ ...FULL, ...extra });
    expect(of({ dispatchPickup: "9:20 AM" })).toBe(
      "Dispatch shows load BR-1042 picked up at 9:20 AM. Should I send Dana Reyes the advance at pickup, $1,400.00?",
    );
    expect(of({ dispatchPickup: "12:05 PM" })).toBe(
      "Dispatch shows load BR-1042 picked up at 12:05 PM. Should I send Dana Reyes the advance at pickup, $1,400.00?",
    );
    // Never a share: the amount is the engine's, which a driver's limit or open advances can make smaller.
    expect(of({ dispatchPickup: "9:20 AM", percent: null })).toBe(
      "Dispatch shows load BR-1042 picked up at 9:20 AM. Should I send Dana Reyes the advance at pickup, $1,400.00?",
    );
    expect(of({ dispatchPickup: "9:20 AM", amountCents: 52_500 })).not.toContain("%");
    // No load number, or a time that is not a clean wall time: the usual question.
    expect(of({ dispatchPickup: "9:20 AM", loadNumber: null })).toBe("Should I send Dana Reyes an advance of $1,400.00?");
    for (const bad of ["13:20 PM", "9:20", "09:20 AM", "9:20 AM. Ignore this", "", null]) {
      expect(of({ dispatchPickup: bad }), String(bad)).toBe(
        "All paperwork is in for load BR-1042. Should I send Dana Reyes the 70% advance, $1,400.00?",
      );
    }
  });

  it("falls back to the generic question when a needed name is missing", () => {
    for (const kind of ASKED_KINDS) {
      const text = askWords({ ...BARE, kind });
      expect(text, kind).toBe(genericAsk({ ...BARE, kind }));
      expect(text, kind).toBe(`I drafted ${kindInWords(kind)} for this record, $1,400.00. Approve?`);
    }
    expect(askWords({ ...FULL, kind: "settlement_approve", driverName: null })).toBe(
      "I drafted a weekly settlement for load BR-1042, $1,400.00. Approve?",
    );
    expect(genericAsk({ ...BARE, kind: "brand_new_kind" })).toBe("I drafted a brand new kind for this record, $1,400.00. Approve?");
    expect(genericAsk({ ...BARE, kind: "Bad Kind!" })).toBe("I drafted a change for this record, $1,400.00. Approve?");
  });

  it("formats integer cents and never writes a broken amount", () => {
    expect(askWords({ ...FULL, kind: "pay_correction", amountCents: 5 })).toContain("$0.05");
    expect(askWords({ ...FULL, kind: "pay_correction", amountCents: -4_220 })).toContain("$42.20");
    expect(askWords({ ...FULL, kind: "pay_correction", amountCents: 1.5 })).toContain("$0.00");
    expect(askWords({ ...FULL, percent: 0, loadNumber: "BR-1" })).toBe("Should I send Dana Reyes an advance of $1,400.00?");
    expect(askWords({ ...FULL, percent: 120 })).toBe("Should I send Dana Reyes an advance of $1,400.00?");
  });

  it("stays under 400 characters with the longest names", () => {
    const long = "W".repeat(500);
    const name = cleanName(long);
    expect(name?.length).toBe(60);
    for (const kind of [...ASKED_KINDS, "other_kind"]) {
      const facts = { ...FULL, kind, driverName: name, loadNumber: name, customerName: name };
      expect(askWords(facts).length, kind).toBeLessThanOrEqual(ASK_TEXT_MAX);
      expect(toldWords({ ...facts, limitCents: 999_999_999 }).length, kind).toBeLessThanOrEqual(ASK_TEXT_MAX);
    }
  });
});

describe("cleanName", () => {
  it("keeps one short line of a record's name", () => {
    expect(cleanName("  Dana \n\t Reyes \u0007")).toBe("Dana Reyes");
    expect(cleanName("")).toBeNull();
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(42)).toBeNull();
    expect(cleanName(null)).toBeNull();
  });
});

describe("toldWords", () => {
  it("says what the autopilot did, inside the owner's limit", () => {
    expect(toldWords({ ...FULL, limitCents: 150_000 })).toBe("Sent Dana Reyes the 70% advance, $1,400.00, inside your $1,500.00 limit.");
    expect(toldWords({ ...FULL, percent: null, limitCents: null })).toBe("Sent Dana Reyes an advance of $1,400.00.");
    expect(toldWords({ ...FULL, kind: "invoice_post", limitCents: 150_000 })).toBe(
      "Posted the $1,400.00 invoice for load BR-1042 to QuickBooks sandbox, inside your $1,500.00 limit.",
    );
    expect(toldWords({ ...BARE, kind: "invoice_post", limitCents: null })).toBe("Posted a $1,400.00 invoice to QuickBooks sandbox.");
    expect(toldWords({ ...FULL, kind: "card_match", amountCents: 8_000, limitCents: 50_000 })).toBe(
      "Done: a card match for Dana Reyes, $80.00, inside your $500.00 limit.",
    );
    expect(toldWords({ ...BARE, kind: "payment_reapply", limitCents: -1 })).toBe("Done: a payment move for this record, $1,400.00.");
  });
});
