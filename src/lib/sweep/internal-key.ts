import { createHash, timingSafeEqual } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SecretsClient } from "../adapters/secrets";

// The scheduled kicker's key for POST /api/internal/sweep. Production (DB_CLUSTER_ARN set) reads
// it from Secrets Manager by the name in SWEEP_INTERNAL_KEY_SECRET_NAME, through the SSR compute
// role; Amplify copies branch variables into the build as plain text, so a raw key is refused
// there. Local development reads SWEEP_INTERNAL_KEY from .env.local. The value is never logged,
// stored or returned; a missing or short key means the route answers not_configured. The read is
// kept for the life of the instance; after a rotation the route asks once for a fresh read on a
// mismatch, at most once a minute, so a wrong key cannot turn into a stream of secret reads.

export type KeyDeps = {
  env?: Record<string, string | undefined>;
  secrets?: SecretsClient;
  log?: (line: string) => void;
  now?: () => number;
};

export const REFRESH_MIN_MS = 60_000;

const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
// At least 32 printable characters, no spaces.
const USABLE = /^[\x21-\x7e]{32,512}$/;

let client: SecretsClient | undefined;
let kept: Promise<string | null> | undefined;
let keptAt = 0;

export async function internalKey(deps: KeyDeps = {}, opts: { fresh?: boolean } = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.error(line));
  if (!env.DB_CLUSTER_ARN) return usable(env.SWEEP_INTERNAL_KEY);
  if (env.SWEEP_INTERNAL_KEY) {
    log("sweep: SWEEP_INTERNAL_KEY is refused in production; it belongs in Secrets Manager");
    return null;
  }
  const name = env.SWEEP_INTERNAL_KEY_SECRET_NAME;
  if (!name || !SECRET_NAME.test(name)) {
    log("sweep: SWEEP_INTERNAL_KEY_SECRET_NAME is not set");
    return null;
  }
  const now = (deps.now ?? Date.now)();
  // A fresh read drops the kept value only when it is at least a minute old.
  if (opts.fresh && kept && now - keptAt >= REFRESH_MIN_MS) kept = undefined;
  if (!kept) {
    const secrets = deps.secrets ?? (client ??= new SecretsManagerClient({ region: env.AWS_REGION ?? "us-east-2" }));
    const reading = read(name, secrets, log);
    kept = reading;
    keptAt = now;
    // A failed read is not kept, so a key stored after the deploy is picked up without one.
    void reading.then((v) => {
      if (!v && kept === reading) kept = undefined;
    });
  }
  return kept;
}

async function read(name: string, secrets: SecretsClient, log: (line: string) => void): Promise<string | null> {
  try {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    const v = usable(out.SecretString);
    if (!v) log("sweep: the internal key secret is empty or too short");
    return v;
  } catch (err) {
    log(`sweep: the internal key secret is unreadable (${err instanceof Error ? err.name : "non-error"})`);
    return null;
  }
}

function usable(value: string | undefined): string | null {
  const v = value?.trim();
  return v && USABLE.test(v) ? v : null;
}

// Constant time over equal-length digests, so neither the key's length nor its prefix leaks.
export function keyMatches(given: string | null, key: string): boolean {
  if (typeof given !== "string" || given.length === 0 || given.length > 512) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(key, "utf8").digest();
  return timingSafeEqual(a, b);
}

// Tests only.
export function forgetInternalKey(): void {
  kept = undefined;
  keptAt = 0;
}
