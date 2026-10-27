import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createDataApiDb } from "../src/lib/db/data-api";
import { createPgDb } from "../src/lib/db/pg";
import type { Db } from "../src/lib/db/types";
import { exitCodeOf, formatLine, runInvariants } from "../src/lib/invariants";
import { assertAccount, REGION, requireEnv } from "./lib/aws-account";
import { localDatabaseUrl } from "./lib/local-db";

// npm run invariants -- --target local|aurora [--json <path>]
//
// The five money invariants (I1 ledger, I2 keys, I3 approvals, I4 model calls, I5 row security),
// one line each: `I<n> <name>: PASS|FAIL|UNKNOWN (<categories and counts>)`. Read-only: every
// check reads through a SELECT-only handle inside a read-only transaction; the row security probe
// also tries one insert with no tenant set, which must be refused and is always rolled back.
// Exits 0 only when all five pass; a FAIL or an UNKNOWN (a read that errored, nothing to
// compare) exits 1. The output and the JSON carry categories and counts only, never a row's id,
// a name, an amount or a secret.
//
// local:  DATABASE_URL, the admin login of a database on this machine; the app role connects to
//         the same database as payday_app with no password (trust auth, local and CI only).
// aurora: the Data API from the laptop. Needs EXPECTED_AWS_ACCOUNT_ID, DB_CLUSTER_ARN,
//         DB_ADMIN_SECRET_ARN (the cluster's master user, which reads every tenant),
//         DB_SECRET_ARN (the app role) and DB_NAME.

type Target = "local" | "aurora";
type Args = { target: Target; json: string | null };

const USAGE = "usage: npm run invariants -- --target local|aurora [--json <path>]";

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const target = value("--target");
  if (target !== "local" && target !== "aurora") throw new Error(USAGE);
  const json = value("--json");
  if (argv.includes("--json") && (!json || json.startsWith("--"))) throw new Error(USAGE);
  return { target, json: json ?? null };
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dbs = await openDbs(args.target);
  try {
    const results = await runInvariants(dbs);
    for (const r of results) console.log(formatLine(r));
    const exitCode = exitCodeOf(results);
    if (args.json) {
      const path = resolve(args.json);
      mkdirSync(dirname(path), { recursive: true });
      const report = { ranAt: new Date().toISOString(), target: args.target, exitCode, results };
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    }
    return exitCode;
  } finally {
    await Promise.allSettled([dbs.admin.close(), dbs.app.close()]);
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Setup errors are ours (usage, a missing setting, the wrong account); anything else prints
    // its name only, never upstream text.
    const plain = err instanceof Error && err.name === "Error";
    console.error(`invariants: ${plain ? (err as Error).message : err instanceof Error ? err.name : "failed"}`);
    process.exit(1);
  },
);
