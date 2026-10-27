import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { assertMembership, ForbiddenError } from "../tenant/context";

// The signed-in member in this tenant: the id a change names and the role it is allowed by.
export type Member = { id: string; role: "admin" | "staff" };

export async function readMember(q: Queryable, session: Session): Promise<Member> {
  await assertMembership(q, session);
  const rows = await q.query<{ id: string; role: string }>(
    "SELECT id, role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  if (rows.length !== 1) throw new ForbiddenError();
  const role = rows[0].role;
  if (role !== "admin" && role !== "staff") throw new ForbiddenError();
  return { id: rows[0].id, role };
}
