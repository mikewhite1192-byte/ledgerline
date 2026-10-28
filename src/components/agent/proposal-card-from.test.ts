import { describe, expect, it } from "vitest";
import type { ProposalView } from "@/lib/agent/view";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import {
  FLAG_QUESTION,
  advanceLoadDetail,
  auditFor,
  detentionLines,
  hoursMinutes,
  kindCopy,
  proposalCardFrom,
} from "./proposal-card-from";

const DRIVER = "11111111-1111-4111-8111-111111111111";

const view: ProposalView = {
  id: "p-1",
  kind: "advance_payout",
  subjectTable: "drivers",
  subjectId: DRIVER,
  subjectLabel: "BR-D07",
  amountCents: 20_000,
  direction: "out",
  title: "Pay advance",
  reasons: [{ category: "earned_unpaid_covers", text: "Earned, unpaid pay this week covers the advance.", source: { table: "drivers", id: DRIVER } }],
  sources: [{ table: "drivers", id: DRIVER }],
  status: "proposed",
  flagged: false,
  flagCategories: [],
  operatorVerdict: "eligible",
  auditorVerdict: null,
  auditorConcerns: [],
  auditorCheckedAt: null,
  auditorOverride: null,
  destination: { label: "fuel card ending 4417", last4: "4417", testMode: true },
};

const noCard: ProposalView = {
  ...view,
  destination: { label: "no fuel card on file", last4: null, testMode: true },
};

describe("proposalCardFrom", () => {
  it("builds the card from fixed words and the engine's cents", () => {
    const card = proposalCardFrom(view);
    expect(card).toMatchObject({
      id: "p-1",
      title: "Pay advance for BR-D07",
      impact: { cents: 20_000, direction: "out" },
      status: "proposed",
      destination: { label: "To fuel card ending 4417", testMode: true },
      confirmQuestion: "Pay $200.00 to BR-D07's fuel card ending 4417?",
      confirmNoun: "advance",
      confirmNext: "This is a test payout to the driver's fuel card. It is taken back from the driver's pay on a later paystub.",
      references: { [`drivers:${DRIVER}`]: "Driver BR-D07" },
    });
    expect(card.flagNote).toBeUndefined();
    expect(card.reasons).toEqual([{ text: view.reasons[0].text, source: { table: "drivers", id: DRIVER } }]);
  });

  it("says no card is on file, without Test mode, and asks the plain question", () => {
    const card = proposalCardFrom(noCard);
    expect(card.destination).toEqual({ label: "No fuel card on file", testMode: false });
    expect(card.confirmQuestion).toBe("Pay $200.00 to BR-D07?");
    expect(card.confirmNext).toBe("This driver has no fuel card on file, so nothing can be paid until one is added.");
  });

  it("names an advance's load and, under a cap, what was left after it", () => {
    expect(advanceLoadDetail(null)).toBeUndefined();
    expect(advanceLoadDetail(undefined)).toBeUndefined();
    expect(advanceLoadDetail({ number: "BR-L10001", capCents: null, leftAfterCents: null })).toBe("For load BR-L10001.");
    const load = { number: "BR-L10001", capCents: 60_000, leftAfterCents: 14_500 };
    expect(advanceLoadDetail(load)).toBe("Load BR-L10001: $145.00 of $600.00 cap left after this.");
    expect(proposalCardFrom({ ...view, load }).detail).toBe("Load BR-L10001: $145.00 of $600.00 cap left after this.");
    expect(proposalCardFrom(view).detail).toBeUndefined();
    // Only an advance carries a load line.
    expect(proposalCardFrom({ ...view, kind: "pay_correction", destination: null, load }).detail).toBeUndefined();
  });

  it("shows no destination for a kind that pays no card", () => {
    const card = proposalCardFrom({ ...view, kind: "pay_correction", destination: null });
    expect(card.destination).toBeUndefined();
    expect(card.confirmQuestion).toBe("Add this pay correction to BR-D07's pay?");
    expect(card.confirmNoun).toBe("pay correction");
  });

  it("keeps the flag question on a flagged proposal even with a card on file", () => {
    const card = proposalCardFrom({ ...view, flagged: true, flagCategories: ["authority_claim"] });
    expect(card.confirmQuestion).toBe(FLAG_QUESTION);
    expect(card.destination).toEqual({ label: "To fuel card ending 4417", testMode: true });
  });

  it("asks the flag question and names the flag on a flagged proposal", () => {
    const card = proposalCardFrom({ ...view, flagged: true, flagCategories: ["instruction_to_agent"] });
    expect(card.confirmQuestion).toBe(FLAG_QUESTION);
    expect(card.flagNote).toContain("instructions to the assistant");
  });

  it("leaves out a reason's source when it has none", () => {
    const card = proposalCardFrom({ ...view, reasons: [{ category: "x", text: "A rule check found this.", source: null }] });
    expect(card.reasons).toEqual([{ text: "A rule check found this." }]);
  });

  it("lets a person resume only an approved advance payout or pay correction, never one executing or another kind", () => {
    expect(proposalCardFrom({ ...view, status: "approved" }).canResume).toBe(true);
    expect(proposalCardFrom({ ...view, kind: "pay_correction", status: "approved" }).canResume).toBe(true);
    expect(proposalCardFrom({ ...view, kind: "invoice_fix", status: "approved" }).canResume).toBeUndefined();
    for (const kind of ["advance_payout", "pay_correction"] as const) {
      for (const status of ["proposed", "executing", "done", "failed", "unknown", "rejected"] as const) {
        expect(proposalCardFrom({ ...view, kind, status }).canResume, `${kind} ${status}`).toBeUndefined();
      }
    }
  });

  it("renders a ref the link rules refuse as text, never throwing", () => {
    expect(hrefOrNull(recordHref, { table: "memberships", id: DRIVER })).toBeNull();
    expect(hrefOrNull(recordHref, { table: "drivers", id: "" })).toBeNull();
    expect(hrefOrNull(recordHref, { table: "drivers", id: DRIVER })).toBe(`/records/drivers/${DRIVER}`);
  });
});

describe("the auditor on the card", () => {
  const on = { on: true, checking: false };

  it("maps each stored verdict to its line, with fixed sentences only", () => {
    expect(auditFor({ ...view, auditorVerdict: "pass" }, on)).toEqual({ state: "pass" });
    expect(auditFor({ ...view, auditorVerdict: "concerns", auditorConcerns: ["source_missing"] }, on)).toEqual({
      state: "concerns",
      text: "A record behind it is missing.",
    });
    expect(auditFor({ ...view, auditorVerdict: "block", auditorConcerns: ["amount_wrong"] }, on)).toEqual({
      state: "block",
      text: "The amount does not match the number from your pay rules.",
    });
    expect(auditFor({ ...view, auditorVerdict: "unknown", auditorConcerns: ["insufficient_evidence"] }, on)).toMatchObject({
      state: "unknown",
    });
    expect(auditFor({ ...view, auditorVerdict: "unknown", auditorConcerns: ["budget"] }, on)).toEqual({ state: "budget" });
  });

  it("reads no verdict as off, checking or not checked", () => {
    expect(auditFor(view, { on: false, checking: false })).toEqual({ state: "off" });
    expect(auditFor(view, { on: true, checking: true })).toEqual({ state: "checking" });
    expect(auditFor(view, on)).toEqual({ state: "unknown" });
    expect(auditFor({ ...view, status: "approved" }, { on: true, checking: true })).toEqual({ state: "unknown" });
  });

  it("carries a stored override with who and when, the time in UTC", () => {
    const audit = auditFor(
      {
        ...view,
        status: "approved",
        auditorVerdict: "block",
        auditorConcerns: ["amount_wrong"],
        auditorOverride: { reason: "Driver showed the receipt", byLabel: "an admin", at: "2026-10-28T15:00:00.000Z" },
      },
      on,
    );
    expect(audit.override).toMatchObject({ reason: "Driver showed the receipt", byLabel: "an admin" });
    expect(audit.override?.at).toContain("UTC");
  });

  it("asks the audit question on concerns and unknown, none extra on pass or block", () => {
    const concerns = proposalCardFrom({ ...view, auditorVerdict: "concerns", auditorConcerns: ["source_missing"] }, on);
    expect(concerns.confirmQuestion).toBe("The second check has a concern (source missing). Approve anyway?");
    expect(proposalCardFrom({ ...view, auditorVerdict: "unknown" }, on).confirmQuestion).toBe(
      "The second check could not run. Approve anyway?",
    );
    // No verdict yet reads as not checked.
    expect(proposalCardFrom(view, on).confirmQuestion).toBe("The second check could not run. Approve anyway?");
    const pay = "Pay $200.00 to BR-D07's fuel card ending 4417?";
    expect(proposalCardFrom({ ...view, auditorVerdict: "pass" }, on).confirmQuestion).toBe(pay);
    expect(proposalCardFrom({ ...view, auditorVerdict: "block" }, on).confirmQuestion).toBe(pay);
  });

  it("lets the flag question win over the audit question", () => {
    const card = proposalCardFrom({ ...view, flagged: true, auditorVerdict: "concerns", auditorConcerns: ["flagged_input"] }, on);
    expect(card.confirmQuestion).toBe(FLAG_QUESTION);
  });

  it("adds no audit line and no audit question without the page's audit context", () => {
    const card = proposalCardFrom({ ...view, auditorVerdict: "concerns", auditorConcerns: ["source_missing"] });
    expect(card).not.toHaveProperty("audit");
    expect(card.confirmQuestion).toBe("Pay $200.00 to BR-D07's fuel card ending 4417?");
  });

  it("explains a detention charge stop by stop from the stored figures, then the invoice change", () => {
    const LOAD = "22222222-2222-4222-8222-222222222222";
    const card = proposalCardFrom({
      ...view,
      kind: "detention_charge",
      subjectTable: "loads",
      subjectId: LOAD,
      subjectLabel: "BR-L0412",
      amountCents: 37_500,
      direction: "in",
      title: "Bill unbilled detention",
      reasons: [],
      sources: [{ table: "loads", id: LOAD }],
      operatorVerdict: "not_given",
      detention: {
        freeMinutes: 120,
        hourlyCents: 7_500,
        invoiceAmountBeforeCents: 250_000,
        stops: [{ stop: "pickup", dwellMinutes: 420, overMinutes: 300, quarters: 20, cents: 37_500 }],
      },
    });
    expect(card.title).toBe("Bill unbilled detention for BR-L0412");
    expect(card.impact).toEqual({ cents: 37_500, direction: "in" });
    expect(card.confirmQuestion).toBe("Add a $375.00 detention charge to load BR-L0412?");
    expect(card.confirmNoun).toBe("detention charge");
    expect(card.reasons).toEqual([
      { text: "7 h 00 min at the shipper, 2 h 00 min free, 20 started quarter hours at $75.00 an hour: $375.00." },
      { text: "The open invoice goes from $2,500.00 to $2,875.00." },
    ]);
  });

  it("writes minutes as hours and minutes, and one quarter hour in the singular", () => {
    expect(hoursMinutes(0)).toBe("0 h 00 min");
    expect(hoursMinutes(135)).toBe("2 h 15 min");
    const [line] = detentionLines(
      {
        freeMinutes: 120,
        hourlyCents: 6_000,
        invoiceAmountBeforeCents: 100_000,
        stops: [{ stop: "delivery", dwellMinutes: 125, overMinutes: 5, quarters: 1, cents: 1_500 }],
      },
      1_500,
    );
    expect(line).toBe("2 h 05 min at the consignee, 2 h 00 min free, 1 started quarter hour at $60.00 an hour: $15.00.");
  });
});

describe("each kind's confirm words", () => {
  const LOAD = "22222222-2222-4222-8222-222222222222";
  const APPLICATION = "44444444-4444-4444-8444-444444444444";

  it("names what each kind is and says what its approval does", () => {
    const cases: [ProposalView["kind"], Partial<ProposalView>, string, string | undefined][] = [
      ["advance_payout", {}, "advance", "Pay $200.00 to BR-D07's fuel card ending 4417?"],
      ["pay_correction", { destination: null }, "pay correction", "Add this pay correction to BR-D07's pay?"],
      ["load_rate_fill", { subjectTable: "loads", subjectId: LOAD, subjectLabel: "BR-L0412", destination: null }, "load rate", "Write the rate onto load BR-L0412?"],
      ["invoice_post", { subjectTable: "loads", subjectId: LOAD, subjectLabel: "BR-L0412", destination: null, direction: "in" }, "invoice", "Create a $200.00 invoice for load BR-L0412?"],
      ["payment_reapply", { subjectTable: "payment_applications", subjectId: APPLICATION, subjectLabel: "CHK-1042", destination: null, direction: "none" }, "payment", "Move payment CHK-1042 to the right invoice?"],
      ["settlement_approve", { subjectTable: "settlements", destination: null }, "paystub", "Approve this paystub and pay $200.00?"],
    ];
    for (const [kind, extra, noun, question] of cases) {
      const card = proposalCardFrom({ ...view, kind, ...extra });
      expect(card.confirmNoun, kind).toBe(noun);
      expect(card.confirmQuestion, kind).toBe(question);
      expect(card.confirmNext, kind).toMatch(/\.$/);
    }
  });

  it("says nothing is paid or sent where the kind moves no money", () => {
    expect(proposalCardFrom({ ...view, kind: "load_rate_fill", destination: null }).confirmNext).toContain("No money moves and nothing is sent.");
    expect(proposalCardFrom({ ...view, kind: "payment_reapply", destination: null }).confirmNext).toContain("No money moves and nothing is sent.");
    expect(proposalCardFrom({ ...view, kind: "invoice_post", destination: null }).confirmNext).toContain("Nothing is emailed to the customer.");
  });

  it("leaves a $0 paystub's question to the paystub card, and says no payout is sent", () => {
    const card = proposalCardFrom({ ...view, kind: "settlement_approve", subjectTable: "settlements", amountCents: 0, destination: null });
    expect(card.confirmQuestion).toBeUndefined();
    expect(card.confirmNext).toBe("No payout is sent. The paystub is booked, and any deductions left over carry to next week.");
  });

  it("reads a kind with no row as a plain request, so a new kind never breaks the card", () => {
    expect(kindCopy("money_code")).toEqual({ noun: "request" });
    expect(kindCopy("toString").noun).toBe("request");
    expect(kindCopy("__proto__").noun).toBe("request");
    const card = proposalCardFrom({ ...view, kind: "fuel_anomaly" as ProposalView["kind"], destination: null });
    expect(card.confirmNoun).toBe("request");
    expect(card.confirmQuestion).toBeUndefined();
    expect(card).not.toHaveProperty("confirmNext");
    expect(card.references).toEqual({ [`drivers:${DRIVER}`]: "Driver BR-D07" });
    // invoice_fix has no executor yet, so it reads the fallback too.
    expect(proposalCardFrom({ ...view, kind: "invoice_fix", destination: null }).confirmNoun).toBe("request");
  });

  it("names the subject by its code for Also read, and nothing at all without one", () => {
    const load = proposalCardFrom({ ...view, kind: "detention_charge", subjectTable: "loads", subjectId: LOAD, subjectLabel: "BR-L0412", destination: null });
    expect(load.references).toEqual({ [`loads:${LOAD}`]: "Load BR-L0412" });
    const payment = proposalCardFrom({ ...view, kind: "payment_reapply", subjectTable: "payment_applications", subjectId: APPLICATION, subjectLabel: "CHK-1042", destination: null });
    expect(payment.references).toEqual({ [`payment_applications:${APPLICATION}`]: "Payment CHK-1042" });
    expect(proposalCardFrom({ ...view, subjectLabel: "" })).not.toHaveProperty("references");
    expect(proposalCardFrom({ ...view, subjectLabel: "   " })).not.toHaveProperty("references");
    expect(proposalCardFrom({ ...view, subjectLabel: null })).not.toHaveProperty("references");
  });
});
