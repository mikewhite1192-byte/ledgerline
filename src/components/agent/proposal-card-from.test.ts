import { describe, expect, it } from "vitest";
import { advanceLoadOf, cardLoadOf } from "@/lib/agent/gateway/store/views";
import type { ProposalView } from "@/lib/agent/view";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import {
  FLAG_QUESTION,
  advanceLoadDetail,
  auditFor,
  cardLoadDetail,
  detentionLines,
  hoursMinutes,
  kindCopy,
  proposalCardFrom,
  verificationFor,
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

  it("quotes the advance at pickup's amount and the carrier's share, never the room left", () => {
    const load = { number: "BR-L10230", capCents: null, leftAfterCents: null, shareBps: 7_000 };
    const line = "Load BR-L10230 was picked up: $200.00 now, inside the 70% of trip pay the carrier allows on one load.";
    expect(advanceLoadDetail(load, 20_000)).toBe(line);
    expect(proposalCardFrom({ ...view, load }).detail).toBe(line);
    expect(advanceLoadDetail({ ...load, shareBps: 6_250 }, 41_500)).toBe(
      "Load BR-L10230 was picked up: $415.00 now, inside the 62.5% of trip pay the carrier allows on one load.",
    );
    // No amount to quote: the plain load line.
    expect(advanceLoadDetail(load)).toBe("For load BR-L10230.");
    expect(advanceLoadDetail(load, 0)).toBe("For load BR-L10230.");
  });

  it("reads an advance's load line back from its stored args, the pickup share only whole", () => {
    const args = (load: unknown) => JSON.stringify({ driverId: "d", load });
    const base = { number: "BR-L10230", capCents: null, leftAfterCents: null };
    expect(advanceLoadOf(args(base))).toEqual(base);
    expect(advanceLoadOf(args({ ...base, shareBps: 7_000 }))).toEqual({ ...base, shareBps: 7_000 });
    for (const shareBps of [0, 10_001, 12.5, "7000", null]) {
      expect(advanceLoadOf(args({ ...base, shareBps }))).toBeNull();
    }
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

  it("lets a person resume only an approved advance payout, pay correction or card match, never one executing or another kind", () => {
    expect(proposalCardFrom({ ...view, status: "approved" }).canResume).toBe(true);
    expect(proposalCardFrom({ ...view, kind: "pay_correction", status: "approved" }).canResume).toBe(true);
    // A card match left approved by a request that stopped before its executor ran.
    expect(proposalCardFrom({ ...view, kind: "card_match", status: "approved" }).canResume).toBe(true);
    expect(proposalCardFrom({ ...view, kind: "invoice_fix", status: "approved" }).canResume).toBeUndefined();
    for (const kind of ["advance_payout", "pay_correction", "card_match"] as const) {
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

describe("proposalCardFrom for a pay rule change", () => {
  const PERIOD = "22222222-2222-4222-8222-222222222222";
  const STUB_1 = "33333333-3333-4333-8333-333333333333";
  const STUB_2 = "44444444-4444-4444-8444-444444444444";
  const change: ProposalView = {
    ...view,
    id: "p-rule",
    kind: "pay_rule_change",
    subjectTable: "pay_configs",
    subjectId: "55555555-5555-4555-8555-555555555555",
    subjectLabel: null,
    amountCents: 2_400,
    direction: "in",
    title: "Change a pay rule",
    reasons: [],
    sources: [],
    operatorVerdict: "not_given",
    auditorVerdict: "pass",
    destination: null,
    ruleChange: {
      ruleKey: "insurance_per_day_cents",
      oldValue: 1_100,
      newValue: 1_200,
      askedFrom: "2026-11-04",
      effectiveFrom: "2026-11-09",
      snapped: true,
      applied: "new_version",
      appliesTo: "owner_operator",
      impact: {
        basis: "settled_week",
        periodId: PERIOD,
        periodStart: "2026-10-26",
        periodEnd: "2026-11-01",
        driversCompared: 9,
        driversChanged: 4,
        netDeltaCents: -2_400,
        ownerOperatorsOnly: true,
        top: [
          { driverId: DRIVER, code: "SF-D11", deltaCents: -700, settlementId: STUB_1 },
          { driverId: DRIVER, code: "SF-D14", deltaCents: -600, settlementId: STUB_2 },
        ],
      },
    },
  };
  const audit = { on: true, checking: false };

  it("titles the rule and both values, says when it starts and what it would have done to last week's pay", () => {
    const card = proposalCardFrom(change, audit, { admin: false, adminAboveCents: 200_000 });
    expect(card).toMatchObject({
      title: "Owner-operator insurance: $11.00 to $12.00 per day",
      impact: { cents: 2_400, direction: "none", label: "Would pay out less per week" },
      reasons: [
        {
          text: "Starts Monday, Nov 9 (the week of Nov 4 had already begun, so the change starts with the next full week)",
        },
        {
          text: "On last week's pay (Oct 26 to Nov 1) this would have paid 4 owner-operators $24.00 less in total; the largest change is $7.00 (Driver SF-D11).",
          source: { table: "settlements", id: STUB_1 },
          label: "Driver SF-D11's paystub",
        },
      ],
      sources: [
        { table: "settlement_periods", id: PERIOD, label: "Last week's pay (Oct 26 to Nov 1)" },
        { table: "settlements", id: STUB_2, label: "Driver SF-D14's paystub" },
      ],
      confirmQuestion: "Save this pay rule?",
      wording: { approve: "Save this pay rule", approving: "Saving", question: "Save this pay rule?", reject: "Not now" },
      footnote: "Nothing changes until you save it. Past weeks never change.",
      noOverride: true,
    });
    expect(card).not.toHaveProperty("approveBlockedLabel");
    expect(card).not.toHaveProperty("canResume");
  });

  it("asks a staff member above the admin amount to get an admin, and lets an admin save it", () => {
    const big = { ...change, amountCents: 200_001 };
    expect(proposalCardFrom(big, audit, { admin: false, adminAboveCents: 200_000 })).toMatchObject({
      approveBlockedLabel: "Ask an admin to save this (over $2,000 a week)",
    });
    expect(proposalCardFrom(big, audit, { admin: true, adminAboveCents: 200_000 })).not.toHaveProperty(
      "approveBlockedLabel",
    );
    // Once it is decided the button is gone, so there is nothing to ask for.
    expect(
      proposalCardFrom({ ...big, status: "done" }, audit, { admin: false, adminAboveCents: 200_000 }),
    ).not.toHaveProperty("approveBlockedLabel");
  });

  it("asks once more for anything but a pass, and links the saved change to the Pay rules page", () => {
    expect(proposalCardFrom({ ...change, auditorVerdict: "concerns" }, audit).confirmQuestion).toBe(
      "Double-check raised a question. Save this pay rule anyway?",
    );
    expect(proposalCardFrom({ ...change, auditorVerdict: null }, audit).confirmQuestion).toBe(
      "Not double-checked. Save this pay rule anyway?",
    );
    expect(proposalCardFrom({ ...change, flagged: true }, audit).confirmQuestion).toBe(
      "This came from a message that failed screening. Save this pay rule anyway?",
    );
    expect(proposalCardFrom({ ...change, status: "done" }, audit).statusNotes?.done).toEqual({
      text: "Saved. Starts with the week of Nov 9. See it under Pay rules.",
      link: { href: "/settings/pay-rules", label: "Pay rules" },
    });
    expect(proposalCardFrom({ ...change, status: "approved" }, audit)).toMatchObject({ canResume: true });
  });

  it("keeps the stored title and the amount when the figures do not read back", () => {
    const card = proposalCardFrom({ ...change, ruleChange: null }, audit);
    expect(card).toMatchObject({
      title: "Change a pay rule",
      impact: { cents: 2_400, direction: "none", label: "Would pay out less per week" },
      reasons: [],
      sources: [],
    });
    expect(proposalCardFrom({ ...change, ruleChange: null, direction: "none", amountCents: 0 }, audit).impact).toEqual({
      cents: 0,
      direction: "none",
      label: "No change to weekly pay",
    });
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

describe("a card load ruling card", () => {
  const ROW = "55555555-5555-4555-8555-555555555555";
  const args = JSON.stringify({ transactionId: ROW, cardLast4: "4417", postedOn: "2026-10-28", ruling: "deficit" });

  it("reads the card, the day and the driver's code from its stored args, never a value out of shape", () => {
    expect(cardLoadOf(args, "BR-D07")).toEqual({ last4: "4417", postedOn: "2026-10-28", driverCode: "BR-D07" });
    expect(cardLoadOf(args, null)).toEqual({ last4: "4417", postedOn: "2026-10-28", driverCode: null });
    expect(cardLoadOf(args, "not a code!")?.driverCode).toBeNull();
    expect(cardLoadOf(JSON.stringify({ cardLast4: "44", postedOn: "2026-10-28" }), "BR-D07")).toBeNull();
    expect(cardLoadOf("{", "BR-D07")).toBeNull();
    expect(cardLoadOf(null, "BR-D07")).toBeNull();
  });

  it("asks to book the load as money the driver owes and says nothing is paid or sent", () => {
    const cardLoad = { last4: "4417", postedOn: "2026-10-28", driverCode: "BR-D07" };
    const card = proposalCardFrom({
      ...view,
      kind: "card_load_ruling",
      subjectTable: "card_transactions",
      subjectId: ROW,
      subjectLabel: "card ending 4417",
      amountCents: 40_000,
      direction: "none",
      destination: null,
      cardLoad,
    });
    expect(card.confirmNoun).toBe("card load ruling");
    expect(card.confirmQuestion).toBe("Book this $400.00 card load as money driver BR-D07 owes?");
    expect(card.confirmNext).toBe("Books the load as money the driver owes. Nothing is paid or sent.");
    expect(card.detail).toBe(cardLoadDetail(cardLoad));
    expect(card.detail).toContain("Card ending 4417");
    expect(card.detail).toContain("Driver BR-D07's card.");
    const unnamed = proposalCardFrom({ ...view, kind: "card_load_ruling", amountCents: 40_000, destination: null, cardLoad: { ...cardLoad, driverCode: null } });
    expect(unnamed.confirmQuestion).toBe("Book this $400.00 card load as money the driver owes?");
    expect(cardLoadDetail(null)).toBeUndefined();
  });
});

describe("the verification label on the card", () => {
  const on = { on: true, checking: false };

  it("reads Verified only when the pay rules matched and the second check passed", () => {
    const card = proposalCardFrom({ ...view, engineCheck: "matched", engineHeld: false, auditorVerdict: "pass" }, on);
    expect(card.verification).toEqual({ state: "verified", line: "Your pay rules recomputed it and a second check agreed.", held: false });
    expect(proposalCardFrom({ ...view, engineCheck: "matched", engineHeld: false }, on).verification?.state).toBe("unverified");
    expect(proposalCardFrom({ ...view, engineCheck: "unavailable", engineHeld: false, auditorVerdict: "pass" }, on).verification?.state).toBe(
      "unverified",
    );
  });

  it("holds a mismatch for a person, and leaves the confirm question as it was", () => {
    const card = proposalCardFrom({ ...view, engineCheck: "mismatch", engineHeld: true, auditorVerdict: "pass" }, on);
    expect(card.verification).toMatchObject({ state: "mismatch", held: true });
    expect(card.confirmQuestion).toBe("Pay $200.00 to BR-D07's fuel card ending 4417?");
  });

  it("says the second check is off when the page reads it off", () => {
    expect(verificationFor({ ...view, engineCheck: "matched", engineHeld: false }, { on: false, checking: false })?.line).toBe(
      "Pay rules matched. Second check is off",
    );
  });

  it("carries a person's reason for approving over a mismatch, the time in the page's timezone", () => {
    const v = verificationFor(
      {
        ...view,
        status: "approved",
        engineCheck: "mismatch",
        engineHeld: false,
        engineOverride: { reason: "The rate sheet changed this week", byLabel: "an admin", at: "2026-10-28T15:00:00.000Z" },
      },
      { ...on, timezone: "UTC" },
    );
    expect(v).toMatchObject({ state: "mismatch", held: false, override: { reason: "The rate sheet changed this week", byLabel: "an admin" } });
    expect(v?.override?.at).toContain("UTC");
  });

  it("adds no label when the page did not read the engine check", () => {
    expect(proposalCardFrom(view, on)).not.toHaveProperty("verification");
    expect(verificationFor(view)).toBeUndefined();
  });
});

describe("a factoring card", () => {
  const INV_A = "22222222-2222-4222-8222-222222222222";
  const INV_B = "33333333-3333-4333-8333-333333333333";
  const factoring: ProposalView = {
    ...view,
    id: "p-f",
    kind: "factoring_request",
    subjectTable: "invoices",
    subjectId: INV_A,
    subjectLabel: null,
    amountCents: 152_745,
    direction: "in",
    title: "Factor invoices (Test mode)",
    reasons: [],
    sources: [{ table: "invoices", id: INV_A }],
    destination: { label: "bank", last4: null, testMode: true },
    cash: {
      kind: "factoring_request",
      shortCents: 140_000,
      advanceBps: 9000,
      feeBps: 250,
      invoices: [
        { invoiceId: INV_A, invoiceNumber: "INV-1042", balanceCents: 100_000, advanceCents: 90_000, feeCents: 2_500, netCents: 87_500, reserveCents: 10_000 },
        { invoiceId: INV_B, invoiceNumber: "INV-1043", balanceCents: 72_000, advanceCents: 64_800, feeCents: 1_800, netCents: 63_000, reserveCents: 7_200 },
      ],
    },
  };
  const withStatus = (requestStatus: string | null): ProposalView => ({
    ...factoring,
    cash: { ...(factoring.cash as Extract<NonNullable<ProposalView["cash"]>, { kind: "factoring_request" }>), requestStatus },
  });

  it("sums what is planned to come in now, what is held back and the fee from the engine's lines", () => {
    const card = proposalCardFrom(factoring);
    const texts = card.reasons.map((r) => r.text);
    expect(texts).toContain("Planned: $1,505.00 now, $172.00 held back until the customer pays, fee $43.00.");
    expect(texts).toContain("The factoring partner pays 90% up front and charges 2.5%, against a $1,400.00 short.");
    expect(texts.some((t) => t.startsWith("Factoring request:"))).toBe(false);
    expect(card.impact.label).toBe("Would come in before Friday");
  });

  it("says what the partner did once a request was sent, and never more than that", () => {
    const label = (s: string | null) => proposalCardFrom(withStatus(s)).impact.label;
    expect(label("funded")).toBe("Came in from the factoring partner (Test mode)");
    expect(label("partly_funded")).toBe("Part of this came in; see Factoring (Test mode)");
    expect(label("submitted")).toBe("Sent, not confirmed yet (Test mode)");
    expect(label("unknown")).toBe("Sent, not confirmed yet (Test mode)");
    expect(label("declined")).toBe("Nothing came in (Test mode)");
    expect(label("failed")).toBe("Nothing came in (Test mode)");
    // No request yet: the card's own status decides.
    expect(label(null)).toBe("Would come in before Friday");
  });

  it("adds one line naming the request's status in plain words", () => {
    const texts = proposalCardFrom(withStatus("partly_funded")).reasons.map((r) => r.text);
    expect(texts).toContain("Factoring request: Partly funded. The Factoring page shows each invoice. Test mode.");
    const unknown = proposalCardFrom(withStatus("unknown")).reasons.map((r) => r.text);
    expect(unknown).toContain("Factoring request: Sent, not confirmed yet. The Factoring page shows each invoice. Test mode.");
  });

  it("never says you receive a sum, before a request or after a part of it was declined", () => {
    for (const s of [null, "submitted", "unknown", "funded", "partly_funded", "declined", "failed"]) {
      const card = proposalCardFrom(withStatus(s));
      for (const t of [...card.reasons.map((r) => r.text), card.impact.label ?? ""]) expect(t, String(s)).not.toMatch(/you receive/i);
    }
  });

  it("lets a person resume a card left approved, or left executing with an invoice not sent yet", () => {
    const resume = (status: ProposalView["status"], requestStatus: string | null) =>
      proposalCardFrom({ ...withStatus(requestStatus), status }).canResume;
    // Stopped after the approval, before the request was written.
    expect(resume("approved", null)).toBe(true);
    // Stopped after the request was written, before every invoice went out.
    expect(resume("executing", "submitted")).toBe(true);
    // Waiting on the partner's answer: Check pending on the Factoring page, not Resume.
    expect(resume("executing", "unknown")).toBeUndefined();
    expect(resume("executing", null)).toBeUndefined();
    for (const status of ["proposed", "done", "failed", "unknown", "rejected", "expired"] as const) {
      expect(resume(status, "submitted"), status).toBeUndefined();
    }
    // No other kind resumes from executing.
    for (const kind of ["advance_payout", "pay_correction", "money_code", "card_match", "collections_chase"] as const) {
      expect(proposalCardFrom({ ...withStatus("submitted"), kind, status: "executing" }).canResume, kind).toBeUndefined();
    }
  });
});

describe("a parked advance's card", () => {
  const parkedView = (parked: ProposalView["parked"], over: Partial<ProposalView> = {}): ProposalView => ({
    ...view,
    status: "approved",
    parked,
    ...over,
  });

  it("says why it parked and lets staff approve it again", () => {
    const card = proposalCardFrom(parkedView({ reason: "no_room", on: true, adminOnly: false }), undefined, {
      admin: false,
      adminAboveCents: 50_000,
    });
    expect(card.parked).toEqual({
      line: "Parked: the pay rules no longer allow this amount. Approve again once they do, or reject.",
      releasable: true,
    });
  });

  it("leaves Approve again to an admin after an override, or for an amount over the admin line", () => {
    const staff = { admin: false, adminAboveCents: 50_000 };
    const override = proposalCardFrom(parkedView({ reason: "override", on: true, adminOnly: true }), undefined, staff);
    expect(override.parked?.releasable).toBe(false);
    expect(override.parked?.line).toContain("only an admin can approve it again");
    const admin = proposalCardFrom(parkedView({ reason: "override", on: true, adminOnly: true }), undefined, {
      admin: true,
      adminAboveCents: 50_000,
    });
    expect(admin.parked?.releasable).toBe(true);
    const large = proposalCardFrom(
      parkedView({ reason: "card_removed", on: true, adminOnly: false }, { amountCents: 60_000 }),
      undefined,
      staff,
    );
    expect(large.parked?.releasable).toBe(false);
  });

  it("offers only Reject with the switch off, and nothing parked on any other status or kind", () => {
    const off = proposalCardFrom(parkedView({ reason: "name_mismatch", on: false, adminOnly: false }));
    expect(off.parked).toEqual({
      line: "Parked advances are switched off, so nothing was paid. It can still be rejected.",
      releasable: false,
    });
    for (const status of ["proposed", "done", "failed", "rejected"] as const) {
      expect(proposalCardFrom(parkedView({ reason: "no_room", on: true, adminOnly: false }, { status })).parked).toBeUndefined();
    }
    expect(proposalCardFrom(parkedView(null)).parked).toBeUndefined();
    expect(
      proposalCardFrom(parkedView({ reason: "no_room", on: true, adminOnly: false }, { kind: "money_code" })).parked,
    ).toBeUndefined();
  });
});
