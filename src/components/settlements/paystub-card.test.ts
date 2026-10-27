import { describe, expect, it } from "vitest";
import { FLAG_QUESTION } from "@/components/agent/proposal-card-from";
import type { ProposalView } from "@/lib/agent/view";
import { NO_PAYOUT_QUESTION, paystubCardFrom } from "./paystub-card";

const SETTLEMENT = "22222222-2222-4222-8222-222222222222";

const card: ProposalView = {
  id: "p-1",
  kind: "settlement_approve",
  subjectTable: "settlements",
  subjectId: SETTLEMENT,
  subjectLabel: "BR-D07",
  amountCents: 0,
  direction: "out",
  title: "Approve paystub",
  reasons: [],
  sources: [],
  status: "proposed",
  flagged: false,
  flagCategories: [],
  operatorVerdict: "engine",
  auditorVerdict: "pass",
  auditorConcerns: [],
  auditorCheckedAt: "2026-11-02T16:00:00.000Z",
  auditorOverride: null,
  destination: null,
};

const audit = { on: true, checking: false };

describe("paystubCardFrom", () => {
  it("asks the no-payout question on a $0 paystub that the auditor passed and nothing flagged", () => {
    expect(paystubCardFrom(card, audit, 0).confirmQuestion).toBe(NO_PAYOUT_QUESTION);
  });

  it("keeps the flag question on a flagged $0 paystub", () => {
    const out = paystubCardFrom({ ...card, flagged: true, flagCategories: ["injection"] }, audit, 0);
    expect(out.confirmQuestion).toBe(FLAG_QUESTION);
  });

  it("keeps the auditor's question on a $0 paystub it did not pass", () => {
    const concerns = paystubCardFrom({ ...card, auditorVerdict: "concerns", auditorConcerns: ["amount"] }, audit, 0);
    expect(concerns.confirmQuestion).toMatch(/Approve anyway\?$/);
    expect(concerns.confirmQuestion).not.toBe(NO_PAYOUT_QUESTION);
    const unchecked = paystubCardFrom({ ...card, auditorVerdict: null, auditorCheckedAt: null }, audit, 0);
    expect(unchecked.confirmQuestion).toBe("Not checked by the auditor. Approve anyway?");
  });

  it("leaves a paystub with money to send as the shared card builds it", () => {
    const paid = { ...card, amountCents: 125_000 };
    expect(paystubCardFrom(paid, audit, 125_000).confirmQuestion).toBeUndefined();
  });
});
