import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { DEMO_CARRIERS } from "../seed/carriers";
import { demoCarriersOnly, isOutsideRecord, payoutSwitchOn, switchOn, validateDraft } from "./ledger";
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
      // A batch id is a lowercase UUID or nothing.
      { batchId: "4444444A-4444-4444-8444-444444444444" },
      { batchId: "" },
    ];
    for (const over of bad) {
      expect(() => validateDraft(payoutDraft(over)), JSON.stringify(over)).toThrow(
        expect.objectContaining({ category: "validation" }),
      );
    }
    expect(validateDraft(payoutDraft({ kind: "customer_payment", subjectStatuses: undefined })))
      .toMatchObject({ subjectStatuses: null });
    expect(validateDraft(payoutDraft({ batchId: null }))).toMatchObject({ batchId: null });
    expect(
      validateDraft(payoutDraft({ batchId: "44444444-4444-4444-8444-444444444444" })),
    ).toMatchObject({ batchId: "44444444-4444-4444-8444-444444444444" });
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

describe("payoutSwitchOn", () => {
  const [demo] = DEMO_CARRIERS;
  const row = { slug: demo.slug, name: demo.name, timezone: demo.timezone };

  it("runs a bank payout in Stripe test mode for the demo carriers only, and leaves every other payout as it was", () => {
    expect(demoCarriersOnly("settlement_payout", "stripe_test")).toBe(true);
    expect(demoCarriersOnly("settlement_payout", "mock")).toBe(false);
    expect(demoCarriersOnly("advance_payout", "stripe_test")).toBe(false);
    expect(demoCarriersOnly("advance_payout", "fuel_card_sim")).toBe(false);
    flags.payoutsEnabled = true;
    expect(payoutSwitchOn("settlement_payout", "stripe_test", row)).toBe(true);
    // Another carrier, one that only took a demo slug, and no tenant row at all read as off.
    expect(payoutSwitchOn("settlement_payout", "stripe_test", { ...row, slug: "another-carrier" })).toBe(false);
    expect(payoutSwitchOn("settlement_payout", "stripe_test", { ...row, name: "Another Carrier" })).toBe(false);
    expect(payoutSwitchOn("settlement_payout", "stripe_test", { ...row, timezone: "UTC" })).toBe(false);
    expect(payoutSwitchOn("settlement_payout", "stripe_test", null)).toBe(false);
    // The mock and the card rail do not depend on the carrier.
    expect(payoutSwitchOn("settlement_payout", "mock", null)).toBe(true);
    expect(payoutSwitchOn("advance_payout", "fuel_card_sim", null)).toBe(true);
    // Off is off for everyone, demo carriers included.
    flags.payoutsEnabled = false;
    expect(payoutSwitchOn("settlement_payout", "stripe_test", row)).toBe(false);
    expect(payoutSwitchOn("settlement_payout", "mock", null)).toBe(false);
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
