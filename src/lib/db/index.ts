import { createDataApiDb } from "./data-api";
import { createPgDb } from "./pg";
import { DbError, type TenantDb } from "./types";

export { DbError } from "./types";
export type { Param, Queryable, TenantDb } from "./types";

let db: TenantDb | undefined;

// The app's one database handle, built on first use (never at import, so the health route and
// the build need no database). Production is the Data API, always; DATABASE_URL is local only.
// Nothing but src/lib/tenant and the model spend ledger in src/lib/ai call this.
export function getDb(): TenantDb {
  if (db) return db;
  const clusterArn = process.env.DB_CLUSTER_ARN;
  if (clusterArn) {
    const secretArn = process.env.DB_SECRET_ARN;
    const database = process.env.DB_NAME;
    if (!secretArn || !database) throw new DbError("not_configured");
    // Passed explicitly: whether the SSR runtime sets AWS_REGION is not confirmed.
    const region = process.env.AWS_REGION ?? "us-east-2";
    db = createDataApiDb({ clusterArn, secretArn, database, region });
    return db;
  }
  if (process.env.NODE_ENV === "production") throw new DbError("not_configured");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new DbError("not_configured");
  db = createPgDb({ connectionString });
  return db;
}
