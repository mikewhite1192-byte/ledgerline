import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const POOL = "us-east-2_LOCALDEMO";
const CLIENT = "local-e2e-client";
const TENANT = "0e2e0000-0000-4000-8000-000000000001";
const ARN = "arn:aws:rds:us-east-2:000000000000:cluster:example";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, jwks: { keys: [{ ...jwk, kid: "local-1", alg: "RS256", use: "sig" }] } };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const head = b64({ alg: "RS256", kid: "local-1", typ: "JWT" });
  const body = b64(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${sig.toString("base64url")}`;
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://cognito-idp.us-east-2.amazonaws.com/${POOL}`,
    aud: CLIENT,
    token_use: "id",
    sub: "e2e-user-1",
    email: "ops@blueridge.example",
    "custom:tenant_id": TENANT,
    iat: now,
    exp: now + 3600,
    ...extra,
  };
}

let dir: string;
let logged: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-test-"));
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DB_CLUSTER_ARN", "");
  vi.stubEnv("COGNITO_USER_POOL_ID", POOL);
  vi.stubEnv("COGNITO_CLIENT_ID", CLIENT);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.doUnmock("aws-jwt-verify");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function writeJwks(value: unknown): string {
  const path = join(dir, "jwks.local.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

describe("localJwks", () => {
  it("reads the local key set in local mode only", async () => {
    const { localJwks } = await import("./verify");
    const { jwks } = keyPair();
    const path = writeJwks(jwks);
    expect(localJwks({ NODE_ENV: "development" })).toBeNull();
    expect(localJwks({ NODE_ENV: "development", AUTH_LOCAL_JWKS: path })).toEqual(jwks);
    expect(logged).toEqual([]);
  });

  it("is inert in production and with an Aurora cluster configured", async () => {
    const { localJwks } = await import("./verify");
    const path = writeJwks(keyPair().jwks);
    expect(localJwks({ NODE_ENV: "production", AUTH_LOCAL_JWKS: path })).toBeNull();
    expect(localJwks({ NODE_ENV: "development", DB_CLUSTER_ARN: ARN, AUTH_LOCAL_JWKS: path })).toBeNull();
    expect(localJwks({ NODE_ENV: "test", DB_CLUSTER_ARN: ARN, AUTH_LOCAL_JWKS: path })).toBeNull();
    expect(logged).toHaveLength(3);
    expect(logged.every((l) => !l.includes(dir))).toBe(true);
  });

  it("trusts nothing from a missing, malformed or empty key set", async () => {
    const { localJwks } = await import("./verify");
    for (const path of [join(dir, "missing.json"), writeJwks("{not json"), writeJwks({ keys: [] })]) {
      expect(localJwks({ NODE_ENV: "development", AUTH_LOCAL_JWKS: path })).toBeNull();
    }
    expect(logged).toHaveLength(3);
  });
});

describe("verifyIdToken with the local key set", () => {
  it("accepts a token the local sign-in host signed, as the pool's own would be", async () => {
    const { privateKey, jwks } = keyPair();
    vi.stubEnv("AUTH_LOCAL_JWKS", writeJwks(jwks));
    const { verifyIdToken } = await import("./verify");
    expect(await verifyIdToken(sign(privateKey, claims()))).toEqual({
      sub: "e2e-user-1",
      email: "ops@blueridge.example",
      tenantId: TENANT,
    });
  });

  it("still checks the audience, the token use and the signature", async () => {
    const { privateKey, jwks } = keyPair();
    vi.stubEnv("AUTH_LOCAL_JWKS", writeJwks(jwks));
    const { verifyIdToken } = await import("./verify");
    expect(await verifyIdToken(sign(privateKey, claims({ aud: "other-client" })))).toBeNull();
    expect(await verifyIdToken(sign(privateKey, claims({ token_use: "access" })))).toBeNull();
    // Same key id, another key: the signature does not match.
    expect(await verifyIdToken(sign(keyPair().privateKey, claims()))).toBeNull();
    expect(logged.filter((l) => l.startsWith("auth: token rejected"))).toHaveLength(3);
  });

  it("never caches the local key set with an Aurora cluster configured or in production", async () => {
    const path = writeJwks(keyPair().jwks);
    for (const env of [{ DB_CLUSTER_ARN: ARN }, { NODE_ENV: "production" }]) {
      vi.resetModules();
      const fake = { cacheJwks: vi.fn(), verify: vi.fn(async () => ({})) };
      vi.doMock("aws-jwt-verify", () => ({ CognitoJwtVerifier: { create: () => fake } }));
      vi.stubEnv("AUTH_LOCAL_JWKS", path);
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const { verifyIdToken } = await import("./verify");
      await verifyIdToken("token");
      expect(fake.verify).toHaveBeenCalledTimes(1);
      expect(fake.cacheJwks).not.toHaveBeenCalled();
      vi.doUnmock("aws-jwt-verify");
      vi.unstubAllEnvs();
      vi.stubEnv("COGNITO_USER_POOL_ID", POOL);
      vi.stubEnv("COGNITO_CLIENT_ID", CLIENT);
    }
  });

  it("caches the local key set exactly once, on the first verify", async () => {
    vi.resetModules();
    const fake = { cacheJwks: vi.fn(), verify: vi.fn(async () => ({})) };
    vi.doMock("aws-jwt-verify", () => ({ CognitoJwtVerifier: { create: () => fake } }));
    vi.stubEnv("AUTH_LOCAL_JWKS", writeJwks(keyPair().jwks));
    const { verifyIdToken } = await import("./verify");
    await verifyIdToken("token");
    await verifyIdToken("token");
    expect(fake.cacheJwks).toHaveBeenCalledTimes(1);
  });
});
