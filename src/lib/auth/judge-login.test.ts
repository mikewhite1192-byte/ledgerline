import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretsClient } from "../adapters/secrets";
import { JUDGE_LOGIN_CACHE_MS, forgetJudgeLogin, judgeLogin } from "./judge-login";

// A made-up value that stands in for the stored password.
const PASS = ["not", "a", "real", "password", "J4"].join("-");
const EMAIL = "judge@blueridge.example";
const ENV = { JUDGE_LOGIN_SECRET_NAME: "payday-copilot/judge-login" };

function secrets(answer: () => Promise<{ SecretString?: string }>) {
  return { send: vi.fn(answer) } as unknown as SecretsClient & { send: ReturnType<typeof vi.fn> };
}

const stored = (value: unknown) => secrets(async () => ({ SecretString: JSON.stringify(value) }));

afterEach(() => forgetJudgeLogin());

describe("judgeLogin", () => {
  it("reads the login from Secrets Manager by the configured name", async () => {
    const client = stored({ email: ` ${EMAIL} `, password: PASS });
    await expect(judgeLogin({ env: ENV, secrets: client, log: vi.fn() })).resolves.toEqual({
      email: EMAIL,
      password: PASS,
    });
    expect(client.send.mock.calls[0][0].input).toEqual({ SecretId: "payday-copilot/judge-login" });
  });

  it("answers null without a read when the name is unset or not a secret name", async () => {
    const client = stored({ email: EMAIL, password: PASS });
    const log = vi.fn();
    await expect(judgeLogin({ env: {}, secrets: client, log })).resolves.toBeNull();
    await expect(
      judgeLogin({ env: { JUDGE_LOGIN_SECRET_NAME: "bad name" }, secrets: client, log }),
    ).resolves.toBeNull();
    expect(client.send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("judge-login: JUDGE_LOGIN_SECRET_NAME is not set");
  });

  it("ignores a plain password variable: the login comes from the secret or not at all", async () => {
    const env = { JUDGE_LOGIN_PASSWORD: PASS, JUDGE_LOGIN_EMAIL: EMAIL };
    await expect(judgeLogin({ env, secrets: stored({}), log: vi.fn() })).resolves.toBeNull();
  });

  it("answers null for a secret that is not an email and password, and never logs its text", async () => {
    const log = vi.fn();
    for (const value of [
      [EMAIL, PASS],
      { email: EMAIL },
      { password: PASS },
      { email: 7, password: PASS },
      { email: "no-at-sign", password: PASS },
      { email: EMAIL, password: "" },
      { email: EMAIL, password: "x".repeat(257) },
      { email: `${"a".repeat(250)}@b.example`, password: PASS },
    ]) {
      await expect(judgeLogin({ env: ENV, secrets: stored(value), log })).resolves.toBeNull();
    }
    for (const text of ["", "not json", undefined]) {
      const client = secrets(async () => ({ SecretString: text }));
      await expect(judgeLogin({ env: ENV, secrets: client, log })).resolves.toBeNull();
    }
    const lines = log.mock.calls.map((c) => c[0] as string).join("\n");
    expect(lines).toContain("judge-login: the secret is not an email and password");
    expect(lines).not.toContain(PASS);
    expect(lines).not.toContain(EMAIL);
  });

  it("answers null when the secret is unreadable, logging the error's name only", async () => {
    const log = vi.fn();
    const boom = Object.assign(new Error(`text with ${PASS}`), { name: "AccessDeniedException" });
    const client = secrets(async () => Promise.reject(boom));
    await expect(judgeLogin({ env: ENV, secrets: client, log })).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith("judge-login: the secret is unreadable (AccessDeniedException)");
    expect(log.mock.calls.map((c) => c[0] as string).join("\n")).not.toContain(PASS);
  });

  it("keeps the login for five minutes, then reads it again", async () => {
    let clock = 1_000_000;
    const client = stored({ email: EMAIL, password: PASS });
    const deps = { env: ENV, secrets: client, log: vi.fn(), now: () => clock };
    await judgeLogin(deps);
    clock += JUDGE_LOGIN_CACHE_MS - 1;
    await judgeLogin(deps);
    expect(client.send).toHaveBeenCalledTimes(1);
    clock += 1;
    await judgeLogin(deps);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed read, and forgets a kept login on request", async () => {
    let fail = true;
    const client = secrets(async () => {
      if (fail) throw Object.assign(new Error("down"), { name: "InternalServiceError" });
      return { SecretString: JSON.stringify({ email: EMAIL, password: PASS }) };
    });
    const deps = { env: ENV, secrets: client, log: vi.fn(), now: () => 0 };
    await expect(judgeLogin(deps)).resolves.toBeNull();
    // Let the kept promise's cleanup run.
    await Promise.resolve();
    fail = false;
    await expect(judgeLogin(deps)).resolves.toEqual({ email: EMAIL, password: PASS });
    forgetJudgeLogin();
    await judgeLogin(deps);
    expect(client.send).toHaveBeenCalledTimes(3);
  });
});
