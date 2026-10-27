import { spawnSync } from "node:child_process";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

// npm run e2e:deployed
//
// The demo path against a deployed site, run from this laptop (the nightly run, until a
// repository secret exists for a scheduled one). E2E_BASE_URL names the site. The login comes
// from E2E_DEMO_EMAIL and E2E_DEMO_PASSWORD, or, when the password is not given, from the demo
// logins secret through this machine's AWS credentials. The password is handed to the test
// process in its environment and never printed. Without E2E_BASE_URL nothing runs: the script
// says it skipped and exits 0.

const DEMO_SECRET = "payday-copilot/demo-logins";
const CARRIER = "blue-ridge";

type Login = { email: string; password: string };

function skip(why: string): never {
  console.log(`e2e:deployed: skipped: ${why}`);
  process.exit(0);
}

function baseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("E2E_BASE_URL is not a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("E2E_BASE_URL must be an https address with no credentials in it");
  }
  return url.origin;
}

async function savedLogin(): Promise<Login> {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-2" });
  let text: string | undefined;
  try {
    text = (await client.send(new GetSecretValueCommand({ SecretId: DEMO_SECRET }))).SecretString;
  } catch (err) {
    // The error's name only; its message can echo the request.
    throw new Error(`the demo logins secret is unreadable (${err instanceof Error ? err.name : "error"})`);
  }
  let saved: unknown;
  try {
    saved = (JSON.parse(text ?? "{}") as Record<string, unknown>)[CARRIER];
  } catch {
    throw new Error("the demo logins secret is not JSON");
  }
  const login = saved as Partial<Login> | undefined;
  if (typeof login?.email !== "string" || typeof login.password !== "string" || login.password === "") {
    throw new Error(`the demo logins secret has no ${CARRIER} login`);
  }
  return { email: login.email, password: login.password };
}

async function main(): Promise<number> {
  const raw = process.env.E2E_BASE_URL?.trim();
  if (!raw) skip("set E2E_BASE_URL to the deployed site's address to run the demo path there");
  const base = baseUrl(raw);

  const given = process.env.E2E_DEMO_PASSWORD;
  const login: Login = given
    ? { email: process.env.E2E_DEMO_EMAIL?.trim() ?? "", password: given }
    : await savedLogin();
  if (!login.email) throw new Error("E2E_DEMO_EMAIL is not set");

  console.log(`e2e:deployed: running the demo path against ${base} as ${login.email}`);
  const out = spawnSync(
    "npx",
    ["playwright", "test", "--config", "e2e/playwright.config.ts", "--project", "deployed"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_TARGET: "deployed",
        E2E_BASE_URL: base,
        E2E_DEMO_EMAIL: login.email,
        E2E_DEMO_PASSWORD: login.password,
      },
    },
  );
  return out.status ?? 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`e2e:deployed: ${err instanceof Error ? err.message : "failed"}`);
    process.exit(1);
  },
);
