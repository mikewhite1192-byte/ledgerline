import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { readTenant } from "../data/read";
import { assertMembership } from "../tenant/context";
import type { ReportRequest } from "./args";
import { computeReport } from "./run";
import type { ReportResult } from "./types";

// A report for the signed-in person's carrier: one transaction scoped to the token's tenant, the
// membership row confirmed first, the dates read in the carrier's own time zone.
export async function reportForSession(
  session: Session,
  request: ReportRequest,
  now: Date,
  db: TenantDb = getDb(),
): Promise<ReportResult> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const tenant = await readTenant(q);
    if (!tenant) throw new Error("no tenant is set");
    return computeReport(q, request, { now, timeZone: tenant.timezone });
  });
}
