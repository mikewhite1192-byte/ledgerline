import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createDataApiDb } from "../src/lib/db/data-api";
import { createPgDb } from "../src/lib/db/pg";
import { splitSql } from "../src/lib/db/sql-split";
import { DbError, type Db } from "../src/lib/db/types";
import { assertAccount, REGION, requireEnv } from "./lib/aws-account";
import { localDatabaseUrl } from "./lib/local-db";

// npm run db:migrate -- --target local|aurora
//
// Applies db/migrations/*.sql in name order, each file in one transaction, one statement per
// call (the Data API runs one statement at a time; pg uses the extended protocol, which does
// too). A file's version is recorded in the same transaction, so a half-applied file never
// counts as applied. Forward only: a merged migration is never edited; a fix is a new file.
//
// local:  pg with DATABASE_URL, the admin login of a database on this machine (local or CI).
// aurora: the Data API as the migrating admin, from the laptop. Needs EXPECTED_AWS_ACCOUNT_ID,
//         DB_CLUSTER_ARN, DB_ADMIN_SECRET_ARN, DB_SECRET_ARN and DB_NAME. Afterward it sets the
//         app role's password from the app secret.

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");
const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

type Target = "local" | "aurora";

function parseTarget(argv: string[]): Target {
  const i = argv.indexOf("--target");
  const target = i === -1 ? undefined : argv[i + 1];
  if (target !== "local" && target !== "aurora") {
    throw new Error("usage: npm run db:migrate -- --target local|aurora");
  }
  return target;
}

function migrationFiles(): string[] {
  const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"));
  const bad = names.filter((n) => !FILE_NAME.test(n));
  if (bad.length > 0) throw new Error(`migration names must look like 0001_name.sql: ${bad.join(", ")}`);
  return names.sort();
}

async function openDb(target: Target): Promise<Db> {
  if (target === "local") {
    return createPgDb({ connectionString: localDatabaseUrl().toString(), max: 1 });
  }
  const clusterArn = requireEnv("DB_CLUSTER_ARN");
  const adminSecretArn = requireEnv("DB_ADMIN_SECRET_ARN");
  await assertAccount([clusterArn, adminSecretArn, requireEnv("DB_SECRET_ARN")]);
  return createDataApiDb({
    clusterArn,
    secretArn: adminSecretArn,
    database: requireEnv("DB_NAME"),
    region: REGION,
    continueAfterTimeout: true,
  });
}

// What went wrong, without SQL text or upstream messages (a statement could hold a secret).
function reason(err: unknown): string {
  if (err instanceof DbError) return err.message;
  return err instanceof Error ? err.message : "unknown error";
}

async function applyAll(db: Db): Promise<void> {
  await db.withoutTenant((q) => q.execute(ENSURE_TABLE));
  const applied = new Set(
    (
      await db.withoutTenant((q) =>
        q.query<{ version: string }>("SELECT version FROM schema_migrations"),
      )
    ).map((r) => r.version),
  );

  const files = migrationFiles();
  const versions = files.map((f) => f.slice(0, -".sql".length));
  // A database ahead of this checkout means the wrong branch or the wrong database: stop.
  const unknown = [...applied].filter((v) => !versions.includes(v));
  if (unknown.length > 0) {
    throw new Error(`the database has migrations this checkout does not: ${unknown.join(", ")}`);
  }

  for (const [i, file] of files.entries()) {
    const version = versions[i];
    if (applied.has(version)) continue;
    const statements = splitSql(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    let current = 0;
    try {
      await db.withoutTenant(async (q) => {
        for (const [n, statement] of statements.entries()) {
          current = n + 1;
          await q.execute(statement);
        }
        current = 0;
        await q.execute("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      });
    } catch (err) {
      const where = current > 0 ? `statement ${current} of ${statements.length}` : "recording it";
      throw new Error(`migration ${version} failed at ${where}: ${reason(err)}; nothing from it was kept`);
    }
    console.log(`applied ${version} (${statements.length} statements)`);
  }
}

// The app role's password lives only in the app secret. It reaches the database as a bound
// parameter and is quoted by format(%L) inside the server, so it never appears in SQL text, a
// log line or the terminal. Running it again sets the same password.
async function syncAppPassword(db: Db): Promise<void> {
  const secrets = new SecretsManagerClient({ region: REGION });
  let password: string;
  try {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: requireEnv("DB_SECRET_ARN") }));
    const parsed = JSON.parse(out.SecretString ?? "{}") as { username?: unknown; password?: unknown };
    if (parsed.username !== "payday_app") throw new Error("the app secret is not the payday_app login");
    if (typeof parsed.password !== "string" || parsed.password.length < 16) {
      throw new Error("the app secret has no usable password");
    }
    password = parsed.password;
  } finally {
    secrets.destroy();
  }
  await db.withoutTenant(async (q) => {
    // IS NOT NULL so the result row carries a boolean, not the password back to the laptop.
    await q.execute("SELECT set_config('app.pw', $1, true) IS NOT NULL", [password]);
    await q.execute(
      "DO $$ BEGIN EXECUTE format('ALTER ROLE payday_app PASSWORD %L', current_setting('app.pw', true)); END $$",
    );
  });
  console.log("app role password set from the app secret");
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const db = await openDb(target);
  try {
    await applyAll(db);
    if (target === "aurora") await syncAppPassword(db);
    console.log("migrations up to date");
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(`migrate: ${reason(err)}`);
  process.exit(1);
});
