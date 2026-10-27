import { createDataApiDb } from "../src/lib/db/data-api";
import { createPgDb } from "../src/lib/db/pg";
import { DbError, type Db } from "../src/lib/db/types";
import { DEMO_ANCHOR } from "../src/lib/seed/anchor";
import { buildCarrierPlan } from "../src/lib/seed/plan";
import {
  CLEARED_TABLES,
  DemoResetRefused,
  FUNCTION_TABLES,
  RESET_TABLES,
  previewDemoReset,
  refusalText,
  resetDemoTenant,
} from "../src/lib/seed/reset";
import { findDemoTenant } from "../src/lib/seed/run";
import { countRows } from "../src/lib/seed/summary";
import { TENANT_TABLES } from "../src/lib/data/tables";
import { assertAccount, REGION, requireEnv } from "./lib/aws-account";
import { parseResetArgs, type ResetTarget } from "./lib/demo-reset-args";
import { localDatabaseUrl } from "./lib/local-db";

// npm run demo:reset -- --target local|aurora --tenant blue-ridge|prairie-wind [--dry-run]
//
// Puts one demo carrier back to its seeded week at the demo anchor (src/lib/seed/anchor.ts), the
// same reset the admin button on /settings/demo runs: one tenant transaction as the app role,
// with demo_reset_clear() (migration 0025) clearing the settled ledger rows and the agent's
// records, the seed's replace rewriting the seeded tables, and a read-back of every count and of
// the hero's open-week net. Any failure rolls the whole transaction back. It refuses, deleting
// nothing, while a ledger row is still reserved, sent or unknown, a row failed as
// amount_mismatch, or a flagged proposal a ledger row names.
//
// The release switch (flags.demoResetEnabled) gates the page only; a person running this script
// has already chosen to reset. Against Aurora it runs only with the owner's go.
//
// The admin login only looks the tenant up by slug (the app role cannot read tenants before a
// tenant is set); every write runs as the app role.
//
// local:  DATABASE_URL, the admin login of a database on this machine; the app role connects to
//         the same database as payday_app with no password (trust auth, local and CI only).
// aurora: the Data API from the laptop. Needs EXPECTED_AWS_ACCOUNT_ID, DB_CLUSTER_ARN,
//         DB_ADMIN_SECRET_ARN, DB_SECRET_ARN (the app role) and DB_NAME.
// --dry-run reads the carrier's counts and refusals and prints what a reset would write, in a
//         transaction that writes nothing.

// The same connections as npm run seed.
async function openDbs(target: ResetTarget): Promise<{ admin: Db; app: Db }> {
  if (target === "local") {
    const adminUrl = localDatabaseUrl();
    const appUrl = new URL(adminUrl);
    appUrl.username = "payday_app";
    appUrl.password = "";
    return {
      admin: createPgDb({ connectionString: adminUrl.toString(), max: 1 }),
      app: createPgDb({ connectionString: appUrl.toString(), max: 1 }),
    };
  }
  const clusterArn = requireEnv("DB_CLUSTER_ARN");
  const adminSecretArn = requireEnv("DB_ADMIN_SECRET_ARN");
  const appSecretArn = requireEnv("DB_SECRET_ARN");
  const database = requireEnv("DB_NAME");
  await assertAccount([clusterArn, adminSecretArn, appSecretArn]);
  return {
    admin: createDataApiDb({ clusterArn, secretArn: adminSecretArn, database, region: REGION }),
    app: createDataApiDb({ clusterArn, secretArn: appSecretArn, database, region: REGION }),
  };
}

// What went wrong, without SQL text or upstream messages.
function reason(err: unknown): string {
  if (err instanceof DbError) return err.message;
  return err instanceof Error ? err.message : "unknown error";
}

async function main(): Promise<void> {
  const args = parseResetArgs(process.argv.slice(2));
  const slug = args.carrier.slug;
  // The plan is built and checked before anything connects.
  const plan = buildCarrierPlan(args.carrier, DEMO_ANCHOR);
  const planned = countRows(plan.rows);
  const { admin, app } = await openDbs(args.target);
  try {
    const tenantId = await findDemoTenant(admin, args.carrier);
    if (args.dryRun) {
      const preview = await app.withTenant(tenantId, (q) => previewDemoReset(q, args.carrier));
      for (const t of TENANT_TABLES) {
        console.log(`${slug} ${t}: now ${preview.current[t]}, after a reset ${planned[t]}`);
      }
      for (const t of CLEARED_TABLES) console.log(`${slug} ${t}: now ${preview.current[t]}, after a reset 0`);
      if (preview.refusals.length > 0) {
        for (const r of preview.refusals) console.error(`${slug}: would refuse: ${refusalText(r)}`);
        process.exitCode = 1;
      }
      return;
    }
    const report = await resetDemoTenant(app, tenantId, plan);
    for (const t of FUNCTION_TABLES) console.log(`${slug} cleared ${t}: ${report.cleared[t]}`);
    for (const t of RESET_TABLES) {
      console.log(`${slug} ${t}: before ${report.before[t]}, after ${report.after[t]}`);
    }
    if (report.heroNetCents !== null) {
      console.log(`${slug} hero ${plan.carrier.heroCode} open-week net: ${report.heroNetCents}`);
    }
    console.log(`${slug} reset to the seeded week at ${DEMO_ANCHOR}`);
  } finally {
    await Promise.all([admin.close(), app.close()]);
  }
}

main().catch((err: unknown) => {
  if (err instanceof DemoResetRefused) {
    for (const r of err.refusals) console.error(`demo:reset refused: ${refusalText(r)}`);
    console.error("demo:reset: nothing was cleared");
  } else {
    console.error(`demo:reset: ${reason(err)}`);
  }
  process.exit(1);
});
