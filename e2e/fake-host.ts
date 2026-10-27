import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { BASETEN_CHAT_URL } from "../src/lib/ai/providers/baseten";
import { META_RESPONSES_URL } from "../src/lib/ai/providers/meta";
import {
  E2E_CLIENT_ID,
  E2E_ISSUER,
  E2E_LOGIN,
  E2E_CARRIER,
  FAKE_HOST_PORT,
  JWKS_FILE,
  REPLAY_FIXTURE,
} from "./env.local-mode";
import {
  CHAT_PATH,
  emptyFixture,
  fingerprint,
  fingerprintParts,
  isModelPath,
  labelOf,
  parseFixture,
  serializeFixture,
  stampForReplay,
  stripForFixture,
  type ModelPath,
  type ReplayFixture,
} from "./replay";

// The local demo-path run's only "outside world", on 127.0.0.1 (tsx e2e/fake-host.ts):
// - POST /v1/responses and /v1/chat/completions answer from the replay fixture. A request with no
//   recorded answer gets 400 (a definite refusal: the app's ledger releases the reservation and
//   nothing is charged), and its fingerprint is listed at GET /misses so the test fails red
//   naming what to re-record.
// - POST / with X-Amz-Target ...InitiateAuth stands in for the user pool: the e2e login gets an
//   RS256 ID token signed with a key made at start; the public key is written to JWKS_FILE
//   before the server listens, for the app's verifier (AUTH_LOCAL_JWKS).
// Record mode (E2E_RECORD=1, npm run e2e:record, never in CI): each model request is sent on to
// the real host with the real key, read here and never printed, and its answer is kept for the
// fixture, written when the run ends. The app sees exactly what a replay will give it.

const RECORD = process.env.E2E_RECORD === "1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TOKEN_SECONDS = 12 * 60 * 60;
const KID = "local-e2e-1";

if (RECORD && process.env.CI) {
  console.error("fake-host: recording is refused in CI; the replay fixture is recorded on a laptop");
  process.exit(1);
}

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: "jwk" });
writeFileSync(JWKS_FILE, `${JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] })}\n`);

const fixture: ReplayFixture = RECORD
  ? emptyFixture(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()))
  : loadFixture();
const misses = new Map<string, string>();
let served = 0;
let unsaved = false;

function loadFixture(): ReplayFixture {
  try {
    return parseFixture(readFileSync(REPLAY_FIXTURE, "utf8"));
  } catch (err) {
    console.error(`fake-host: replay fixture unreadable (${err instanceof Error ? err.message : "error"})`);
    process.exit(1);
  }
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(privateKey: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = b64url({
    iss: E2E_ISSUER,
    aud: E2E_CLIENT_ID,
    token_use: "id",
    sub: E2E_CARRIER.sub,
    email: E2E_LOGIN.email,
    "cognito:username": E2E_CARRIER.sub,
    "custom:tenant_id": E2E_CARRIER.tenantId,
    auth_time: now,
    iat: now,
    exp: now + TOKEN_SECONDS,
  });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function initiateAuth(res: ServerResponse, body: unknown): void {
  const b = (body ?? {}) as { AuthFlow?: unknown; ClientId?: unknown; AuthParameters?: Record<string, unknown> };
  const ok =
    b.AuthFlow === "USER_PASSWORD_AUTH" &&
    b.ClientId === E2E_CLIENT_ID &&
    typeof b.AuthParameters?.USERNAME === "string" &&
    b.AuthParameters.USERNAME.toLowerCase() === E2E_LOGIN.email &&
    b.AuthParameters.PASSWORD === E2E_LOGIN.password;
  const amz = { "content-type": "application/x-amz-json-1.1", "x-amzn-requestid": randomUUID() };
  if (!ok) {
    console.log("fake-host: sign-in refused");
    send(res, 400, { __type: "NotAuthorizedException", message: "Incorrect username or password." }, {
      ...amz,
      "x-amzn-errortype": "NotAuthorizedException:",
    });
    return;
  }
  console.log("fake-host: sign-in ok");
  send(
    res,
    200,
    {
      AuthenticationResult: {
        IdToken: idToken(keys.privateKey),
        AccessToken: "local-e2e-access",
        ExpiresIn: TOKEN_SECONDS,
        TokenType: "Bearer",
      },
      ChallengeParameters: {},
    },
    amz,
  );
}

// --- record mode: the real hosts, with keys read once and never printed ---

const UPSTREAM: Record<ModelPath, { url: string; envKey: string; secretVar: string; secretDefault: string }> = {
  "/v1/responses": {
    url: META_RESPONSES_URL,
    envKey: "META_API_KEY",
    secretVar: "META_API_KEY_SECRET_NAME",
    secretDefault: "payday-copilot/meta-api-key",
  },
  "/v1/chat/completions": {
    url: BASETEN_CHAT_URL,
    envKey: "BASETEN_API_KEY",
    secretVar: "BASETEN_API_KEY_SECRET_NAME",
    secretDefault: "payday-copilot/baseten-api-key",
  },
};
const upstreamKeys = new Map<ModelPath, Promise<string>>();

async function readKey(path: ModelPath): Promise<string> {
  const u = UPSTREAM[path];
  const raw = process.env[u.envKey]?.trim();
  if (raw) return raw;
  const name = process.env[u.secretVar]?.trim() || u.secretDefault;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-2" });
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: name }));
    const value = out.SecretString?.trim();
    if (value) return value;
  } catch (err) {
    throw new Error(`the ${path} key is unreadable (${err instanceof Error ? err.name : "error"})`);
  }
  throw new Error(`the ${path} key is empty`);
}

function upstreamKey(path: ModelPath): Promise<string> {
  let key = upstreamKeys.get(path);
  if (!key) {
    key = readKey(path);
    key.catch(() => upstreamKeys.delete(path));
    upstreamKeys.set(path, key);
  }
  return key;
}

async function record(res: ServerResponse, path: ModelPath, raw: Buffer, fp: string, label: string): Promise<void> {
  let key: string;
  try {
    key = await upstreamKey(path);
  } catch (err) {
    console.error(`fake-host: record ${fp} not sent (${err instanceof Error ? err.message : "error"})`);
    send(res, 503, { error: { message: "recording key unavailable" } });
    return;
  }
  const upstream = await fetch(UPSTREAM[path].url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body: new Uint8Array(raw),
    redirect: "error",
  });
  const text = await upstream.text();
  if (upstream.status !== 200) {
    // The status only: an upstream message can echo the request.
    console.error(`fake-host: record ${fp} upstream answered ${upstream.status}; not recorded`);
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(text);
    return;
  }
  const body = stripForFixture(path, JSON.parse(text));
  if (!fixture.entries[fp]) {
    fixture.entries[fp] = { label, path, body };
    unsaved = true;
    console.log(`fake-host: recorded ${fp} ${label}`);
  } else {
    console.log(`fake-host: recorded ${fp} again (first answer kept) ${label}`);
  }
  served += 1;
  send(res, 200, stampForReplay(path, fixture.entries[fp].body));
}

async function model(res: ServerResponse, path: ModelPath, raw: Buffer): Promise<void> {
  const parts = fingerprintParts(path, JSON.parse(raw.toString("utf8")));
  const fp = fingerprint(parts);
  const label = labelOf(parts);
  if (RECORD) return record(res, path, raw, fp, label);
  const entry = fixture.entries[fp];
  if (!entry || entry.path !== path) {
    misses.set(fp, label);
    console.error(`fake-host: replay miss ${fp} ${label}`);
    const error = { message: "no recorded answer for this request", type: "invalid_request_error" };
    send(res, 400, path === CHAT_PATH ? { error } : { error: { ...error, code: "replay_miss" } });
    return;
  }
  served += 1;
  console.log(`fake-host: replay ${fp} ${label}`);
  send(res, 200, stampForReplay(path, entry.body));
}

const server = createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, mode: RECORD ? "record" : "replay", entries: Object.keys(fixture.entries).length });
      }
      if (req.method === "GET" && path === "/misses") {
        return send(res, 200, { served, misses: [...misses].map(([fp, label]) => ({ fingerprint: fp, label })) });
      }
      if (req.method !== "POST") return send(res, 404, { error: "not found" });
      const raw = await readBody(req);
      if (path === "/" && req.headers["x-amz-target"] === "AWSCognitoIdentityProviderService.InitiateAuth") {
        return initiateAuth(res, JSON.parse(raw.toString("utf8") || "{}"));
      }
      if (isModelPath(path)) return await model(res, path, raw);
      console.error(`fake-host: unknown request ${req.method} ${path}`);
      return send(res, 404, { error: "not found" });
    } catch (err) {
      console.error(`fake-host: request failed (${err instanceof Error ? err.message : "error"})`);
      if (!res.headersSent) send(res, 500, { error: "fake host error" });
    }
  })();
});

function stop(): void {
  // A recording is written once, as the run ends: a file changing in the repository while next dev
  // runs sets off a recompile in the middle of a turn.
  if (RECORD && unsaved) {
    writeFileSync(REPLAY_FIXTURE, serializeFixture(fixture));
    console.log(`fake-host: wrote ${Object.keys(fixture.entries).length} answers to the replay fixture`);
  }
  rmSync(JWKS_FILE, { force: true });
  server.close();
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

server.listen(FAKE_HOST_PORT, "127.0.0.1", () => {
  const n = Object.keys(fixture.entries).length;
  console.log(`fake-host: ${RECORD ? "recording" : `replaying ${n} answers`} on 127.0.0.1:${FAKE_HOST_PORT}`);
});
