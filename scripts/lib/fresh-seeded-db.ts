import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createPgDb } from "../../src/lib/db/pg";
import { DEMO_CARRIERS } from "../../src/lib/seed/carriers";
import { ensureRows } from "./demo-rows";
import { withDatabase } from "./local-db";

// A throwaway database on this machine with both invented carriers seeded, built the way a new
// environment is: every migration through the same runner Aurora uses, the two tenant rows and
// an admin login each, then the seed for both carriers at a fixed anchor (never today, so a run
// does not depend on the wall clock). The caller drops it with dropDatabase, failures included.

// Only names this helper made can be dropped by it: the invariants' and the model eval's.
const NAME = /^payday_(inv|eval)_[a-z0-9_]{1,40}$/;

// The seed's week: the Monday of the demo's open week.
export const SEED_ANCHOR = "2026-11-02";

function checkedName(name: string): string {
  if (!NAME.test(name)) throw new Error("a throwaway database name starts with payday_inv_ or payday_eval_");
  return name;
}

async function onServer(adminUrl: URL, sql: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function npmRun(args: string[], databaseUrl: string): void {
  const out = spawnSync("npm", ["run", "--silent", ...args], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (out.status !== 0) throw new Error(`npm run ${args[0]} failed`);
}

// adminUrl: the admin login of a local Postgres (already checked local by the caller). Returns
// the admin URL of the new database.
export async function freshSeededDatabase(adminUrl: URL, name: string): Promise<URL> {
  const db = checkedName(name);
  if (adminUrl.pathname === `/${db}`) throw new Error("connect to another database to build this one");
  await dropDatabase(adminUrl, db);
  await onServer(adminUrl, `CREATE DATABASE ${db}`);
  const url = withDatabase(adminUrl, db);
  npmRun(["db:migrate", "--", "--target", "local"], url.toString());
  const admin = createPgDb({ connectionString: url.toString(), max: 1 });
  try {
    for (const c of DEMO_CARRIERS) {
      const carrier = { slug: c.slug, name: c.name, timezone: c.timezone, email: `ops@${c.emailDomain}` };
      await ensureRows(admin, carrier, randomUUID(), `invariants-${c.slug}`);
    }
  } finally {
    await admin.close();
  }
  npmRun(["seed", "--", "--target", "local", "--tenant", "all", "--anchor", SEED_ANCHOR], url.toString());
  return url;
}

export async function dropDatabase(adminUrl: URL, name: string): Promise<void> {
  await onServer(adminUrl, `DROP DATABASE IF EXISTS ${checkedName(name)} WITH (FORCE)`);
}
