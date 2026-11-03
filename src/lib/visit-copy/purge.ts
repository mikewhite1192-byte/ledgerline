import { markCopyDeleted, purgeCandidates, type PurgeCandidate } from "../auth/demo-visit";
import { WIPE_MARK_SQL } from "../data/writer";
import { DbError, type TenantDb } from "../db/types";
import { isUuid } from "../uuid";

// Deleting a visit's copy once its visit has ended plus flags.visitCopies.graceMinutes (lazily, at
// each new build, and by scripts/visit-copies-purge.ts). Everything runs as the app login.
//
// One copy, in two transactions:
// 1. In the copy's tenant: its tenants row, locked. None is a copy that was claimed but never
//    built, or already deleted. A row without demo_copy_of is not a copy, and nothing is deleted
//    (the purge never deletes a carrier of its own). Otherwise its model call totals move onto
//    ops.ai_spend's purged columns (0091, so the model calls invariant still balances: the shared
//    counters keep every cent the copy spent), the transaction is marked as the tenant's own wipe
//    (the settlements delete guard, 0087), and the tenants row is deleted, which deletes every row
//    of the copy with it (each table's tenant_id is ON DELETE CASCADE).
// 2. In the demo carrier: the visit's copy_deleted_at, so the copy is never looked for again.
// A failure between the two leaves the visit unmarked; the next purge finds no row in step 1 and
// marks it.

const LOCK_SQL = "SELECT demo_copy_of FROM tenants WHERE id = current_tenant_id() FOR UPDATE";

// The copy's model calls, counted as the invariant counts them (src/lib/invariants/model-calls.ts).
export const PURGED_TOTALS_SQL = `UPDATE ops.ai_spend s
    SET purged_spent_nanocents = s.purged_spent_nanocents + p.spent,
        purged_reserved_nanocents = s.purged_reserved_nanocents + p.reserved,
        purged_calls = s.purged_calls + p.calls,
        purged_wonder_spent_nanocents = s.purged_wonder_spent_nanocents + p.wonder_spent,
        purged_wonder_reserved_nanocents = s.purged_wonder_reserved_nanocents + p.wonder_reserved
   FROM (SELECT CAST(COALESCE(SUM(cost_nanocents), 0) AS bigint) AS spent,
                CAST(COALESCE(SUM(reserved_nanocents) FILTER (WHERE status IN ('reserved', 'unknown')), 0) AS bigint)
                  AS reserved,
                CAST(count(*) FILTER (WHERE status <> 'reserved') AS bigint) AS calls,
                CAST(COALESCE(SUM(cost_nanocents) FILTER (WHERE target = 'wonder'), 0) AS bigint) AS wonder_spent,
                CAST(COALESCE(SUM(reserved_nanocents)
                       FILTER (WHERE target = 'wonder' AND status IN ('reserved', 'unknown')), 0) AS bigint)
                  AS wonder_reserved
           FROM model_calls WHERE tenant_id = current_tenant_id()) p
  WHERE s.id = 1`;

export type PurgeOutcome = "purged" | "gone";

export class NotACopy extends Error {
  constructor() {
    super("the tenant is not a visit copy");
    this.name = "NotACopy";
  }
}

export async function purgeCopy(app: TenantDb, homeTenantId: string, c: PurgeCandidate): Promise<PurgeOutcome> {
  if (!isUuid(homeTenantId) || !isUuid(c.copyTenantId) || !isUuid(c.visitId)) throw new DbError("unknown");
  if (homeTenantId.toLowerCase() === c.copyTenantId.toLowerCase()) throw new NotACopy();
  const outcome = await app.withTenant(c.copyTenantId, async (q): Promise<PurgeOutcome> => {
    const rows = await q.query<{ demo_copy_of: unknown }>(LOCK_SQL, []);
    if (rows.length === 0) return "gone";
    if (rows.length !== 1) throw new DbError("unknown");
    if (typeof rows[0].demo_copy_of !== "string") throw new NotACopy();
    if ((await q.execute(PURGED_TOTALS_SQL, [])) !== 1) throw new DbError("unknown");
    await q.query(WIPE_MARK_SQL, []);
    const deleted = await q.execute(
      "DELETE FROM tenants WHERE id = current_tenant_id() AND demo_copy_of IS NOT NULL",
      [],
    );
    if (deleted !== 1) throw new DbError("unknown");
    return "purged";
  });
  await app.withTenant(homeTenantId, (q) => markCopyDeleted(q, { visitId: c.visitId, copyTenantId: c.copyTenantId }));
  return outcome;
}

export type PurgeReport = { purged: number; gone: number; failed: number };

// Up to `limit` copies of this demo carrier's ended visits, oldest first. A copy that fails is
// counted and left for the next purge; only the error's name is logged.
export async function purgeExpired(
  app: TenantDb,
  homeTenantId: string,
  input: { graceMinutes: number; limit: number },
): Promise<PurgeReport> {
  const report: PurgeReport = { purged: 0, gone: 0, failed: 0 };
  const candidates = await app.withTenant(homeTenantId, (q) => purgeCandidates(q, input));
  for (const c of candidates) {
    try {
      report[await purgeCopy(app, homeTenantId, c)] += 1;
    } catch (err) {
      report.failed += 1;
      console.error(`visit copy: a purge failed (${err instanceof Error ? err.name : "non-error"})`);
    }
  }
  return report;
}
