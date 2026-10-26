import { readSettlementInput } from "../src/lib/data/read";
import { TENANT_TABLES } from "../src/lib/data/tables";
import { createDataApiDb } from "../src/lib/db/data-api";
import { createPgDb } from "../src/lib/db/pg";
import { DbError, type Db } from "../src/lib/db/types";
import { settleDriver } from "../src/lib/rules-engine";
import { HERO_OPEN_WEEK } from "../src/lib/seed/assert-plan";
import { DEMO_CARRIERS, carrierBySlug, type DemoCarrier } from "../src/lib/seed/carriers";
import { buildCarrierPlan, type CarrierPlan } from "../src/lib/seed/plan";
import { clearTenantLedger, findDemoTenant, replaceTenantData } from "../src/lib/seed/run";
import { countRows } from "../src/lib/seed/summary";
import { isLocalDate } from "../src/lib/time/local-date";
import { assertAccount, REGION, requireEnv } from "./lib/aws-account";
import { localDatabaseUrl } from "./lib/local-db";

// npm run seed -- --target local|aurora --tenant blue-ridge|prairie-wind|all --anchor YYYY-MM-DD
//                 [--dry-run]
//
// Fills the demo carriers with four weeks of invented trucking pay data (design section 4). The
// anchor is required and is the only date the data depends on: the same anchor gives the same
// rows and ids. Replace mode: each tenant's money ledger rows are cleared first, then its rows
// are deleted and rewritten in one transaction. The tenants must already exist
// (npm run demo:users); the seed never creates them.
//
// The admin login looks each tenant up by slug and clears its ledger rows (the app role has no
// DELETE on money_actions). The rows are written as payday_app, the app's own role, inside the
// tenant's transaction.
//
// local:  DATABASE_URL, the admin login of a database on this machine; the app role connects to
//         the same database as payday_app with no password (trust auth, local and CI only).
// aurora: the Data API from the laptop. Needs EXPECTED_AWS_ACCOUNT_ID, DB_CLUSTER_ARN,
//         DB_ADMIN_SECRET_ARN, DB_SECRET_ARN (the app role) and DB_NAME.
// --dry-run builds and checks the plans, prints the counts, and connects to nothing.

type Target = "local" | "aurora";
type Args = { target: Target; carriers: DemoCarrier[]; anchor: string; dryRun: boolean };

const USAGE =
  "usage: npm run seed -- --target local|aurora --tenant blue-ridge|prairie-wind|all " +
  "--anchor YYYY-MM-DD [--dry-run]";

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const target = value("--target");
  const tenant = value("--tenant");
  const anchor = value("--anchor");
  if (target !== "local" && target !== "aurora") throw new Error(USAGE);
  if (!anchor || !isLocalDate(anchor)) throw new Error(USAGE);
  let carriers: DemoCarrier[];
  if (tenant === "all") carriers = [...DEMO_CARRIERS];
  else {
    const one = tenant ? carrierBySlug(tenant) : undefined;
    if (!one) throw new Error(USAGE);
    carriers = [one];
  }
  return { target, carriers, anchor, dryRun: argv.includes("--dry-run") };
}

async function openDbs(target: Target): Promise<{ admin: Db; app: Db }> {
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

// The hero's open-week net, read back from the database and settled by the engine.
async function heroNet(app: Db, tenantId: string, plan: CarrierPlan): Promise<number | null> {
  const hero = plan.rows.drivers.find((d) => d.code === plan.carrier.heroCode);
  const open = plan.rows.settlement_periods.find((p) => p.status === "open");
  if (!hero || !open) return null;
  const input = await app.withTenant(tenantId, (q) => readSettlementInput(q, hero.id, open.id));
  return settleDriver(input).netCents;
}

// What went wrong, without SQL text or upstream messages.
function reason(err: unknown): string {
  if (err instanceof DbError) return err.message;
  return err instanceof Error ? err.message : "unknown error";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Every plan is built and checked before anything connects.
  const plans = args.carriers.map((c) => buildCarrierPlan(c, args.anchor));
  if (args.dryRun) {
    for (const plan of plans) {
      const counts = countRows(plan.rows);
      for (const t of TENANT_TABLES) {
        console.log(`${plan.carrier.slug} ${t}: would insert ${counts[t]}`);
      }
    }
    return;
  }
  const { admin, app } = await openDbs(args.target);
  try {
    for (const plan of plans) {
      const slug = plan.carrier.slug;
      const tenantId = await findDemoTenant(admin, plan.carrier);
      // Ledger rows first, then the replace. The two run on different logins, so they cannot
      // share a transaction: if the replace then fails, the old subjects stay without their
      // ledger rows. A paid advance or settlement still refuses a second payout by its own
      // status; run the seed again before approving anything.
      const cleared = await clearTenantLedger(admin, tenantId);
      console.log(`cleared ${cleared} ledger rows for ${slug}`);
      const report = await replaceTenantData(app, tenantId, plan);
      for (const t of TENANT_TABLES) {
        console.log(`${slug} ${t}: deleted ${report.deleted[t]}, inserted ${report.inserted[t]}`);
      }
      // Only the carrier with the hero has one; its net read back must be the worked example.
      const net = await heroNet(app, tenantId, plan);
      if (net !== null) {
        console.log(`${slug} hero ${plan.carrier.heroCode} open-week net: ${net}`);
        if (net !== HERO_OPEN_WEEK.netCents) {
          throw new Error(`${slug}: the hero's open-week net read back is not the worked example`);
        }
      }
    }
  } finally {
    await Promise.all([admin.close(), app.close()]);
  }
}

main().catch((err: unknown) => {
  console.error(`seed: ${reason(err)}`);
  process.exit(1);
});
