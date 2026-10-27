import { getDb, type Queryable, type TenantDb } from "../db";
import { parseCookie, sessionAlive } from "./session";

// The fictional portal's way into the database (design 3.1). It has no Cognito login: the
// portal cookie names a tenant and a session, the transaction is scoped to that tenant like
// every other, and the session row must be alive in that scope. Row security then limits every
// read to that tenant's portal rows. Any miss is null, and the page shows "No load found".
export async function withPortalTenant<T>(
  cookie: string | undefined,
  now: Date,
  fn: (q: Queryable, ids: { tenantId: string; sessionId: string }) => Promise<T>,
  db: TenantDb = getDb(),
): Promise<T | null> {
  const ids = parseCookie(cookie);
  if (!ids) return null;
  return db.withTenant(ids.tenantId, async (q) => {
    if (!(await sessionAlive(q, ids.sessionId, now))) return null;
    return fn(q, ids);
  });
}
