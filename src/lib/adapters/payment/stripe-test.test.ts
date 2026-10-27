import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../config/flags";
import { requestIdOf } from "../../money/keys";
import { scriptedFetch, type Answer } from "../accounting/qbo/test-fakes";
import { forgetMoneySecret, type SecretsClient } from "../secrets";
import type { SendContext } from "../types";
import { createStripeTestAdapter, isTestKey } from "./stripe-test";

// Keys are put together at run time so no scanner reads a key shape in this file.
const key = (...parts: string[]) => parts.join("_");
const TEST_KEY = key("sk", "test", "0".repeat(24));
const DESTINATION = "acct_TESTDESTINATION01";
const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const DRIVER = "0b9f3c1e-7d2a-4c55-9e10-3a4b5c6d7e8f";
const REQUEST = requestIdOf(ACTION);
const GROUP = `ll_${REQUEST}`;

const saved = { ...flags };
const ctx: SendContext = { requestId: REQUEST, timeoutMs: 1_000, tenantZone: "America/Chicago" };
const payout = { actionId: ACTION, driverId: DRIVER, amountCents: 12_345, memoCode: "PAY-settlements-1" };
const env = (over: Record<string, string | undefined> = {}) =>
  ({ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_TEST_DESTINATION_ACCOUNT: DESTINATION, ...over }) as unknown as NodeJS.ProcessEnv;
const transfer = (over: Record<string, unknown> = {}) => ({
  object: "transfer",
  id: "tr_TEST0000000001",
  amount: 12_345,
  currency: "usd",
  transfer_group: GROUP,
  metadata: { ledgerline_action: ACTION },
  reversed: false,
  ...over,
});

function make(answers: Answer[], e = env(), secrets?: SecretsClient) {
  const { fetch, sent } = scriptedFetch(answers);
  const lines: string[] = [];
  const adapter = createStripeTestAdapter({ env: e, fetch, secrets, log: (l) => lines.push(l) });
  return { adapter, sent, lines };
}

beforeEach(() => {
  flags.payoutsEnabled = true;
  flags.paymentProvider = "stripe_test";
});

afterEach(() => {
  Object.assign(flags, saved);
  forgetMoneySecret();
});

describe("Stripe test payouts: keys and switches", () => {
  it("takes only a test secret key", () => {
    expect(isTestKey(TEST_KEY)).toBe(true);
    for (const bad of [key("sk", "live", "0".repeat(24)), key("rk", "live", "0".repeat(24)), key("rk", "test", "0".repeat(24)), key("pk", "test", "0".repeat(24)), "", null]) {
      expect(isTestKey(bad), String(bad)).toBe(false);
    }
  });

  it("refuses with the switch off, the mock provider, a live key or no destination, sending nothing", async () => {
    const cases: [() => void, NodeJS.ProcessEnv, string][] = [
      [() => (flags.payoutsEnabled = false), env(), "disabled"],
      [() => (flags.paymentProvider = "mock"), env(), "not_configured"],
      [() => {}, env({ STRIPE_SECRET_KEY: key("sk", "live", "0".repeat(24)) }), "not_configured"],
      [() => {}, env({ STRIPE_SECRET_KEY: undefined }), "not_configured"],
      [() => {}, env({ STRIPE_TEST_DESTINATION_ACCOUNT: "acct-1" }), "not_configured"],
    ];
    for (const [arrange, e, category] of cases) {
      Object.assign(flags, saved, { payoutsEnabled: true, paymentProvider: "stripe_test" });
      arrange();
      const { adapter, sent, lines } = make([], e);
      expect(await adapter.ready(), category).toEqual({ ok: false, category });
      expect(await adapter.sendPayout(payout, ctx)).toEqual({ kind: "failed", category });
      expect(sent).toHaveLength(0);
      expect(lines.join("\n")).not.toContain("0".repeat(24));
    }
  });

  it("refuses a request id that is not the action's before anything else", async () => {
    const { adapter, sent } = make([]);
    expect(await adapter.sendPayout(payout, { ...ctx, requestId: requestIdOf(DRIVER) })).toEqual({
      kind: "failed",
      category: "validation",
    });
    expect(await adapter.sendPayout({ ...payout, amountCents: 0 }, ctx)).toEqual({ kind: "failed", category: "validation" });
    expect(sent).toHaveLength(0);
  });
});

describe("Stripe test payouts: sending", () => {
  it("posts one transfer keyed by the ledger's request id and confirms only our transfer", async () => {
    const { adapter, sent } = make([{ status: 200, body: transfer() }]);
    expect(await adapter.sendPayout(payout, ctx)).toEqual({
      kind: "confirmed",
      system: "stripe_test",
      type: "transfer",
      id: "tr_TEST0000000001",
      amountCents: 12_345,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].url.toString()).toBe("https://api.stripe.com/v1/transfers");
    expect(sent[0].method).toBe("POST");
    expect(sent[0].headers["Idempotency-Key"]).toBe(REQUEST);
    expect(sent[0].headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(Object.fromEntries(new URLSearchParams(sent[0].body ?? ""))).toEqual({
      amount: "12345",
      currency: "usd",
      destination: DESTINATION,
      transfer_group: GROUP,
      "metadata[ledgerline_action]": ACTION,
      description: "LedgerLine driver payout",
    });
  });

  it("maps every answer to failed or unknown from the status alone", async () => {
    const cases: [Answer, unknown][] = [
      [{ status: 400, body: { error: { type: "idempotency_error" } } }, { kind: "failed", category: "duplicate", httpStatus: 400 }],
      [{ status: 400, body: { error: { type: "invalid_request_error", code: "amount_too_small" } } }, { kind: "failed", category: "validation", httpStatus: 400 }],
      [{ status: 402, body: {} }, { kind: "failed", category: "validation", httpStatus: 402 }],
      [{ status: 403, body: {} }, { kind: "failed", category: "auth", httpStatus: 403 }],
      [{ status: 429, body: {} }, { kind: "failed", category: "rate_limited", httpStatus: 429 }],
      [{ status: 404, body: {} }, { kind: "unknown", category: "unknown", httpStatus: 404 }],
      [{ status: 409, body: {} }, { kind: "unknown", category: "unknown", httpStatus: 409 }],
      [{ status: 500, body: {} }, { kind: "unknown", category: "unavailable", httpStatus: 500 }],
      [{ status: 200, body: transfer({ transfer_group: "ll_other" }) }, { kind: "unknown", category: "unknown" }],
      [{ status: 200, body: transfer({ amount: 12_345.5 }) }, { kind: "unknown", category: "unknown" }],
      [{ status: 200, body: transfer({ reversed: true }) }, { kind: "unknown", category: "unknown" }],
      [{ throws: "TimeoutError" }, { kind: "unknown", category: "timeout" }],
      [{ throws: "TypeError" }, { kind: "unknown", category: "network" }],
    ];
    for (const [answer, expected] of cases) {
      const { adapter, lines } = make([answer]);
      expect(await adapter.sendPayout(payout, ctx), JSON.stringify(answer)).toEqual(expected);
      expect(lines.join("\n")).not.toContain(TEST_KEY);
    }
  });

  it("reads the key from Secrets Manager in production and reads it again after a 401", async () => {
    const reads: string[] = [];
    const secrets: SecretsClient = {
      async send(command) {
        reads.push(String(command.input.SecretId));
        return { SecretString: TEST_KEY };
      },
    };
    const prod = env({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_SECRET_KEY_SECRET_NAME: "test/stripe-key",
      DB_CLUSTER_ARN: "test-cluster",
    });
    const { adapter } = make([{ status: 200, body: transfer() }, { status: 401, body: {} }, { status: 200, body: transfer() }], prod, secrets);
    await adapter.sendPayout(payout, ctx);
    expect(reads).toEqual(["test/stripe-key"]);
    expect(await adapter.sendPayout(payout, ctx)).toEqual({ kind: "failed", category: "auth", httpStatus: 401 });
    await adapter.sendPayout(payout, ctx);
    expect(reads).toEqual(["test/stripe-key", "test/stripe-key"]);
  });
});

describe("Stripe test payouts: read-back", () => {
  const ref = (outsideId: string | null) => ({ payout, requestId: REQUEST, outsideId });

  it("reads by id, even with payouts switched off, and never posts", async () => {
    flags.payoutsEnabled = false;
    const { adapter, sent } = make([{ status: 200, body: transfer() }]);
    expect(await adapter.readBack(ref("tr_TEST0000000001"), ctx)).toEqual({
      found: true,
      system: "stripe_test",
      type: "transfer",
      id: "tr_TEST0000000001",
      amountCents: 12_345,
      status: "succeeded",
    });
    expect(sent[0].method).toBe("GET");
    expect(sent[0].url.pathname).toBe("/v1/transfers/tr_TEST0000000001");
  });

  it("finds by our transfer group when the id is unknown", async () => {
    const one = make([{ status: 200, body: { object: "list", data: [transfer({ reversed: true })] } }]);
    expect(await one.adapter.readBack(ref(null), ctx)).toMatchObject({ found: true, status: "canceled" });
    expect(Object.fromEntries(one.sent[0].url.searchParams)).toEqual({ transfer_group: GROUP, limit: "3" });

    const none = make([{ status: 200, body: { object: "list", data: [] } }]);
    expect(await none.adapter.readBack(ref(null), ctx)).toEqual({ found: false });

    const two = make([{ status: 200, body: { object: "list", data: [transfer(), transfer({ id: "tr_TEST0000000002" })] } }]);
    await expect(two.adapter.readBack(ref(null), ctx)).rejects.toMatchObject({ category: "duplicate" });
  });

  it("answers not found for a 404 by id and throws on anything unreadable", async () => {
    const gone = make([{ status: 404, body: {} }]);
    expect(await gone.adapter.readBack(ref("tr_TEST0000000001"), ctx)).toEqual({ found: false });
    const other = make([{ status: 200, body: transfer({ metadata: { ledgerline_action: DRIVER } }) }]);
    await expect(other.adapter.readBack(ref("tr_TEST0000000001"), ctx)).rejects.toMatchObject({ category: "unknown" });
    const down = make([{ status: 503, body: {} }]);
    await expect(down.adapter.readBack(ref(null), ctx)).rejects.toMatchObject({ category: "unavailable" });
    const bad = make([]);
    await expect(bad.adapter.readBack(ref("not-an-id"), ctx)).rejects.toMatchObject({ category: "validation" });
  });
});
