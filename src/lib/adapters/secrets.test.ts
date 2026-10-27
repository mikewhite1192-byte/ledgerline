import { afterEach, describe, expect, it } from "vitest";
import { forgetMoneySecret, moneySecret, type SecretsClient } from "./secrets";

const VALUE = "v".repeat(32);

function fakeSecrets(answers: (string | Error)[]) {
  const reads: string[] = [];
  const secrets: SecretsClient = {
    async send(command) {
      reads.push(String(command.input.SecretId));
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { SecretString: next };
    },
  };
  return { secrets, reads };
}

const prod = (over: Record<string, string> = {}) =>
  ({ DB_CLUSTER_ARN: "test-cluster", QBO_TOKEN_KEY_SECRET_NAME: "test/qbo-token-key", ...over }) as unknown as NodeJS.ProcessEnv;

afterEach(() => forgetMoneySecret());

describe("money secrets", () => {
  it("reads the raw variable locally, trimmed, and refuses a paste mistake", async () => {
    expect(await moneySecret("qbo_token_key", { env: { QBO_TOKEN_KEY: ` ${VALUE}\n` } as unknown as NodeJS.ProcessEnv })).toBe(VALUE);
    for (const bad of ["", "short", "has a space in the middle of it"]) {
      expect(await moneySecret("qbo_token_key", { env: { QBO_TOKEN_KEY: bad } as unknown as NodeJS.ProcessEnv })).toBeNull();
    }
  });

  it("in production reads Secrets Manager by name once, and refuses a raw copy", async () => {
    const { secrets, reads } = fakeSecrets([VALUE]);
    const lines: string[] = [];
    const deps = { env: prod(), secrets, log: (l: string) => lines.push(l) };
    expect(await moneySecret("qbo_token_key", deps)).toBe(VALUE);
    expect(await moneySecret("qbo_token_key", deps)).toBe(VALUE);
    expect(reads).toEqual(["test/qbo-token-key"]);

    const raw = await moneySecret("qbo_token_key", { ...deps, env: prod({ QBO_TOKEN_KEY: VALUE }) });
    expect(raw).toBeNull();
    expect(lines.join("\n")).toContain("QBO_TOKEN_KEY is refused in production");
    expect(lines.join("\n")).not.toContain(VALUE);
  });

  it("does not keep a failed read, and logs the error's name only", async () => {
    const err = new Error(`denied for ${VALUE}`);
    err.name = "AccessDeniedException";
    const { secrets, reads } = fakeSecrets([err, VALUE]);
    const lines: string[] = [];
    const deps = { env: prod(), secrets, log: (l: string) => lines.push(l) };
    expect(await moneySecret("qbo_token_key", deps)).toBeNull();
    expect(await moneySecret("qbo_token_key", deps)).toBe(VALUE);
    expect(reads).toHaveLength(2);
    expect(lines.join("\n")).toContain("AccessDeniedException");
    expect(lines.join("\n")).not.toContain(VALUE);
  });

  it("reads again after it is forgotten, and needs a valid secret name", async () => {
    const { secrets, reads } = fakeSecrets([VALUE, VALUE]);
    const deps = { env: prod(), secrets, log: () => {} };
    await moneySecret("qbo_token_key", deps);
    forgetMoneySecret("qbo_token_key");
    await moneySecret("qbo_token_key", deps);
    expect(reads).toHaveLength(2);
    expect(
      await moneySecret("qbo_token_key", { ...deps, env: prod({ QBO_TOKEN_KEY_SECRET_NAME: "bad name" }) }),
    ).toBeNull();
    expect(await moneySecret("qbo_client_secret", deps)).toBeNull();
    expect(reads).toHaveLength(2);
  });
});
