import { flags as releaseFlags, type Flags } from "../../config/flags";

// The server's start-up check (src/instrumentation.ts): no production QuickBooks company, no live
// Stripe key and no raw secret in production, ever. A refusal throws and names the variable,
// never its value. Pure: it reads only the environment and the release switches it is given. Each
// adapter repeats its own part of this on every call, and checks the secrets read from Secrets
// Manager there, since those are not in the environment.

export class MoneyEnvRefused extends Error {
  readonly variable: string;

  constructor(variable: string, why: string) {
    super(`money guard: refused to start (${variable} ${why})`);
    this.name = "MoneyEnvRefused";
    this.variable = variable;
  }
}

const REALM_ID = /^[0-9]{10,20}$/;
// The raw secret variables (SECRET_SOURCES in src/lib/adapters/secrets.ts; a test keeps the two
// lists equal). Named here so the guard loads no AWS client.
export const RAW_SECRET_VARIABLES = ["QBO_CLIENT_SECRET", "QBO_TOKEN_KEY", "STRIPE_SECRET_KEY"] as const;

export function assertMoneyEnvSafe(
  env: NodeJS.ProcessEnv,
  f: Pick<Flags, "accountingEnabled" | "paymentProvider" | "payoutsEnabled"> = releaseFlags,
): string {
  const qboEnvironment = env.QBO_ENVIRONMENT;
  if (qboEnvironment !== undefined && qboEnvironment !== "" && qboEnvironment !== "sandbox") {
    throw new MoneyEnvRefused("QBO_ENVIRONMENT", "must be sandbox");
  }

  const stripeKey = env.STRIPE_SECRET_KEY?.trim();
  if (stripeKey) {
    if (stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_")) {
      throw new MoneyEnvRefused("STRIPE_SECRET_KEY", "is a live key");
    }
    if (!stripeKey.startsWith("sk_test_")) {
      throw new MoneyEnvRefused("STRIPE_SECRET_KEY", "is not a test secret key");
    }
  }

  if (f.accountingEnabled === true) {
    if (qboEnvironment !== "sandbox") throw new MoneyEnvRefused("QBO_ENVIRONMENT", "must be sandbox");
    if (!REALM_ID.test(env.QBO_ALLOWED_REALM_ID ?? "")) {
      throw new MoneyEnvRefused("QBO_ALLOWED_REALM_ID", "must be the sandbox company id");
    }
  }

  // Production reads each secret from Secrets Manager by name; a raw copy in the environment is
  // a leak waiting to happen (Amplify writes branch variables into the build).
  if (env.DB_CLUSTER_ARN) {
    for (const raw of RAW_SECRET_VARIABLES) {
      if (env[raw]) throw new MoneyEnvRefused(raw, "is refused in production; use Secrets Manager");
    }
  }

  const payouts = f.payoutsEnabled === true ? f.paymentProvider : "off";
  return `money: guard ok (qbo sandbox only, payouts ${payouts}, accounting ${f.accountingEnabled === true ? "on" : "off"})`;
}
