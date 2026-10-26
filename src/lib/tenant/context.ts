import type { Session } from "../auth/claims";
import { requireSession } from "../auth/session";
import { getDb, type Queryable } from "../db";

// The token's tenant has no membership row for this user: refused, and the transaction rolls back.
export class ForbiddenError extends Error {
  constructor() {
    super("no membership in this tenant");
    this.name = "ForbiddenError";
  }
}

// The only way pages and agent tools reach the database. Verify the token (or redirect to
// /sign-in), open a transaction scoped to the token's tenant, confirm the membership, then run fn.
// Two locks must agree: the immutable tenant claim on the token and the membership row. The
// policy already limits memberships to the token's tenant, so a claim for another tenant finds
// no row.
export async function withRequestTenant<T>(
  fn: (q: Queryable, session: Session) => Promise<T>,
): Promise<T> {
  const session = await requireSession();
  return getDb().withTenant(session.tenantId, async (q) => {
    const rows = await q.query<{ ok: number }>(
      "SELECT 1 AS ok FROM memberships WHERE cognito_sub = $1",
      [session.sub],
    );
    if (rows.length !== 1) throw new ForbiddenError();
    return fn(q, session);
  });
}
