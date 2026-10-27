import { describe, expect, it } from "vitest";
import type { ProposalView } from "@/lib/agent/view";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import { FLAG_QUESTION, auditFor, detentionLines, hoursMinutes, proposalCardFrom } from "./proposal-card-from";

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
};

describe("proposalCardFrom", () => {
  it("builds the card from fixed words and the engine's cents", () => {
    const card = proposalCardFrom(view);
    expect(card).toMatchObject({
      id: "p-1",
      title: "Pay advance for BR-D07",
      impact: { cents: 20_000, direction: "out" },
      status: "proposed",
      confirmQuestion: "Pay $200.00 to BR-D07?",
    });
    expect(card.flagNote).toBeUndefined();
    expect(card.reasons).toEqual([{ text: view.reasons[0].text, source: { table: "drivers", id: DRIVER } }]);
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
      text: "The amount does not match the rules engine's number.",
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
    expect(concerns.confirmQuestion).toBe("Muse Wonder has a concern (source missing). Approve anyway?");
    expect(proposalCardFrom({ ...view, auditorVerdict: "unknown" }, on).confirmQuestion).toBe(
      "Not checked by the auditor. Approve anyway?",
    );
    // No verdict yet reads as not checked.
    expect(proposalCardFrom(view, on).confirmQuestion).toBe("Not checked by the auditor. Approve anyway?");
    expect(proposalCardFrom({ ...view, auditorVerdict: "pass" }, on).confirmQuestion).toBe("Pay $200.00 to BR-D07?");
    expect(proposalCardFrom({ ...view, auditorVerdict: "block" }, on).confirmQuestion).toBe("Pay $200.00 to BR-D07?");
  });

  it("lets the flag question win over the audit question", () => {
    const card = proposalCardFrom({ ...view, flagged: true, auditorVerdict: "concerns", auditorConcerns: ["flagged_input"] }, on);
    expect(card.confirmQuestion).toBe(FLAG_QUESTION);
  });

  it("adds no audit line and no audit question without the page's audit context", () => {
    const card = proposalCardFrom({ ...view, auditorVerdict: "concerns", auditorConcerns: ["source_missing"] });
    expect(card).not.toHaveProperty("audit");
    expect(card.confirmQuestion).toBe("Pay $200.00 to BR-D07?");
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
    expect(card.confirmQuestion).toBeUndefined();
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
