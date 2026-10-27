import { join } from "node:path";
import { LOCAL_OVERRIDABLE } from "../src/config/local-overrides";
import { DEMO_CARRIERS } from "../src/lib/seed/carriers";

// Everything the local demo-path run needs, in one tracked file. Nothing here is a secret: the
// login works only against the fake sign-in host on this machine, the model key is a placeholder
// the local replay host never checks, and the database is a throwaway one on this machine.

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) throw new Error(`${name} is not a port`);
  return value;
}

export const FAKE_HOST_PORT = port("E2E_FAKE_HOST_PORT", 4010);
export const APP_PORT = port("E2E_APP_PORT", 3000);
export const FAKE_HOST = `http://127.0.0.1:${FAKE_HOST_PORT}`;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;

// The fake user pool. Its issuer has the real Cognito shape, so the app's verifier checks every
// claim as it does in production; only the keys come from the local file below.
export const E2E_POOL_ID = "us-east-2_LOCALDEMO";
export const E2E_CLIENT_ID = "local-e2e-client";
export const E2E_ISSUER = `https://cognito-idp.us-east-2.amazonaws.com/${E2E_POOL_ID}`;

// Written by the fake host at start (gitignored as *.local.*), read by the app's verifier.
// (__dirname: the test runner and tsx load this folder as CommonJS.)
export const JWKS_FILE = join(__dirname, "jwks.local.json");
export const REPLAY_FIXTURE = join(__dirname, "fixtures", "model-replay.json");
export const REPO_ROOT = join(__dirname, "..");

// Fixed tenant ids and logins, so a fresh database gets the same rows every run.
export type E2eTenant = {
  slug: (typeof DEMO_CARRIERS)[number]["slug"];
  name: string;
  timezone: string;
  email: string;
  tenantId: string;
  sub: string;
};

export const E2E_TENANTS: readonly E2eTenant[] = DEMO_CARRIERS.map((c, i) => ({
  slug: c.slug,
  name: c.name,
  timezone: c.timezone,
  email: `ops@${c.emailDomain}`,
  tenantId: `0b1e2e00-0000-4000-8000-00000000000${i + 1}`,
  sub: `0b1e2e00-0000-4000-8000-0000000000a${i + 1}`,
}));

export const E2E_CARRIER = E2E_TENANTS[0];
// A visible placeholder, accepted only by the fake sign-in host above.
export const E2E_LOGIN = { email: E2E_CARRIER.email, password: "local-demo-path-only" } as const;

// The throwaway database: dropped, migrated and seeded fresh by npm run e2e:seed. The admin login
// is the local Postgres superuser; the app connects as payday_app, so row-level security holds
// during the run as it does on Aurora.
export const E2E_DATABASE = "payday_e2e";

export function e2eAdminUrl(): URL {
  const base = new URL(process.env.E2E_ADMIN_DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/postgres");
  return base;
}

export function e2eAppUrl(): string {
  const url = new URL(e2eAdminUrl());
  url.username = "payday_app";
  url.password = "";
  url.pathname = `/${E2E_DATABASE}`;
  return url.toString();
}

// Every switch the override allows, on: every merged step runs. Caps and limits stay as shipped.
export const LOCAL_SWITCHES = JSON.stringify(Object.fromEntries(LOCAL_OVERRIDABLE.map((k) => [k, true])));

// The app's environment for next dev. Every variable the app reads that could reach an outside
// system is set here, blank where unused, so a developer's .env.local cannot leak into the run
// (Next never overrides a variable that is already set, even to an empty string).
export function appEnv(): Record<string, string> {
  return {
    NEXT_TELEMETRY_DISABLED: "1",
    APP_COMMIT: "e2e-local",
    DATABASE_URL: e2eAppUrl(),
    DB_CLUSTER_ARN: "",
    DB_SECRET_ARN: "",
    DB_ADMIN_SECRET_ARN: "",
    DB_NAME: "",
    FLAGS_LOCAL_OVERRIDES: LOCAL_SWITCHES,
    AI_HOST_OVERRIDE: FAKE_HOST,
    AI_SPEND_CAP_CENTS: "200",
    AI_WONDER_CAP_CENTS: "60",
    META_CONTRIBUTOR_MODE: "false",
    META_API_KEY: "local-replay-placeholder",
    META_API_KEY_SECRET_NAME: "",
    META_MODEL_SPARK: "muse-spark-1.3",
    META_MODEL_WONDER: "muse-wonder-1.0",
    META_MODEL_VOICE: "muse-voice-transcribe-1.0",
    META_MODEL_IMAGE: "muse-image-1.0",
    META_MODEL_SAM: "sam-3.1",
    BASETEN_API_KEY: "local-replay-placeholder",
    BASETEN_API_KEY_SECRET_NAME: "",
    BASETEN_MODEL_ID: "meta-models/muse-spark-open-1026",
    FIREWORKS_API_KEY: "",
    FIREWORKS_API_KEY_SECRET_NAME: "",
    FIREWORKS_MODEL_ID: "",
    AWS_REGION: "us-east-2",
    AWS_PROFILE: "",
    // InitiateAuth is unsigned, but the SDK may still look for credentials; these never leave
    // this machine because the endpoint below is the fake host.
    AWS_ACCESS_KEY_ID: "local-e2e",
    AWS_SECRET_ACCESS_KEY: "local-e2e",
    AWS_SESSION_TOKEN: "",
    AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER: FAKE_HOST,
    COGNITO_USER_POOL_ID: E2E_POOL_ID,
    COGNITO_CLIENT_ID: E2E_CLIENT_ID,
    AUTH_LOCAL_JWKS: JWKS_FILE,
    PAYMENT_PROVIDER: "mock",
    STRIPE_SECRET_KEY: "",
    STRIPE_SECRET_KEY_SECRET_NAME: "",
    STRIPE_TEST_DESTINATION_ACCOUNT: "",
    QBO_CLIENT_ID: "",
    QBO_CLIENT_SECRET: "",
    QBO_CLIENT_SECRET_NAME: "",
    QBO_ENVIRONMENT: "sandbox",
    QBO_REDIRECT_URI: "",
    QBO_ALLOWED_REALM_ID: "",
    QBO_TOKEN_KEY: "",
    QBO_TOKEN_KEY_SECRET_NAME: "",
    INBOUND_EMAIL_BUCKET: "",
    INBOUND_EMAIL_DOMAIN: "",
  };
}
