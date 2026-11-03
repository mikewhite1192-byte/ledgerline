import { createDataApiDb } from "../src/lib/db/data-api";
import { createPgDb } from "../src/lib/db/pg";
import type { Db } from "../src/lib/db/types";
import { flags } from "../src/config/flags";
import { DEMO_CARRIERS } from "../src/lib/seed/carriers";
import { findDemoTenant } from "../src/lib/seed/run";
import { purgeExpired } from "../src/lib/visit-copy/purge";
import { assertAccount, REGION, requireEnv } from "./lib/aws-account";
import { localDatabaseUrl } from "./lib/local-db";

// npm run visit-copies:purge -- --target local|aurora [--limit N]
//
// Deletes the copies of ended demo visits (flags.visitCopies, src/lib/visit-copy/purge.ts) for
// both demo carriers: each visit whose copy is set and not yet deleted, ended more than
// flags.visitCopies.graceMinutes ago, oldest first, at most N per carrier (default 20). The
// preparing page does the same lazily, a couple at a time; this is the catch-up. A copy that
// fails is counted and left for the next run.
//
// The admin login only looks each demo carrier up by slug; every write runs as the app role.
// local:  DATABASE_URL, as npm run demo:reset.
// aurora: the Data API from the laptop. Needs EXPECTED_AWS_ACCOUNT_ID, DB_CLUSTER_ARN,
//         DB_ADMIN_SECRET_ARN, DB_SECRET_ARN (the app role) and DB_NAME.

const USAGE = "usage: npm run visit-copies:purge -- --target local|aurora [--limit N]";

function parseArgs(argv: readonly string[]): { target: "local" | "aurora"; limit: number } {
  let target: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target" && target === undefined && i + 1 < argv.length) {
      target = argv[++i];
    } else if (arg === "--limit" && limit === undefined && i + 1 < argv.length) {
      const raw = argv[++i];
      if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw new Error(USAGE);
      limit = Number(raw);
    } else {
      throw new Error(USAGE);
    }
  }
  if (target !== "local" && target !== "aurora") throw new Error(USAGE);
  return { target, limit: limit ?? 20 };
}

async function openDbs(target: "local" | "aurora"): Promise<{ admin: Db; app: Db }> {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { admin, app } = await openDbs(args.target);
  let failed = 0;
  try {
    for (const carrier of DEMO_CARRIERS) {
      const tenantId = await findDemoTenant(admin, carrier);
      const report = await purgeExpired(app, tenantId, {
        graceMinutes: flags.visitCopies.graceMinutes,
        limit: args.limit,
      });
      console.log(`${carrier.slug}: purged ${report.purged}, already gone ${report.gone}, failed ${report.failed}`);
      failed += report.failed;
    }
  } finally {
    await Promise.all([admin.close(), app.close()]);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`visit-copies:purge: ${err instanceof Error ? err.name : "unknown error"}`);
  process.exit(1);
});
