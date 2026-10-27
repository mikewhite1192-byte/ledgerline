import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { localDateOf, type LocalDate } from "../time/local-date";
import { ForbiddenError } from "./context";

export type ShellTenant = { name: string; email: string; timezone: string };

// The carrier chip on every signed-in page: the tenant's name and zone and this member's email,
// each read naming its tenant. No row is a refusal, never an empty chip.
export async function readShell(q: Queryable, session: Session): Promise<ShellTenant> {
  const tenants = await q.query<{ name: string; timezone: string }>(
    "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
  );
  const members = await q.query<{ email: string }>(
    "SELECT email FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
  return { name: tenants[0].name, timezone: tenants[0].timezone, email: members[0].email };
}

// The carrier's today, from the request's clock in the carrier's zone.
export function carrierToday(timezone: string, now: Date): LocalDate {
  return localDateOf(now.toISOString(), timezone);
}
