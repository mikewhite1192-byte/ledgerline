import type { Session } from "../auth/claims";
import { requireStaff } from "../auth/role";
import { DbError, getDb, type TenantDb } from "../db";
import { isAutopilotSub } from "./session";
import { PAUSE_LOCK_SQL } from "./state-lock";
import { isServiceSub } from "../sweep/service-session";

// The "Pause autopilot" switch. Any staff member may pause (stopping is always allowed); only an
// admin may resume, and a demo visitor may do neither. A pause set here holds until a person
// resumes it; the demo reset's own pause ends by itself (src/lib/seed/reset.ts). The desk handler
// and the approval gate both read it before the autopilot approves anything. Each Pause and Resume
// is recorded in autopilot_changes (0089) in the same transaction as the switch, with the switch as
// it was and as it is now. No model call, and nothing here approves or moves money.

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

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// The switch as it is, locked until the transaction ends, so the record's before is the row this
// write replaces.
const BEFORE_SQL = `SELECT ${ts("paused_at")} AS paused_at, paused_by, ${ts("paused_until")} AS paused_until
  FROM autopilot_state WHERE tenant_id = current_tenant_id() FOR UPDATE`;

const RECORD_SQL = `INSERT INTO autopilot_changes (tenant_id, subject, before, after, changed_by, created_at)
VALUES (current_tenant_id(), 'pause', CAST($1 AS jsonb), CAST($2 AS jsonb), $3, CAST($4 AS timestamptz))`;

type PauseValues = { pausedAt: string | null; pausedBy: string | null; pausedUntil: string | null };

const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

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
    // One Pause or Resume (or demo reset) at a time per carrier. FOR UPDATE below locks nothing while
    // the carrier has no row yet, so without this two first presses would both record a before of null.
    await q.query(PAUSE_LOCK_SQL, []);
    const rows = await q.query<{ paused_at: unknown; paused_by: unknown; paused_until: unknown }>(BEFORE_SQL, []);
    if (rows.length > 1) throw new DbError("unknown");
    const before: PauseValues | null =
      rows.length === 0
        ? null
        : { pausedAt: textOrNull(rows[0].paused_at), pausedBy: textOrNull(rows[0].paused_by), pausedUntil: textOrNull(rows[0].paused_until) };
    const at = now.toISOString();
    const written = await q.execute(paused ? PAUSE_SQL : RESUME_SQL, paused ? [at, session.sub] : [at]);
    if (written !== 1) throw new DbError("unknown");
    const after: PauseValues = paused
      ? { pausedAt: at, pausedBy: session.sub, pausedUntil: null }
      : { pausedAt: null, pausedBy: null, pausedUntil: null };
    const recorded = await q.execute(RECORD_SQL, [before === null ? null : JSON.stringify(before), JSON.stringify(after), session.sub, at]);
    if (recorded !== 1) throw new DbError("unknown");
    return { ok: true, paused } as const;
  });
}
