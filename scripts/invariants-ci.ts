import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dropDatabase, freshSeededDatabase } from "./lib/fresh-seeded-db";
import { localDatabaseUrl } from "./lib/local-db";

// npm run invariants:ci
//
// CI's run of the five invariants: a throwaway database on the job's own Postgres, built from
// every migration and seeded for both invented carriers, then `npm run invariants -- --target
// local` against it. The database is dropped afterwards, failures included. Exits with the
// invariants' own code (0 only when all five pass). DATABASE_URL must be a local admin login.

async function main(): Promise<number> {
  const server = localDatabaseUrl();
  const name = `payday_inv_ci_${randomBytes(4).toString("hex")}`;
  try {
    const url = await freshSeededDatabase(server, name);
    const run = spawnSync("npm", ["run", "--silent", "invariants", "--", "--target", "local"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, DATABASE_URL: url.toString() },
    });
    return run.status === 0 ? 0 : 1;
  } finally {
    await dropDatabase(server, name);
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const plain = err instanceof Error && err.name === "Error";
    console.error(`invariants:ci: ${plain ? (err as Error).message : err instanceof Error ? err.name : "failed"}`);
    process.exit(1);
  },
);
