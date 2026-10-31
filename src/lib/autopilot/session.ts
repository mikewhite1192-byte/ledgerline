import type { Session } from "../auth/claims";
import type { TenantDb } from "../db";
import { isUuid } from "../uuid";

// The autopilot's own login in each carrier (0070): staff, never admin, and its sub is not a
// Cognito id, so nobody can sign in as it and the approve routes (Cognito sessions only) never see
// it. It approves only through the approval gate with opts.autopilot, under a live, unpaused
// rule on Auto (src/lib/proposals/execute.ts); a database trigger refuses any approval it makes
// without an auto decision in the same statement.

const PREFIX = "service:autopilot:";

export const autopilotSub = (tenantId: string) => `${PREFIX}${tenantId.toLowerCase()}`;

export const isAutopilotSub = (sub: unknown): boolean => typeof sub === "string" && sub.startsWith(PREFIX);

// The autopilot session, read from the carrier's membership row; null when the row is missing or
// is not staff (a row that says admin is not the autopilot's).
export async function autopilotSession(db: TenantDb, tenantId: string): Promise<Session | null> {
  if (!isUuid(tenantId)) return null;
  const sub = autopilotSub(tenantId);
  const rows = await db.withTenant(tenantId, (q) =>
    q.query<{ email: string; role: string }>(
      "SELECT email, role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
      [sub],
    ),
  );
  if (rows.length !== 1 || rows[0].role !== "staff") return null;
  return { sub, email: rows[0].email, tenantId: tenantId.toLowerCase() };
}
