import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { isUuid } from "../uuid";

// The sweep's own login in each carrier (0018): staff, never admin, and its sub is not a Cognito
// id, so nobody can sign in as it and the approve routes (Cognito sessions only) never see it.
// Every sweep write (its conversation, turns, gateway calls, proposals, explanations and audits)
// runs under it, whoever pressed the button, so any staff member can carry a run on and the
// records say the sweep drafted them. The person's own session is used to check they belong to
// the carrier and is stored as started_by.

export const serviceSub = (tenantId: string) => `service:sweep:${tenantId.toLowerCase()}`;

export const isServiceSub = (sub: string) => sub.startsWith("service:sweep:");

// The service session, read from the carrier's membership row; null when the row is missing (the
// tenant was made before 0018 and the demo setup has not run since).
export async function serviceSession(db: TenantDb, tenantId: string): Promise<Session | null> {
  if (!isUuid(tenantId)) return null;
  const sub = serviceSub(tenantId);
  const rows = await db.withTenant(tenantId, (q) =>
    q.query<{ email: string; role: string }>(
      "SELECT email, role FROM memberships WHERE cognito_sub = $1",
      [sub],
    ),
  );
  // Never an admin: a row that says otherwise is not the sweep's.
  if (rows.length !== 1 || rows[0].role !== "staff") return null;
  return { sub, email: rows[0].email, tenantId: tenantId.toLowerCase() };
}
