import type { Session } from "../../auth/claims";
import type { Queryable, TenantDb } from "../../db";
import { assertMembership } from "../../tenant/context";

// The one way the agent side opens a transaction: scoped to the token's tenant, with the
// membership row confirmed first (design 3.7). The gateway's own calls and the turn store both
// use it, so route and operator code never reach the database or the tenant context directly.
export async function withAgentTenant<T>(
  db: TenantDb,
  session: Session,
  fn: (q: Queryable) => Promise<T>,
): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}
