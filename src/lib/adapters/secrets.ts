import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

// Where the money adapters' secrets come from: the QuickBooks client secret, the key that seals
// the QuickBooks tokens, and the Stripe test key. Production (DB_CLUSTER_ARN set) reads Secrets
// Manager by the secret's name, through the SSR compute role; Amplify copies branch variables into
// the build as plain text, so a raw variable is refused there. Local development reads the raw
// variable from .env.local. A value is never logged, stored or returned to a page; logs name the
// variable only. The same two-source rule as src/lib/ai/keys.ts.

export type MoneySecret = "qbo_client_secret" | "qbo_token_key" | "stripe_secret_key";

export const SECRET_SOURCES: Record<MoneySecret, { raw: string; secretName: string }> = {
  qbo_client_secret: { raw: "QBO_CLIENT_SECRET", secretName: "QBO_CLIENT_SECRET_NAME" },
  qbo_token_key: { raw: "QBO_TOKEN_KEY", secretName: "QBO_TOKEN_KEY_SECRET_NAME" },
  stripe_secret_key: { raw: "STRIPE_SECRET_KEY", secretName: "STRIPE_SECRET_KEY_SECRET_NAME" },
};

// Secrets Manager's own name rule.
const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;

// Tests pass a fake.
export type SecretsClient = {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
};

export type SecretDeps = {
  env?: NodeJS.ProcessEnv;
  secrets?: SecretsClient;
  log?: (line: string) => void;
};

let client: SecretsClient | undefined;
// One read per secret per server process. A failed read is not kept, so the next call tries
// again (a secret stored after the deploy is picked up without one).
const cache = new Map<MoneySecret, Promise<string | null>>();

// The trimmed value, or null when it is missing, refused or unreadable. Never throws.
export async function moneySecret(which: MoneySecret, deps: SecretDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.error(line));
  const source = SECRET_SOURCES[which];
  if (!env.DB_CLUSTER_ARN) return printable(env[source.raw]);

  if (env[source.raw]) {
    log(`money: ${source.raw} is refused in production; it belongs in Secrets Manager`);
    return null;
  }
  const name = env[source.secretName];
  if (!name || !SECRET_NAME.test(name)) {
    log(`money: ${source.secretName} is not set`);
    return null;
  }
  let value = cache.get(which);
  if (!value) {
    value = readSecret(name, source.secretName, deps.secrets ?? (client ??= defaultClient()), log);
    cache.set(which, value);
    void value.then((v) => {
      if (!v) cache.delete(which);
    });
  }
  return value;
}

// Drops the kept value, so the next call reads the secret again (after the outside system
// refused it, so a rotated secret is picked up without a redeploy). Tests use it too.
export function forgetMoneySecret(which?: MoneySecret): void {
  if (which) cache.delete(which);
  else cache.clear();
}

function defaultClient(): SecretsClient {
  // Passed explicitly: whether the SSR runtime sets AWS_REGION is not confirmed.
  return new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-2" });
}

async function readSecret(
  name: string,
  variable: string,
  secrets: SecretsClient,
  log: (line: string) => void,
): Promise<string | null> {
  try {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    const value = printable(out.SecretString);
    if (!value) log(`money: the secret named by ${variable} is empty or not usable`);
    return value;
  } catch (err) {
    // The error's name only; its message can echo the request.
    log(
      `money: the secret named by ${variable} is unreadable (${err instanceof Error ? err.name : "non-error"})`,
    );
    return null;
  }
}

// Printable, no spaces, a sane length. Anything else is a paste mistake and is never used.
function printable(value: string | undefined): string | null {
  const v = value?.trim();
  return v && /^[\x21-\x7e]{16,512}$/.test(v) ? v : null;
}
