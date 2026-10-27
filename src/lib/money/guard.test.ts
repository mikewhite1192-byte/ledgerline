import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../../instrumentation";
import { SECRET_SOURCES } from "../adapters/secrets";
import { assertMoneyEnvSafe, MoneyEnvRefused, RAW_SECRET_VARIABLES } from "./guard";

// Keys are put together at run time so no scanner reads a key shape in this file.
const key = (...parts: string[]) => parts.join("_");
const off = { accountingEnabled: false, paymentProvider: "mock", payoutsEnabled: false } as const;
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

function refusal(vars: Record<string, string>, f: Parameters<typeof assertMoneyEnvSafe>[1] = off) {
  try {
    assertMoneyEnvSafe(env(vars), f);
  } catch (err) {
    if (!(err instanceof MoneyEnvRefused)) throw err;
    return err;
  }
  return null;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("money start-up guard", () => {
  it("passes an empty environment and says what is on", () => {
    expect(assertMoneyEnvSafe(env({}), off)).toBe("money: guard ok (qbo sandbox only, payouts off, accounting off)");
    expect(
      assertMoneyEnvSafe(env({ STRIPE_SECRET_KEY: key("sk", "test", "0".repeat(24)), QBO_ENVIRONMENT: "sandbox" }), {
        accountingEnabled: false,
        paymentProvider: "stripe_test",
        payoutsEnabled: true,
      }),
    ).toBe("money: guard ok (qbo sandbox only, payouts stripe_test, accounting off)");
  });

  it("refuses a production QuickBooks environment, naming the variable and not the value", () => {
    const err = refusal({ QBO_ENVIRONMENT: "production" });
    expect(err?.variable).toBe("QBO_ENVIRONMENT");
    expect(err?.message).not.toContain("production");
  });

  it("refuses live and non-secret Stripe keys without echoing them", () => {
    for (const [value, why] of [
      [key("sk", "live", "0".repeat(24)), "is a live key"],
      [key("rk", "live", "0".repeat(24)), "is a live key"],
      [key("rk", "test", "0".repeat(24)), "is not a test secret key"],
      [key("pk", "test", "0".repeat(24)), "is not a test secret key"],
      ["whatever-was-pasted", "is not a test secret key"],
    ]) {
      const err = refusal({ STRIPE_SECRET_KEY: value });
      expect(err?.variable).toBe("STRIPE_SECRET_KEY");
      expect(err?.message).toContain(why);
      expect(err?.message).not.toContain(value);
    }
  });

  it("with accounting on, needs the sandbox and a company id", () => {
    const on = { ...off, accountingEnabled: true };
    expect(refusal({}, on)?.variable).toBe("QBO_ENVIRONMENT");
    expect(refusal({ QBO_ENVIRONMENT: "sandbox" }, on)?.variable).toBe("QBO_ALLOWED_REALM_ID");
    expect(refusal({ QBO_ENVIRONMENT: "sandbox", QBO_ALLOWED_REALM_ID: "12345" }, on)?.variable).toBe(
      "QBO_ALLOWED_REALM_ID",
    );
    expect(refusal({ QBO_ENVIRONMENT: "sandbox", QBO_ALLOWED_REALM_ID: "1234567890123456" }, on)).toBeNull();
  });

  it("refuses every raw secret in production", () => {
    expect(refusal({ DB_CLUSTER_ARN: "test-cluster" })).toBeNull();
    for (const raw of RAW_SECRET_VARIABLES) {
      const value = raw === "STRIPE_SECRET_KEY" ? key("sk", "test", "0".repeat(24)) : "x".repeat(32);
      expect(refusal({ DB_CLUSTER_ARN: "test-cluster", [raw]: value })?.variable).toBe(raw);
    }
  });

  it("names the same raw secret variables the adapters read", () => {
    expect([...RAW_SECRET_VARIABLES].sort()).toEqual(Object.values(SECRET_SOURCES).map((s) => s.raw).sort());
  });

  // A rejected register() does not stop the process: Next keeps the rejection and answers every
  // request 500 while the process runs, so the refusal still fails closed.
  it("runs in Node only, and a refusal rejects register()", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("QBO_ENVIRONMENT", "production");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await expect(register()).rejects.toBeInstanceOf(MoneyEnvRefused);
    vi.stubEnv("QBO_ENVIRONMENT", "sandbox");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("DB_CLUSTER_ARN", "");
    await expect(register()).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^money: guard ok/));
  });
});
