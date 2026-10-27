import { describe, expect, it } from "vitest";
import type { ProposalView } from "@/lib/agent/view";
import { hrefOrNull, recordHref } from "@/lib/records/href";
import { FLAG_QUESTION, proposalCardFrom } from "./proposal-card-from";

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
