import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretsClient } from "../adapters/secrets";
import { forgetInternalKey, internalKey, keyMatches } from "./internal-key";

const KEY = "Zk3".repeat(16);
const PROD = { DB_CLUSTER_ARN: "arn:aws:rds:us-east-2:000000000000:cluster:example" };

function secrets(answer: () => Promise<{ SecretString?: string }>) {
  return { send: vi.fn(answer) } as unknown as SecretsClient & { send: ReturnType<typeof vi.fn> };
}

afterEach(() => forgetInternalKey());

describe("internalKey", () => {
  it("reads the raw key locally, and only a usable one", async () => {
    await expect(internalKey({ env: { SWEEP_INTERNAL_KEY: KEY } })).resolves.toBe(KEY);
    await expect(internalKey({ env: { SWEEP_INTERNAL_KEY: "short" } })).resolves.toBeNull();
    await expect(internalKey({ env: { SWEEP_INTERNAL_KEY: `${"a".repeat(20)} ${"b".repeat(20)}` } })).resolves.toBeNull();
    await expect(internalKey({ env: {} })).resolves.toBeNull();
  });

  it("refuses the raw key in production and reads Secrets Manager by name", async () => {
    const log = vi.fn();
    await expect(internalKey({ env: { ...PROD, SWEEP_INTERNAL_KEY: KEY }, log })).resolves.toBeNull();
    expect(log.mock.calls[0][0]).not.toContain(KEY);

    const client = secrets(async () => ({ SecretString: KEY }));
    const env = { ...PROD, SWEEP_INTERNAL_KEY_SECRET_NAME: "payday-copilot/sweep-internal-key" };
    await expect(internalKey({ env, secrets: client, log })).resolves.toBe(KEY);
    expect(client.send.mock.calls[0][0].input).toEqual({ SecretId: "payday-copilot/sweep-internal-key" });
  });

  it("answers null, logging the error's name only, when the secret is missing, short or unreadable", async () => {
    const log = vi.fn();
    const env = { ...PROD, SWEEP_INTERNAL_KEY_SECRET_NAME: "payday-copilot/sweep-internal-key" };
    await expect(internalKey({ env: PROD, log })).resolves.toBeNull();
    await expect(internalKey({ env, secrets: secrets(async () => ({ SecretString: "short" })), log })).resolves.toBeNull();
    const boom = Object.assign(new Error("secret text here"), { name: "ResourceNotFoundException" });
    await expect(internalKey({ env, secrets: secrets(async () => Promise.reject(boom)), log })).resolves.toBeNull();
    const lines = log.mock.calls.map((c) => c[0] as string);
    expect(lines.at(-1)).toBe("sweep: the internal key secret is unreadable (ResourceNotFoundException)");
    expect(lines.join("\n")).not.toContain("secret text here");
  });
});

describe("keyMatches", () => {
  it("matches the whole key only", () => {
    expect(keyMatches(KEY, KEY)).toBe(true);
    expect(keyMatches(KEY.slice(0, -1), KEY)).toBe(false);
    expect(keyMatches(`${KEY}x`, KEY)).toBe(false);
    expect(keyMatches(KEY.toLowerCase(), KEY)).toBe(false);
  });

  it("refuses a missing, empty or oversized header", () => {
    expect(keyMatches(null, KEY)).toBe(false);
    expect(keyMatches("", KEY)).toBe(false);
    expect(keyMatches("a".repeat(513), KEY)).toBe(false);
  });
});
