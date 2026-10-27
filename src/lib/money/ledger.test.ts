import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { isOutsideRecord, switchOn, validateDraft } from "./ledger";
import { payoutDraft } from "./test-fakes";
import type { MoneyDraft } from "./types";

const saved = { ...flags };
afterEach(() => {
  Object.assign(flags, saved);
});

describe("validateDraft", () => {
  it("accepts a whole draft and defaults the attempt to 1", () => {
    expect(validateDraft(payoutDraft())).toMatchObject({
      kind: "advance_payout",
      attempt: 1,
      proposalId: null,
      traceId: null,
      subjectStatuses: ["requested"],
    });
  });

  it("refuses every malformed field as validation", () => {
    const bad: Partial<MoneyDraft>[] = [
      { kind: "refund" as never },
      { subjectId: "not-a-uuid" },
      { counterpartyId: "33333333-3333-4333-8333-33333333333" },
      { amountCents: 0 },
      { amountCents: -1 },
      { amountCents: 1.5 },
      { amountCents: 1_000_000_000 },
      { attempt: 0 },
      { attempt: 21 },
      { proposedBy: "robot" as never },
      { proposalId: "x" },
      { traceId: "ABC" },
      { subjectStatuses: [] },
      { subjectStatuses: ["requested", "approve"] },
      { subjectStatuses: undefined },
      { kind: "customer_payment", subjectStatuses: ["requested"] },
      // No batch column yet, so any batch id is refused rather than dropped.
      { batchId: "44444444-4444-4444-8444-444444444444" },
      { batchId: "" },
    ];
    for (const over of bad) {
      expect(() => validateDraft(payoutDraft(over)), JSON.stringify(over)).toThrow(
        expect.objectContaining({ category: "validation" }),
      );
    }
    expect(validateDraft(payoutDraft({ kind: "customer_payment", subjectStatuses: undefined })))
      .toMatchObject({ subjectStatuses: null });
    expect(validateDraft(payoutDraft({ batchId: null }))).toMatchObject({ kind: "advance_payout" });
  });
});

describe("switchOn", () => {
  it("reads the channel's flag on every call", () => {
    flags.payoutsEnabled = false;
    flags.accountingEnabled = false;
    expect(switchOn("payment")).toBe(false);
    expect(switchOn("accounting")).toBe(false);
    flags.payoutsEnabled = true;
    expect(switchOn("payment")).toBe(true);
    expect(switchOn("accounting")).toBe(false);
  });
});

describe("isOutsideRecord", () => {
  const ok = { system: "mock", type: "payout", id: "mock_1", amountCents: 0 };
  it("checks every field whole", () => {
    expect(isOutsideRecord(ok)).toBe(true);
    expect(isOutsideRecord({ ...ok, ref: "INV-1" })).toBe(true);
    for (const bad of [
      { ...ok, system: "qbo" },
      { ...ok, type: "p" },
      { ...ok, id: "" },
      { ...ok, id: "x".repeat(121) },
      { ...ok, ref: "" },
      { ...ok, amountCents: -1 },
      { ...ok, amountCents: "5" },
      null,
    ]) {
      expect(isOutsideRecord(bad)).toBe(false);
    }
  });
});
