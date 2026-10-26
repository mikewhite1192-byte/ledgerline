import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretsClient } from "./keys";

const KEY = "test-key-abcdefghijklmnop";
const SECRET_NAME = "payday-copilot/meta-api-key";

// keys.ts caches per server process, so each test loads a fresh copy.
async function load() {
  vi.resetModules();
  return import("./keys");
}

function fakeSecrets(...answers: (string | Error)[]) {
  const send = vi.fn<SecretsClient["send"]>(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { SecretString: next };
  });
  return { send };
}

let logged: string[];

beforeEach(() => {
  logged = [];
  const record = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(console, "log").mockImplementation(record);
  vi.stubEnv("DB_CLUSTER_ARN", "");
  vi.stubEnv("META_API_KEY", "");
  vi.stubEnv("META_API_KEY_SECRET_NAME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("apiKey, local", () => {
  it("reads the raw variable, trimmed, and never Secrets Manager", async () => {
    const { apiKey } = await load();
    const secrets = fakeSecrets(KEY);
    vi.stubEnv("META_API_KEY", `  ${KEY}\n`);
    expect(await apiKey("meta", secrets)).toBe(KEY);
    expect(secrets.send).not.toHaveBeenCalled();
  });

  it("refuses a missing, short or spaced key", async () => {
    const { apiKey } = await load();
    for (const value of [
      "",
      "short-key",
      "test key abcdefghijklmnop",
      "test-key-ébcdefghijklmnop",
    ]) {
      vi.stubEnv("META_API_KEY", value);
      expect(await apiKey("meta"), value).toBeNull();
    }
  });
});

describe("apiKey, production", () => {
  beforeEach(() => {
    vi.stubEnv("DB_CLUSTER_ARN", "test-cluster");
    vi.stubEnv("META_API_KEY_SECRET_NAME", SECRET_NAME);
  });

  it("refuses a raw key variable, without logging it", async () => {
    const { apiKey } = await load();
    const secrets = fakeSecrets(KEY);
    vi.stubEnv("META_API_KEY", KEY);
    expect(await apiKey("meta", secrets)).toBeNull();
    expect(secrets.send).not.toHaveBeenCalled();
    expect(logged.join("\n")).toContain("META_API_KEY is refused in production");
    expect(logged.join("\n")).not.toContain(KEY);
  });

  it("refuses a missing or malformed secret name", async () => {
    const { apiKey } = await load();
    const secrets = fakeSecrets(KEY);
    for (const name of ["", "name with spaces", "x".repeat(513)]) {
      vi.stubEnv("META_API_KEY_SECRET_NAME", name);
      expect(await apiKey("meta", secrets)).toBeNull();
    }
    expect(secrets.send).not.toHaveBeenCalled();
  });

  it("reads the secret by name once and keeps it for the process", async () => {
    const { apiKey } = await load();
    const secrets = fakeSecrets(KEY);
    expect(await apiKey("meta", secrets)).toBe(KEY);
    expect(await apiKey("meta", secrets)).toBe(KEY);
    expect(secrets.send).toHaveBeenCalledTimes(1);
    expect(secrets.send.mock.calls[0][0].input).toEqual({ SecretId: SECRET_NAME });
    expect(logged.join("\n")).not.toContain(KEY);
  });

  it("does not keep a failed read, and logs only the error's name", async () => {
    const { apiKey } = await load();
    const failure = new Error(`denied for ${SECRET_NAME} with ${KEY}`);
    failure.name = "AccessDeniedException";
    const secrets = fakeSecrets(failure, KEY);
    expect(await apiKey("meta", secrets)).toBeNull();
    expect(logged).toEqual(["ai: the key secret is unreadable (AccessDeniedException)"]);
    expect(await apiKey("meta", secrets)).toBe(KEY);
    expect(secrets.send).toHaveBeenCalledTimes(2);
  });

  it("refuses a secret that is not a key, and does not keep that either", async () => {
    const { apiKey } = await load();
    const pasted = `{"key":"${KEY}"} trailing words`;
    const secrets = fakeSecrets(pasted, KEY);
    expect(await apiKey("meta", secrets)).toBeNull();
    expect(logged).toEqual(["ai: the key secret is empty or not a key"]);
    expect(await apiKey("meta", secrets)).toBe(KEY);
    expect(secrets.send).toHaveBeenCalledTimes(2);
  });

  it("keeps each provider's key apart", async () => {
    const { apiKey } = await load();
    vi.stubEnv("BASETEN_API_KEY_SECRET_NAME", "payday-copilot/baseten-api-key");
    vi.stubEnv("BASETEN_API_KEY", "");
    const secrets = fakeSecrets(KEY, "other-key-abcdefghijklmnop");
    expect(await apiKey("meta", secrets)).toBe(KEY);
    expect(await apiKey("baseten", secrets)).toBe("other-key-abcdefghijklmnop");
    expect(secrets.send.mock.calls[1][0].input).toEqual({
      SecretId: "payday-copilot/baseten-api-key",
    });
  });
});
