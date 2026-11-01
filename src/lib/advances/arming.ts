import { randomUUID } from "node:crypto";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { isCanonicalUuid } from "../money/keys";
import { activationOn, readActivationChecklist, type ArmBlocker } from "./activation";
import { readMember } from "./member";

// Arming a driver: whether money may go to them at all, separate from the card on file. A new
// driver is not armed. Only an admin arms or disarms (decision D-034). One tenant transaction
// with the driver locked, so an approval that locks the same driver sees the state before or
// after the change, never in between; every change writes one row to the append-only log. While
// the activation checklist is on (./activation.ts), arming a driver who is not armed is refused
// with the first step still missing; a driver already armed, and every disarm, never read it.

export type ArmTransition = "noop" | "arm" | "disarm";

export function armTransition(current: boolean, wanted: boolean): ArmTransition {
  if (current === wanted) return "noop";
  return wanted ? "arm" : "disarm";
}

export type ArmResult =
  | { ok: true; changed: boolean; armed: boolean; armedAt: string | null }
  | { ok: false; category: "not_found" | "role" | "bad_request" | "driver_inactive" | ArmBlocker; retryable: false };

const NOTE_MAX = 240;

export async function armDriver(
  session: Session,
  driverId: string,
  change: { armed: boolean; note?: string | null },
  deps: { db?: TenantDb; clock?: () => Date; newId?: () => string } = {},
): Promise<ArmResult> {
  if (!isCanonicalUuid(driverId) || typeof change.armed !== "boolean") {
    return { ok: false, category: "bad_request", retryable: false };
  }
  const note = typeof change.note === "string" && change.note.trim().length > 0 ? change.note.trim() : null;
  if (note !== null && note.length > NOTE_MAX) return { ok: false, category: "bad_request", retryable: false };
  const db = deps.db ?? getDb();
  const nowIso = (deps.clock ?? (() => new Date()))().toISOString();
  const newId = deps.newId ?? randomUUID;
  return db.withTenant(session.tenantId, async (q) => {
    const member = await readMember(q, session);
    if (member.role !== "admin") return { ok: false, category: "role", retryable: false } as const;
    const rows = await q.query<{ money_armed: boolean; money_armed_at: string | null; active_to: string | null }>(
      `SELECT money_armed,
              to_char(money_armed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS money_armed_at,
              to_char(active_to, 'YYYY-MM-DD') AS active_to
         FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
      [driverId],
    );
    if (rows.length !== 1) return { ok: false, category: "not_found", retryable: false } as const;
    // A driver with a last day on file is never armed: an admin reactivates them first
    // (src/lib/drivers/status.ts). Disarming them stays allowed.
    if (change.armed && rows[0].active_to !== null) {
      return { ok: false, category: "driver_inactive", retryable: false } as const;
    }
    const current = rows[0].money_armed === true;
    const step = armTransition(current, change.armed);
    if (step === "noop") {
      return { ok: true, changed: false, armed: current, armedAt: rows[0].money_armed_at } as const;
    }
    // Only the false-to-true arm, read under the driver's row lock in the same transaction as the
    // write. Off, nothing is read and the arm is exactly as before.
    if (step === "arm" && activationOn()) {
      const checklist = await readActivationChecklist(q, driverId);
      if (checklist.blockers.length > 0) {
        return { ok: false, category: checklist.blockers[0], retryable: false } as const;
      }
    }
    // Arming stamps the time; disarming keeps the last armed time as history.
    await q.execute(
      `UPDATE drivers
          SET money_armed = $2,
              money_armed_at = CASE WHEN $2 THEN CAST($3 AS timestamptz) ELSE money_armed_at END
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [driverId, change.armed, nowIso],
    );
    await q.execute(
      `INSERT INTO driver_arm_events (id, tenant_id, driver_id, armed, note, membership_id, source, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, CAST($5 AS uuid), 'ui',
               CAST($6 AS timestamptz))`,
      [newId(), driverId, change.armed, note, member.id, nowIso],
    );
    return {
      ok: true,
      changed: true,
      armed: change.armed,
      armedAt: change.armed ? nowIso : rows[0].money_armed_at,
    } as const;
  });
}
