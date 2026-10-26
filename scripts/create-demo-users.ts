import { randomUUID } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createDataApiDb } from "../src/lib/db/data-api";
import { DbError } from "../src/lib/db/types";
import { isUuid } from "../src/lib/uuid";
import { assertAccount, REGION, requireEnv } from "./lib/aws-account";
import { ensureRows } from "./lib/demo-rows";
import { generatePassword } from "./lib/password";

// npm run demo:users [-- --reset-passwords]
//
// Creates the two synthetic demo carriers, each with one admin login, from the laptop. Needs
// EXPECTED_AWS_ACCOUNT_ID, COGNITO_USER_POOL_ID, DB_CLUSTER_ARN, DB_ADMIN_SECRET_ARN and DB_NAME.
// Invented names on reserved .example domains: no real company, no real mailbox.
//
// The tenant id is a random UUID stored on the login as custom:tenant_id (immutable), so a rerun
// reads it back from the login instead of deriving it. Passwords go only to the
// DEMO_SECRET_NAME secret, written before any password is set, so a password that works always
// exists in the secret. The terminal shows the emails and the secret name, nothing else. A rerun
// keeps existing logins and their passwords unless --reset-passwords is passed.
//
// It runs as the database admin, which row-level security does not hold (on Aurora the master
// user reads every carrier even with app.tenant_id set), so the row statements in
// lib/demo-rows.ts name their tenant themselves. See db/README.md.

const DEMO_SECRET_NAME = "payday-copilot/demo-logins";

const CARRIERS = [
  {
    slug: "blue-ridge",
    name: "Blue Ridge Freight Lines",
    timezone: "America/New_York",
    email: "ops@blueridge.example",
  },
  {
    slug: "prairie-wind",
    name: "Prairie Wind Transport",
    timezone: "America/Chicago",
    email: "ops@prairiewind.example",
  },
] as const;

type Carrier = (typeof CARRIERS)[number];
type Login = { email: string; password: string };
type Logins = Record<string, Login>;

type Aws = {
  cognito: CognitoIdentityProviderClient;
  secrets: SecretsManagerClient;
  userPoolId: string;
};

function attribute(attrs: AttributeType[] | undefined, name: string): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

// The login for this carrier, created if missing. Returns its subject, tenant and whether it
// still needs a permanent password.
async function ensureLogin({ cognito, userPoolId }: Aws, carrier: Carrier) {
  try {
    const user = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: carrier.email }),
    );
    const sub = attribute(user.UserAttributes, "sub");
    const tenantId = attribute(user.UserAttributes, "custom:tenant_id");
    if (!sub || !isUuid(tenantId)) throw new Error(`${carrier.email} exists without a valid tenant`);
    return { sub, tenantId, created: false, confirmed: user.UserStatus === "CONFIRMED" };
  } catch (err) {
    if (!(err instanceof Error) || err.name !== "UserNotFoundException") throw err;
  }
  const tenantId = randomUUID();
  const out = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: carrier.email,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: carrier.email },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:tenant_id", Value: tenantId },
      ],
    }),
  );
  const sub = attribute(out.User?.Attributes, "sub");
  if (!sub) throw new Error(`${carrier.email} was created without a subject`);
  return { sub, tenantId, created: true, confirmed: false };
}

async function readLogins({ secrets }: Aws): Promise<Logins | undefined> {
  try {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: DEMO_SECRET_NAME }));
    return JSON.parse(out.SecretString ?? "{}") as Logins;
  } catch (err) {
    if (err instanceof Error && err.name === "ResourceNotFoundException") return undefined;
    throw err;
  }
}

async function writeLogins({ secrets }: Aws, logins: Logins, exists: boolean): Promise<void> {
  const SecretString = JSON.stringify(logins);
  if (exists) {
    await secrets.send(new PutSecretValueCommand({ SecretId: DEMO_SECRET_NAME, SecretString }));
  } else {
    await secrets.send(
      new CreateSecretCommand({
        Name: DEMO_SECRET_NAME,
        Description: "LedgerLine demo carrier logins",
        SecretString,
        Tags: [{ Key: "project", Value: "payday-copilot" }],
      }),
    );
  }
}

// Set from the secret write until every password is applied, so a failure there says how to
// recover. It starts before the write: a write that errors may still have landed, and a rerun
// without --reset-passwords would then trust the new, never-set passwords and skip them.
let settingPasswords = false;

async function main(): Promise<void> {
  const resetPasswords = process.argv.includes("--reset-passwords");
  const userPoolId = requireEnv("COGNITO_USER_POOL_ID");
  const clusterArn = requireEnv("DB_CLUSTER_ARN");
  const adminSecretArn = requireEnv("DB_ADMIN_SECRET_ARN");
  if (!userPoolId.startsWith(`${REGION}_`)) {
    throw new Error("COGNITO_USER_POOL_ID is not in the project's region");
  }
  await assertAccount([clusterArn, adminSecretArn]);

  const aws: Aws = {
    cognito: new CognitoIdentityProviderClient({ region: REGION }),
    secrets: new SecretsManagerClient({ region: REGION }),
    userPoolId,
  };
  const db = createDataApiDb({
    clusterArn,
    secretArn: adminSecretArn,
    database: requireEnv("DB_NAME"),
    region: REGION,
  });
  try {
    const stored = await readLogins(aws);
    const logins: Logins = { ...stored };
    const toSet: Carrier[] = [];
    for (const carrier of CARRIERS) {
      const login = await ensureLogin(aws, carrier);
      await ensureRows(db, carrier, login.tenantId, login.sub);
      const saved = logins[carrier.slug];
      const known = saved?.email === carrier.email && typeof saved.password === "string";
      // A password nobody has recorded is useless, so a confirmed login missing from the secret
      // gets a new one too.
      if (login.created || !login.confirmed || resetPasswords || !known) {
        logins[carrier.slug] = { email: carrier.email, password: generatePassword() };
        toSet.push(carrier);
      }
    }

    if (toSet.length > 0) {
      settingPasswords = true;
      await writeLogins(aws, logins, stored !== undefined);
      for (const carrier of toSet) {
        await aws.cognito.send(
          new AdminSetUserPasswordCommand({
            UserPoolId: userPoolId,
            Username: carrier.email,
            Password: logins[carrier.slug].password,
            Permanent: true,
          }),
        );
      }
      settingPasswords = false;
    }
    for (const carrier of CARRIERS) console.log(`ready: ${carrier.email}`);
    console.log(`passwords: Secrets Manager ${DEMO_SECRET_NAME}`);
  } finally {
    await db.close();
    aws.cognito.destroy();
    aws.secrets.destroy();
  }
}

main().catch((err: unknown) => {
  // Our own messages and error names only; an SDK message could echo request details.
  const own = err instanceof DbError || (err instanceof Error && err.constructor === Error);
  const name = err instanceof Error ? err.name : "unknown";
  console.error(`demo users: ${own ? (err as Error).message : `failed (${name})`}`);
  if (settingPasswords) {
    console.error("the secret may hold new passwords not all applied: rerun with --reset-passwords");
  }
  process.exit(1);
});
