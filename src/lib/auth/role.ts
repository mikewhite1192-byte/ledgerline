import type { Queryable } from "../db";
import { isJudge, isRole, type Role, type StaffRole } from "../roles";
import { ForbiddenError } from "../tenant/context";
import type { Session } from "./claims";

// The roles live in src/lib/roles.ts (plain values the shared components may import).
export { ROLES, isJudge, isRole, type Role, type StaffRole } from "../roles";

// Inside a transaction already scoped to session.tenantId: the subject's one membership role in that
// tenant. No row, more than one, or a role this code does not know is refused (fail closed).
export async function readRole(q: Queryable, session: Session): Promise<Role> {
  if (!session.sub) throw new ForbiddenError();
  const rows = await q.query<{ role: unknown }>(
    "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  if (rows.length !== 1) throw new ForbiddenError();
  const role = rows[0].role;
  if (!isRole(role)) throw new ForbiddenError();
  return role;
}

// The one check every write route and server action outside src/lib/auth/judge-allowlist.ts makes:
// a judge is refused with reason "judge"; admin and staff go on with their role.
export async function requireStaff(q: Queryable, session: Session): Promise<StaffRole> {
  const role = await readRole(q, session);
  if (isJudge(role)) throw new ForbiddenError("judge");
  return role;
}
