import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretsClient } from "../adapters/secrets";
import { REFRESH_MIN_MS, forgetInternalKey, internalKey, keyMatches } from "./internal-key";

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

  it("keeps the read, and reads again on a fresh ask only when the kept one is a minute old", async () => {
    const NEW = "Rq7".repeat(16);
    let stored = KEY;
    const client = secrets(async () => ({ SecretString: stored }));
    const env = { ...PROD, SWEEP_INTERNAL_KEY_SECRET_NAME: "payday-copilot/sweep-internal-key" };
    let clock = 1_000_000;
    const deps = { env, secrets: client, log: vi.fn(), now: () => clock };
    await expect(internalKey(deps)).resolves.toBe(KEY);
    stored = NEW;
    // Kept: a plain read never goes back to the store.
    await expect(internalKey(deps)).resolves.toBe(KEY);
    // A fresh ask inside the minute is throttled.
    clock += REFRESH_MIN_MS - 1;
    await expect(internalKey(deps, { fresh: true })).resolves.toBe(KEY);
    expect(client.send).toHaveBeenCalledTimes(1);
    // A minute on, the fresh ask reads the rotated key and keeps it.
    clock += 1;
    await expect(internalKey(deps, { fresh: true })).resolves.toBe(NEW);
    await expect(internalKey(deps)).resolves.toBe(NEW);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("answers null when the fresh read fails, and reads again next time", async () => {
    let fail = false;
    const client = secrets(async () => (fail ? Promise.reject(new Error("down")) : { SecretString: KEY }));
    const env = { ...PROD, SWEEP_INTERNAL_KEY_SECRET_NAME: "payday-copilot/sweep-internal-key" };
    let clock = 1_000_000;
    const deps = { env, secrets: client, log: vi.fn(), now: () => clock };
    await expect(internalKey(deps)).resolves.toBe(KEY);
    fail = true;
    clock += REFRESH_MIN_MS;
    await expect(internalKey(deps, { fresh: true })).resolves.toBeNull();
    fail = false;
    await expect(internalKey(deps)).resolves.toBe(KEY);
    expect(client.send).toHaveBeenCalledTimes(3);
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
