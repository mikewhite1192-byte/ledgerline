import type { Db } from "./types";

// Database tests only. Brings the query planner's row counts up to date after a test file seeds
// its carriers, so its plans fit the rows it just wrote.
//
// The database tests run one file after another on one database. A file's cleanup empties
// tables that hold thousands of rows, and autovacuum may record those counts while the tables
// are still empty (as it did on CI). The next file then refills the same pages, the planner reads
// "no rows here" and picks nested loops, and the invoice queue's read of its loads went from a
// few milliseconds to four seconds or more per call. ANALYZE reads a sample of every table and
// writes no rows; it needs the admin login (it skips tables the caller does not own).
export async function refreshPlannerStats(admin: Db): Promise<void> {
  await admin.withoutTenant((q) => q.execute("ANALYZE"));
}
