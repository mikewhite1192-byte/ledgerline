import { describe, expect, it } from "vitest";
import type { ProposalView } from "@/lib/agent/view";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import { FLAG_QUESTION, auditFor, proposalCardFrom } from "./proposal-card-from";

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
  destination: { label: "fuel card ···· 4417", last4: "4417", testMode: true },
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
      destination: { label: "To fuel card ···· 4417", testMode: true },
      confirmQuestion: "Pay $200.00 to BR-D07's fuel card ···· 4417? Test mode.",
    });
    expect(card.flagNote).toBeUndefined();
    expect(card.reasons).toEqual([{ text: view.reasons[0].text, source: { table: "drivers", id: DRIVER } }]);
  });

  it("says no card is on file, without Test mode, and asks the plain question", () => {
    const card = proposalCardFrom(noCard);
    expect(card.destination).toEqual({ label: "No fuel card on file", testMode: false });
    expect(card.confirmQuestion).toBe("Pay $200.00 to BR-D07?");
  });

  it("shows no destination for a kind that pays no card", () => {
    const card = proposalCardFrom({ ...view, kind: "pay_correction", destination: null });
    expect(card.destination).toBeUndefined();
    expect(card.confirmQuestion).toBeUndefined();
  });

  it("keeps the flag question on a flagged proposal even with a card on file", () => {
    const card = proposalCardFrom({ ...view, flagged: true, flagCategories: ["authority_claim"] });
    expect(card.confirmQuestion).toBe(FLAG_QUESTION);
    expect(card.destination).toEqual({ label: "To fuel card ···· 4417", testMode: true });
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

  it("lets a person resume only an approved advance payout, never one executing or another kind", () => {
    expect(proposalCardFrom({ ...view, status: "approved" }).canResume).toBe(true);
    expect(proposalCardFrom({ ...view, kind: "pay_correction", status: "approved" }).canResume).toBeUndefined();
    expect(proposalCardFrom({ ...view, kind: "invoice_fix", status: "approved" }).canResume).toBeUndefined();
    for (const status of ["proposed", "executing", "done", "failed", "unknown", "rejected"] as const) {
      expect(proposalCardFrom({ ...view, status }).canResume, status).toBeUndefined();
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
    const pay = "Pay $200.00 to BR-D07's fuel card ···· 4417? Test mode.";
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
    expect(card.confirmQuestion).toBe("Pay $200.00 to BR-D07's fuel card ···· 4417? Test mode.");
  });
});
