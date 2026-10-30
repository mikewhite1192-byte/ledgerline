import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../config/flags";
import { requestIdOf } from "../../money/keys";
import { MoneyError } from "../../money/types";
import { accountingAdapter, paymentAdapter } from "../index";
import { createMockPaymentAdapter } from "./mock";

const saved = { ...flags };
const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const OTHER = "0b9f3c1e-7d2a-4c55-9e10-3a4b5c6d7e8f";
const DRIVER = "33333333-3333-4333-8333-333333333333";
const payout = (actionId = ACTION, amountCents = 25_000) => ({
  actionId,
  driverId: DRIVER,
  amountCents,
  memoCode: `advances:${OTHER}`,
  rail: "bank" as const,
});
const ctx = (actionId = ACTION) => ({
  requestId: requestIdOf(actionId),
  timeoutMs: 1_000,
  tenantZone: "America/Chicago",
});

function make() {
  const lines: string[] = [];
  let n = 0;
  const mock = createMockPaymentAdapter({
    log: (l) => lines.push(l),
    newId: () => `mock_${String(++n).padStart(16, "0")}`,
  });
  return { mock, lines };
}

beforeEach(() => {
  flags.payoutsEnabled = true;
  flags.paymentProvider = "mock";
});

afterEach(() => {
  Object.assign(flags, saved);
});

describe("mock payment adapter", () => {
  it("is ready only while payoutsEnabled is on", async () => {
    const { mock } = make();
    expect(await mock.ready()).toEqual({ ok: true });
    flags.payoutsEnabled = false;
    expect(await mock.ready()).toEqual({ ok: false, category: "disabled" });
  });

  it("replays a repeated request id instead of paying twice", async () => {
    const { mock, lines } = make();
    const a = await mock.sendPayout(payout(), ctx());
    const b = await mock.sendPayout(payout(), ctx());
    expect(a).toEqual({
      kind: "confirmed",
      system: "mock",
      type: "payout",
      id: "mock_0000000000000001",
      amountCents: 25_000,
    });
    expect(b).toEqual(a);
    expect(mock.createdCount).toBe(1);
    expect(lines).toEqual([`money: mock payout mock_0000000000000001 25000c for advances:${OTHER}`]);
    const c = await mock.sendPayout(payout(OTHER), ctx(OTHER));
    expect(c).toMatchObject({ id: "mock_0000000000000002" });
  });

  it("refuses at send when the switch is off, and creates nothing", async () => {
    const { mock } = make();
    flags.payoutsEnabled = false;
    expect(await mock.sendPayout(payout(), ctx())).toEqual({ kind: "failed", category: "disabled" });
    expect(mock.createdCount).toBe(0);
    await expect(
      mock.readBack({ requestId: requestIdOf(ACTION), payout: payout() }, ctx()),
    ).rejects.toMatchObject({ category: "disabled" });
  });

  it("refuses a request id that is not the action's, compared whole", async () => {
    const { mock } = make();
    expect(await mock.sendPayout(payout(), ctx(OTHER))).toEqual({
      kind: "failed",
      category: "validation",
    });
    const shortened = { ...ctx(), requestId: requestIdOf(ACTION).slice(0, 31) };
    expect((await mock.sendPayout(payout(), shortened)).kind).toBe("failed");
    expect((await mock.sendPayout(payout(ACTION, 0), ctx())).kind).toBe("failed");
    expect((await mock.sendPayout(payout(ACTION, 1.5), ctx())).kind).toBe("failed");
    expect(mock.createdCount).toBe(0);
  });

  it("fails the next send with the given category, then works", async () => {
    const { mock } = make();
    mock.failNext("rate_limited");
    expect(await mock.sendPayout(payout(), ctx())).toEqual({
      kind: "failed",
      category: "rate_limited",
    });
    expect((await mock.sendPayout(payout(), ctx())).kind).toBe("confirmed");
  });

  it("confirmSilently records the payout and throws; the read-back finds that same payout", async () => {
    const { mock } = make();
    mock.confirmSilently();
    await expect(mock.sendPayout(payout(), ctx())).rejects.toBeInstanceOf(MoneyError);
    const rb = await mock.readBack({ requestId: requestIdOf(ACTION), payout: payout() }, ctx());
    expect(rb).toEqual({
      found: true,
      system: "mock",
      type: "payout",
      id: "mock_0000000000000001",
      amountCents: 25_000,
      status: "succeeded",
    });
    expect(mock.createdCount).toBe(1);
  });

  it("hangNext never answers", async () => {
    const { mock } = make();
    mock.hangNext();
    const race = await Promise.race([
      mock.sendPayout(payout(), ctx()),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 10)),
    ]);
    expect(race).toBe("still waiting");
    expect(mock.createdCount).toBe(0);
  });
});

describe("adapter selection", () => {
  it("uses the mock for bank payouts on the mock provider; Stripe test and the sandbox refuse with no settings", async () => {
    expect(paymentAdapter("bank").system).toBe("mock");
    expect(paymentAdapter("bank")).toBe(paymentAdapter("bank"));
    flags.paymentProvider = "stripe_test";
    const stripe = paymentAdapter("bank");
    expect(stripe.system).toBe("stripe_test");
    expect(paymentAdapter("bank")).toBe(stripe);
    expect(await stripe.ready()).toEqual({ ok: false, category: "not_configured" });
    expect(await stripe.sendPayout(payout(), ctx())).toEqual({
      kind: "failed",
      category: "not_configured",
    });
    const accounting = accountingAdapter();
    flags.accountingEnabled = false;
    expect(await accounting.ready(null as never)).toEqual({ ok: false, category: "disabled" });
    flags.accountingEnabled = true;
    expect(await accounting.ready(null as never)).toEqual({ ok: false, category: "not_configured" });
  });
});
