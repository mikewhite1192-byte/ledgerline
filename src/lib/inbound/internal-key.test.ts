import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretsClient } from "../adapters/secrets";
import { forgetInternalKey, internalKey } from "../sweep/internal-key";
import { forgetInboundKey, inboundKey } from "./internal-key";

const KEY = "Zk3".repeat(16);
const SWEEP = "Rq7".repeat(16);
const PROD = { DB_CLUSTER_ARN: "arn:aws:rds:us-east-2:000000000000:cluster:example" };

function secrets(answer: (id: string) => Promise<{ SecretString?: string }>) {
  return { send: vi.fn((cmd: { input: { SecretId: string } }) => answer(cmd.input.SecretId)) } as unknown as SecretsClient & {
    send: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  forgetInboundKey();
  forgetInternalKey();
});

describe("inboundKey", () => {
  it("reads its own variable locally, never the sweep's", async () => {
    await expect(inboundKey({ env: { INBOUND_INTERNAL_KEY: KEY } })).resolves.toBe(KEY);
    forgetInboundKey();
    await expect(inboundKey({ env: { SWEEP_INTERNAL_KEY: SWEEP } })).resolves.toBeNull();
  });

  it("refuses the raw key in production and reads its own secret by name, kept apart from the sweep's", async () => {
    const log = vi.fn();
    await expect(inboundKey({ env: { ...PROD, INBOUND_INTERNAL_KEY: KEY }, log })).resolves.toBeNull();
    expect(log.mock.calls[0][0]).toMatch(/^inbound: INBOUND_INTERNAL_KEY is refused in production/);
    expect(log.mock.calls[0][0]).not.toContain(KEY);

    const client = secrets(async (id) => ({ SecretString: id === "payday-copilot/inbound-internal-key" ? KEY : SWEEP }));
    const env = {
      ...PROD,
      INBOUND_INTERNAL_KEY_SECRET_NAME: "payday-copilot/inbound-internal-key",
      SWEEP_INTERNAL_KEY_SECRET_NAME: "payday-copilot/sweep-internal-key",
    };
    await expect(inboundKey({ env, secrets: client, log })).resolves.toBe(KEY);
    await expect(internalKey({ env, secrets: client, log })).resolves.toBe(SWEEP);
    // Each reader keeps its own key.
    await expect(inboundKey({ env, secrets: client, log })).resolves.toBe(KEY);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("logs with its own label when its secret name is not set", async () => {
    const log = vi.fn();
    await expect(inboundKey({ env: PROD, log })).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith("inbound: INBOUND_INTERNAL_KEY_SECRET_NAME is not set");
  });
});
