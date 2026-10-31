import type { Session } from "../auth/claims";
import { requireStaff } from "../auth/role";
import { DbError, getDb, type TenantDb } from "../db";
import { isAutopilotSub } from "./session";
import { isServiceSub } from "../sweep/service-session";

// The "Pause autopilot" switch. Any staff member may pause (stopping is always allowed); only an
// admin may resume, and a demo visitor may do neither. A pause set here holds until a person
// resumes it; the demo reset's own pause ends by itself (src/lib/seed/reset.ts). The desk handler
// and the approval gate both read it before the autopilot approves anything. No model call, and
// nothing here approves or moves money.

export type PauseResult =
  | { ok: true; paused: boolean }
  | { ok: false; category: "role" | "forbidden" };

const PAUSE_SQL = `INSERT INTO autopilot_state (tenant_id, paused_at, paused_by, paused_until, updated_at)
VALUES (current_tenant_id(), CAST($1 AS timestamptz), $2, NULL, CAST($1 AS timestamptz))
ON CONFLICT (tenant_id) DO UPDATE
  SET paused_at = EXCLUDED.paused_at, paused_by = EXCLUDED.paused_by, paused_until = NULL,
      updated_at = EXCLUDED.updated_at`;

const RESUME_SQL = `INSERT INTO autopilot_state (tenant_id, paused_at, paused_by, paused_until, updated_at)
VALUES (current_tenant_id(), NULL, NULL, NULL, CAST($1 AS timestamptz))
ON CONFLICT (tenant_id) DO UPDATE
  SET paused_at = NULL, paused_by = NULL, paused_until = NULL, updated_at = EXCLUDED.updated_at`;

export async function setPaused(
  session: Session,
  paused: boolean,
  deps: { db?: TenantDb; clock?: () => Date } = {},
): Promise<PauseResult> {
  if (typeof paused !== "boolean") throw new RangeError("paused must be a boolean");
  // A service login (the sweep's or the autopilot's) never sets the switch.
  if (isServiceSub(session.sub) || isAutopilotSub(session.sub)) return { ok: false, category: "forbidden" };
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  return db.withTenant(session.tenantId, async (q) => {
    const role = await requireStaff(q, session);
    if (!paused && role !== "admin") return { ok: false, category: "role" } as const;
    const written = await q.execute(paused ? PAUSE_SQL : RESUME_SQL, paused ? [now.toISOString(), session.sub] : [now.toISOString()]);
    if (written !== 1) throw new DbError("unknown");
    return { ok: true, paused } as const;
  });
}
