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
import { DbError, type Db } from "../src/lib/db/types";
import { isUuid } from "../src/lib/uuid";
import { assertAccount, REGION, requireEnv } from "./lib/aws-account";
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

// The tenant row and the membership, written as that tenant (row-level security applies to the
// admin too) and read back whole. A slug or a login already tied to another tenant fails here.
async function ensureRows(db: Db, carrier: Carrier, tenantId: string, sub: string) {
  await db.withTenant(tenantId, async (q) => {
    const zone = await q.query("SELECT 1 AS ok FROM pg_timezone_names WHERE name = $1", [
      carrier.timezone,
    ]);
    if (zone.length !== 1) throw new Error(`${carrier.timezone} is not a time zone name`);
    await q.execute(
      `INSERT INTO tenants (id, slug, name, timezone)
       VALUES (current_tenant_id(), $1, $2, $3) ON CONFLICT (slug) DO NOTHING`,
      [carrier.slug, carrier.name, carrier.timezone],
    );
    await q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), $1, $2, 'admin') ON CONFLICT (cognito_sub) DO NOTHING`,
      [sub, carrier.email],
    );
    const tenant = await q.query<{ slug: string }>("SELECT slug FROM tenants");
    const member = await q.query<{ email: string }>(
      "SELECT email FROM memberships WHERE cognito_sub = $1",
      [sub],
    );
    if (tenant.length !== 1 || tenant[0].slug !== carrier.slug) {
      throw new Error(`${carrier.slug} belongs to another tenant id; fix it by hand`);
    }
    if (member.length !== 1 || member[0].email !== carrier.email) {
      throw new Error(`${carrier.email} is linked to another tenant; fix it by hand`);
    }
  });
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
        Description: "Payday Copilot demo carrier logins",
        SecretString,
        Tags: [{ Key: "project", Value: "payday-copilot" }],
      }),
    );
  }
}

// Set while passwords are being applied, so a failure there says how to recover.
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
      await writeLogins(aws, logins, stored !== undefined);
      settingPasswords = true;
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
    console.error("the secret holds new passwords not all applied: rerun with --reset-passwords");
  }
  process.exit(1);
});
