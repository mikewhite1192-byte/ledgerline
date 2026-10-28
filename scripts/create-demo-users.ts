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
import {
  DEMO_SECRET_NAME,
  demoLogins,
  JUDGE_SECRET_NAME,
  parseDemoUserArgs,
  planPasswords,
  type DemoLogin,
  type Password,
} from "./lib/demo-logins";
import { ensureRows } from "./lib/demo-rows";
import { generatePassword } from "./lib/password";

// npm run demo:users [-- --reset-passwords] [-- --clerk] [-- --judge]
//
// Creates the two synthetic demo carriers, each with one admin login, from the laptop. --clerk
// adds the office clerk's staff login on Blue Ridge (key blue-ridge-clerk in demo-logins); --judge
// adds the demo visitor's judge login on Blue Ridge, whose password goes to its own secret,
// JUDGE_SECRET_NAME. Needs EXPECTED_AWS_ACCOUNT_ID, COGNITO_USER_POOL_ID, DB_CLUSTER_ARN,
// DB_ADMIN_SECRET_ARN and DB_NAME. The logins and the secrets' names are in lib/demo-logins.ts.
//
// A carrier's tenant id is a random UUID stored on its admin login as custom:tenant_id
// (immutable), so a rerun reads it back from the login instead of deriving it; the clerk and the
// judge get the same tenant id, read back from Blue Ridge's admin login. Passwords go only to the
// secrets, written before any password is set, so a password that works always exists in a
// secret. Every run applies each login's password from its secret, so a login always matches it;
// --reset-passwords gives every login a new one. The terminal shows the emails and the secret
// names, nothing else.
//
// It runs as the database admin, which row-level security does not hold (on Aurora the master
// user reads every carrier even with app.tenant_id set), so the row statements in
// lib/demo-rows.ts name their tenant themselves. See db/README.md.

type Aws = {
  cognito: CognitoIdentityProviderClient;
  secrets: SecretsManagerClient;
  userPoolId: string;
};

function attribute(attrs: AttributeType[] | undefined, name: string): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

// The login, created if missing, with its subject and tenant. An admin login creates its carrier
// with a new tenant id; any other login joins `tenantId` (its carrier's, read back from the admin
// login) and must already name it if it exists.
async function ensureLogin({ cognito, userPoolId }: Aws, login: DemoLogin, tenantId?: string) {
  try {
    const user = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: login.email }),
    );
    const sub = attribute(user.UserAttributes, "sub");
    const tenant = attribute(user.UserAttributes, "custom:tenant_id");
    if (!sub || !isUuid(tenant)) throw new Error(`${login.email} exists without a valid tenant`);
    if (tenantId !== undefined && tenant !== tenantId) {
      throw new Error(`${login.email} belongs to another tenant; fix it by hand`);
    }
    return { sub, tenantId: tenant };
  } catch (err) {
    if (!(err instanceof Error) || err.name !== "UserNotFoundException") throw err;
  }
  const newTenant = tenantId ?? randomUUID();
  const out = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: login.email,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: login.email },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:tenant_id", Value: newTenant },
      ],
    }),
  );
  const sub = attribute(out.User?.Attributes, "sub");
  if (!sub) throw new Error(`${login.email} was created without a subject`);
  return { sub, tenantId: newTenant };
}

async function readSecret({ secrets }: Aws, name: string): Promise<unknown> {
  try {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    return JSON.parse(out.SecretString ?? "{}") as unknown;
  } catch (err) {
    if (err instanceof Error && err.name === "ResourceNotFoundException") return undefined;
    throw err;
  }
}

async function writeSecret(
  { secrets }: Aws,
  name: string,
  value: Record<string, Password> | Password,
  exists: boolean,
  description: string,
): Promise<void> {
  const SecretString = JSON.stringify(value);
  if (exists) {
    await secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString }));
  } else {
    await secrets.send(
      new CreateSecretCommand({
        Name: name,
        Description: description,
        SecretString,
        Tags: [{ Key: "project", Value: "payday-copilot" }],
      }),
    );
  }
}

// Set from the first secret write until every password is applied, so a failure there says how to
// recover. It starts before the write: a write that errors may still have landed, and a rerun
// applies whatever the secrets then hold.
let settingPasswords = false;

async function main(): Promise<void> {
  const args = parseDemoUserArgs(process.argv.slice(2));
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
    const logins = demoLogins(args);
    const storedDemo = await readSecret(aws, DEMO_SECRET_NAME);
    const storedJudge = args.judge ? await readSecret(aws, JUDGE_SECRET_NAME) : undefined;
    // Admin logins come first in the list, so each carrier's tenant is known before its others.
    const tenants = new Map<string, string>();
    for (const login of logins) {
      const known = tenants.get(login.carrier.slug);
      if (login.role !== "admin" && known === undefined) {
        throw new Error(`${login.email} needs ${login.carrier.slug}'s admin login first`);
      }
      const user = await ensureLogin(aws, login, login.role === "admin" ? undefined : known);
      if (login.role === "admin") tenants.set(login.carrier.slug, user.tenantId);
      await ensureRows(db, login.carrier, user.tenantId, {
        sub: user.sub,
        email: login.email,
        role: login.role,
      });
    }

    const plan = planPasswords(
      logins,
      { demo: storedDemo, judge: storedJudge },
      args.resetPasswords,
      generatePassword,
    );
    settingPasswords = true;
    if (plan.writeDemo) {
      await writeSecret(aws, DEMO_SECRET_NAME, plan.demo, storedDemo !== undefined, "LedgerLine demo carrier logins");
    }
    if (plan.writeJudge && plan.judge) {
      await writeSecret(
        aws,
        JUDGE_SECRET_NAME,
        plan.judge,
        storedJudge !== undefined,
        "LedgerLine demo visitor login",
      );
    }
    for (const { email, password } of plan.apply) {
      await aws.cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: email,
          Password: password,
          Permanent: true,
        }),
      );
    }
    settingPasswords = false;
    for (const login of logins) console.log(`ready: ${login.email} (${login.role})`);
    console.log(`passwords: Secrets Manager ${DEMO_SECRET_NAME}`);
    if (args.judge) console.log(`demo visitor password: Secrets Manager ${JUDGE_SECRET_NAME}`);
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
    console.error("a secret may hold passwords not all applied: rerun to apply them");
  }
  process.exit(1);
});
