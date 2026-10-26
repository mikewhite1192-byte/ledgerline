import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { AiProvider } from "./types";

// Where each provider's key comes from. Production (DB_CLUSTER_ARN set) reads Secrets Manager by
// the secret's name, through the SSR compute role; Amplify copies branch variables into the build
// as plain text, so a raw key variable is refused there. Local development reads the raw variable
// from .env.local. A key is never logged, stored or returned to a page.
const SOURCES: Record<AiProvider, { raw: string; secretName: string }> = {
  meta: { raw: "META_API_KEY", secretName: "META_API_KEY_SECRET_NAME" },
  baseten: { raw: "BASETEN_API_KEY", secretName: "BASETEN_API_KEY_SECRET_NAME" },
};

// Secrets Manager's own name rule.
const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;

// Tests pass a fake.
export type SecretsClient = {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
};

let client: SecretsClient | undefined;
// One read per provider per server process. A failed read is not kept, so the next call tries
// again (a secret created after the deploy is picked up without one).
const keys = new Map<AiProvider, Promise<string | null>>();

export async function apiKey(
  provider: AiProvider,
  secrets?: SecretsClient,
): Promise<string | null> {
  const source = SOURCES[provider];
  if (!process.env.DB_CLUSTER_ARN) return usable(process.env[source.raw]);

  if (process.env[source.raw]) {
    console.error(`ai: ${source.raw} is refused in production; the key belongs in Secrets Manager`);
    return null;
  }
  const name = process.env[source.secretName];
  if (!name || !SECRET_NAME.test(name)) {
    console.error(`ai: ${source.secretName} is not set`);
    return null;
  }
  let key = keys.get(provider);
  if (!key) {
    key = readSecret(name, secrets ?? (client ??= defaultClient()));
    keys.set(provider, key);
    void key.then((k) => {
      if (!k) keys.delete(provider);
    });
  }
  return key;
}

// Drops the kept key, so the next call reads the secret again. Called when the provider refuses
// the key, so a rotated secret is picked up without a redeploy. The refused call is not retried.
export function forgetKey(provider: AiProvider): void {
  keys.delete(provider);
}

function defaultClient(): SecretsClient {
  // Passed explicitly: whether the SSR runtime sets AWS_REGION is not confirmed.
  return new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-2" });
}

async function readSecret(name: string, secrets: SecretsClient): Promise<string | null> {
  try {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    const key = usable(out.SecretString);
    if (!key) console.error("ai: the key secret is empty or not a key");
    return key;
  } catch (err) {
    // The error's name only; its message can echo the request.
    console.error(
      `ai: the key secret is unreadable (${err instanceof Error ? err.name : "non-error"})`,
    );
    return null;
  }
}

// A bearer token: printable, no spaces. Anything else is a paste mistake and is never sent.
function usable(value: string | undefined): string | null {
  const key = value?.trim();
  return key && /^[\x21-\x7e]{16,512}$/.test(key) ? key : null;
}
