import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { ForbiddenError } from "../tenant/context";
import { isCanonicalUuid } from "./keys";
import type { Approval } from "./types";

// The only constructor of an Approval. Runs inside the tenant transaction the session's tenant
// opened: the verified token's subject must have exactly one membership in that tenant. The
// statement names the tenant itself as well as relying on row-level security, so a login that
// bypasses it (the cluster admin) still reads this tenant only. Agent code cannot import this
// file (eslint.config.mjs).
export async function approvalFrom(q: Queryable, session: Session): Promise<Approval> {
  if (typeof session.sub !== "string" || session.sub.length === 0) throw new ForbiddenError();
  const rows = await q.query<{ id: unknown; role: unknown; current: unknown }>(
    `SELECT id, role, CAST(current_tenant_id() AS text) AS current
       FROM memberships
      WHERE tenant_id = current_tenant_id() AND cognito_sub = $1`,
    [session.sub],
  );
  if (rows.length !== 1) throw new ForbiddenError();
  const [row] = rows;
  // The transaction must be the session's own tenant, compared whole (Postgres prints lowercase).
  if (typeof session.tenantId !== "string" || row.current !== session.tenantId.toLowerCase()) {
    throw new ForbiddenError();
  }
  if (!isCanonicalUuid(row.id) || (row.role !== "admin" && row.role !== "staff")) {
    throw new ForbiddenError();
  }
  return { membershipId: row.id, role: row.role, sub: session.sub } as Approval;
}
