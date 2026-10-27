import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { E2E_DATABASE, E2E_TENANTS, e2eAdminUrl } from "../e2e/env.local-mode";
import { createPgDb } from "../src/lib/db/pg";
import { DEMO_ANCHOR } from "../src/lib/seed/anchor";
import { ensureRows } from "./lib/demo-rows";
import { localDatabaseUrl, withDatabase } from "./lib/local-db";

// npm run e2e:seed
//
// The demo-path test's database, fresh every run: drops and recreates payday_e2e on the local
// Postgres at E2E_ADMIN_DATABASE_URL (default postgresql://postgres@127.0.0.1:5432/postgres; this
// machine only), applies every migration with the runner Aurora uses, creates both demo tenants
// with the fixed ids in e2e/env.local-mode.ts and the e2e login's membership, then seeds both
// carriers at DEMO_ANCHOR. Same anchor, same ids: the recorded model answers' tool arguments
// name rows that exist again.

async function recreate(adminUrl: URL): Promise<void> {
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${E2E_DATABASE}`);
  } finally {
    await client.end();
  }
}

function run(args: string[], databaseUrl: string): void {
  const out = spawnSync("npm", ["run", "--silent", ...args], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl, DB_CLUSTER_ARN: "" },
  });
  if (out.status !== 0) throw new Error(`npm run ${args[0]} failed`);
}

async function main(): Promise<void> {
  // The same local-only check every script that drops a database uses.
  process.env.DATABASE_URL = e2eAdminUrl().toString();
  const adminUrl = localDatabaseUrl();
  if (adminUrl.pathname === `/${E2E_DATABASE}`) {
    throw new Error(`point E2E_ADMIN_DATABASE_URL at another database; ${E2E_DATABASE} is dropped and recreated`);
  }
  await recreate(adminUrl);
  const e2eUrl = withDatabase(adminUrl, E2E_DATABASE).toString();
  run(["db:migrate", "--", "--target", "local"], e2eUrl);

  const admin = createPgDb({ connectionString: e2eUrl, max: 1 });
  try {
    for (const t of E2E_TENANTS) {
      await ensureRows(admin, t, t.tenantId, t.sub);
      console.log(`e2e:seed: tenant ${t.slug} and its login ready`);
    }
  } finally {
    await admin.close();
  }
  run(["seed", "--", "--target", "local", "--tenant", "all", "--anchor", DEMO_ANCHOR], e2eUrl);
  console.log(`e2e:seed: ${E2E_DATABASE} seeded at ${DEMO_ANCHOR}`);
}

main().catch((err: unknown) => {
  console.error(`e2e:seed: ${err instanceof Error ? err.message : "failed"}`);
  process.exit(1);
});
