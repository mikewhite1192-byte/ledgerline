import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SecretsClient } from "../adapters/secrets";

// The demo visitor's login (src/app/sign-in/try-demo-action.ts). It lives only in Secrets Manager,
// as JSON { email, password }, under the name in JUDGE_LOGIN_SECRET_NAME (payday-copilot/judge-login,
// infra/lib/hosting-stack.ts; scripts/create-demo-users.ts --judge writes it), read through the SSR
// compute role. There is no plain variable for it anywhere: a password in a branch variable would be
// copied into the build as text. The login is kept in memory for five minutes; a failed read is not
// kept. The email and password are never logged, stored or returned to a page; the log names the
// category only.

export type JudgeLogin = { email: string; password: string };

export type JudgeLoginDeps = {
  env?: Record<string, string | undefined>;
  secrets?: SecretsClient;
  log?: (line: string) => void;
  now?: () => number;
};

export const JUDGE_LOGIN_CACHE_MS = 5 * 60 * 1000;

// Secrets Manager's own name rule.
const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;

let client: SecretsClient | undefined;
let kept: Promise<JudgeLogin | null> | undefined;
let keptAt = 0;

// The login, or null when the name is unset, the secret is unreadable or its shape is wrong.
// Never throws.
export async function judgeLogin(deps: JudgeLoginDeps = {}): Promise<JudgeLogin | null> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.error(line));
  const name = env.JUDGE_LOGIN_SECRET_NAME;
  if (!name || !SECRET_NAME.test(name)) {
    log("judge-login: JUDGE_LOGIN_SECRET_NAME is not set");
    return null;
  }
  const now = (deps.now ?? Date.now)();
  if (kept && now - keptAt >= JUDGE_LOGIN_CACHE_MS) kept = undefined;
  if (!kept) {
    const secrets =
      deps.secrets ?? (client ??= new SecretsManagerClient({ region: env.AWS_REGION ?? "us-east-2" }));
    const reading = read(name, secrets, log);
    kept = reading;
    keptAt = now;
    void reading.then((v) => {
      if (!v && kept === reading) kept = undefined;
    });
  }
  return kept;
}

// Drops the kept login, so the next sign-in reads the secret again (after Cognito refused the
// password, so a reset password is picked up without a redeploy). Tests use it too.
export function forgetJudgeLogin(): void {
  kept = undefined;
  keptAt = 0;
}

async function read(
  name: string,
  secrets: SecretsClient,
  log: (line: string) => void,
): Promise<JudgeLogin | null> {
  let text: string | undefined;
  try {
    text = (await secrets.send(new GetSecretValueCommand({ SecretId: name }))).SecretString;
  } catch (err) {
    log(`judge-login: the secret is unreadable (${err instanceof Error ? err.name : "non-error"})`);
    return null;
  }
  const login = parse(text);
  if (!login) log("judge-login: the secret is not an email and password");
  return login;
}

function parse(text: string | undefined): JudgeLogin | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 4096) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { email, password } = value as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string") return null;
  const trimmed = email.trim();
  // The sign-in form's own bounds (src/app/sign-in/actions.ts).
  if (!trimmed || trimmed.length > 254 || !trimmed.includes("@")) return null;
  if (!password || password.length > 256) return null;
  return { email: trimmed, password };
}
