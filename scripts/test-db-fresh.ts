import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { localDatabaseUrl, withDatabase } from "./lib/local-db";

// npm run test:db:fresh
//
// The local equivalent of CI's database job: drop and recreate payday_test on the Postgres at
// DATABASE_URL (this machine only), apply every migration with the same runner Aurora uses,
// then run the database tests against it. DATABASE_URL is the admin login, for example
// postgresql://postgres@localhost:5432/postgres.

const TEST_DB = "payday_test";

async function recreate(adminUrl: URL): Promise<void> {
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await client.end();
  }
}

function run(args: string[], databaseUrl: string): void {
  const out = spawnSync("npm", ["run", ...args], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (out.status !== 0) process.exit(out.status ?? 1);
}

async function main(): Promise<void> {
  const adminUrl = localDatabaseUrl();
  if (adminUrl.pathname === `/${TEST_DB}`) {
    throw new Error(`point DATABASE_URL at another database; ${TEST_DB} is dropped and recreated`);
  }
  await recreate(adminUrl);
  const testUrl = withDatabase(adminUrl, TEST_DB).toString();
  run(["db:migrate", "--", "--target", "local"], testUrl);
  run(["test:db"], testUrl);
}

main().catch((err: unknown) => {
  console.error(`test:db:fresh: ${err instanceof Error ? err.message : "failed"}`);
  process.exit(1);
});
