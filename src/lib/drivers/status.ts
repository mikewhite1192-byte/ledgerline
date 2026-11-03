import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readMember } from "../advances/member";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { isCanonicalUuid } from "../money/keys";
import { readTenantZone } from "../money/read";
import { carrierToday } from "../tenant/shell";
import { daysBetween, isLocalDate, type LocalDate } from "../time/local-date";
import { driverAdminOn } from "./switch";

// Deactivating and reactivating a driver (design-d1-drivers 5.3). The state is drivers.active_to
// (0004): null is active, a date is the driver's last day with the carrier, the same column the
// rules engine, the card matcher and every page already read. Only an admin changes it, in their
// own carrier, behind the driver admin switch.
//
// One tenant transaction with the driver row locked FOR UPDATE (the same lock arming and every
// money gate's executor take), so an approval sees the driver before or after the change, never in
// between:
//   deactivate: active_to = the date given (today in the carrier's zone when none), and when the
//     driver is armed, money_armed = false with one driver_arm_events row ('ui', the member, note
//     "deactivated"), then one driver_status_events row (active false).
//   reactivate: active_to = null and one driver_status_events row (active true, effective_on the
//     date cleared). It never arms: an admin arms again on purpose, on the same page.
// Nothing already approved is touched: an advance or code in flight, a pay run, an escrow or a
// take-back carries on as it was. Only new money is refused, by the gates (src/lib/drivers/active.ts).
// Nothing is paid, sent or notified.
//
// Dedupe key: the driver row lock plus the transition itself, on whether active_to is null. A
// deactivation of a driver whose active_to is already set, or a reactivation of one whose
// active_to is null, is no change (changed false) and writes nothing; each UPDATE is guarded on the
// state it read, so the same request sent twice writes one change and one event, never two.

export type StatusRefusal = "disabled" | "role" | "bad_request" | "not_found";

export type StatusResult =
  | { ok: true; changed: boolean; active: boolean; activeTo: LocalDate | null; armed: boolean }
  | { ok: false; category: StatusRefusal; retryable: false };

// How far a last day may sit from today in the carrier's zone, either side, the same bound as a
// start date when a driver is added. Further out is a typing slip, refused before anything is written.
export const STATUS_DATE_MAX_DAYS = 366;

const NOTE_MAX = 240;

// The route's body: strict, so an unknown field is refused. A date goes only with a deactivation.
export const StatusBody = z.strictObject({
  active: z.boolean(),
  effectiveOn: z.string().refine(isLocalDate).optional(),
  note: z.string().max(NOTE_MAX).optional(),
});

export type StatusChange = { active: boolean; effectiveOn?: string | null; note?: string | null };

export type StatusTransition = "noop" | "deactivate" | "reactivate";

// From whether the driver has a last day on file and what was asked. Moving a last day already on
// file is not offered: reactivate, then deactivate again, and both are on the log.
export function statusTransition(activeTo: LocalDate | null, wanted: boolean): StatusTransition {
  if (wanted) return activeTo === null ? "noop" : "reactivate";
  return activeTo === null ? "deactivate" : "noop";
}

const refuse = (category: StatusRefusal): StatusResult => ({ ok: false, category, retryable: false });

export async function setDriverStatus(
  session: Session,
  driverId: string,
  change: StatusChange,
  deps: { db?: TenantDb; clock?: () => Date; newId?: () => string } = {},
): Promise<StatusResult> {
  // Asked here as well as on the page and the route, so a caller that skips them is still refused.
  if (!driverAdminOn()) return refuse("disabled");
  if (!isCanonicalUuid(driverId) || typeof change.active !== "boolean") return refuse("bad_request");
  const effectiveOn = change.effectiveOn ?? null;
  if (effectiveOn !== null && (change.active || !isLocalDate(effectiveOn))) return refuse("bad_request");
  const note = typeof change.note === "string" && change.note.trim().length > 0 ? change.note.trim() : null;
  if (note !== null && note.length > NOTE_MAX) return refuse("bad_request");
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const newId = deps.newId ?? randomUUID;
  return db.withTenant(session.tenantId, async (q) => {
    const member = await readMember(q, session);
    if (member.role !== "admin") return refuse("role");
    const today = carrierToday(await readTenantZone(q), now);
    const rows = await q.query<{ active_from: string; active_to: string | null; money_armed: boolean }>(
      `SELECT to_char(active_from, 'YYYY-MM-DD') AS active_from, to_char(active_to, 'YYYY-MM-DD') AS active_to,
              money_armed
         FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
      [driverId],
    );
    if (rows.length !== 1) return refuse("not_found");
    const row = rows[0];
    const armed = row.money_armed === true;
    const step = statusTransition(row.active_to, change.active);
    if (step === "noop") {
      return { ok: true, changed: false, active: row.active_to === null, activeTo: row.active_to, armed } as const;
    }
    if (step === "reactivate") {
      const cleared = row.active_to as LocalDate;
      const updated = await q.execute(
        `UPDATE drivers SET active_to = NULL
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND active_to IS NOT NULL`,
        [driverId],
      );
      // Under the row lock the state read above holds; a guarded update that wrote nothing is a
      // state this code does not know, so it is thrown (the route answers unavailable).
      if (updated !== 1) throw new Error("driver reactivation wrote nothing");
      await insertStatusEvent(q, newId(), driverId, true, cleared, note, member.id, nowIso);
      return { ok: true, changed: true, active: true, activeTo: null, armed } as const;
    }
    const lastDay = effectiveOn ?? today;
    if (!isLocalDate(row.active_from) || lastDay < row.active_from) return refuse("bad_request");
    if (Math.abs(daysBetween(today, lastDay)) > STATUS_DATE_MAX_DAYS) return refuse("bad_request");
    const updated = await q.execute(
      `UPDATE drivers SET active_to = CAST($2 AS date)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND active_to IS NULL`,
      [driverId, lastDay],
    );
    if (updated !== 1) throw new Error("driver deactivation wrote nothing");
    if (armed) {
      // Disarmed in the same transaction, so no approval can find the driver gone but still armed.
      // The last armed time stays as history, as a disarm from the money panel keeps it.
      const disarmed = await q.execute(
        `UPDATE drivers SET money_armed = false
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND money_armed`,
        [driverId],
      );
      if (disarmed !== 1) throw new Error("driver disarm on deactivation wrote nothing");
      await q.execute(
        `INSERT INTO driver_arm_events (id, tenant_id, driver_id, armed, note, membership_id, source, created_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), false, 'deactivated', CAST($3 AS uuid), 'ui',
                 CAST($4 AS timestamptz))`,
        [newId(), driverId, member.id, nowIso],
      );
    }
    await insertStatusEvent(q, newId(), driverId, false, lastDay, note, member.id, nowIso);
    return { ok: true, changed: true, active: lastDay >= today, activeTo: lastDay, armed: false } as const;
  });
}

async function insertStatusEvent(
  q: Queryable,
  id: string,
  driverId: string,
  active: boolean,
  effectiveOn: LocalDate,
  note: string | null,
  membershipId: string,
  nowIso: string,
): Promise<void> {
  await q.execute(
    `INSERT INTO driver_status_events (id, tenant_id, driver_id, active, effective_on, note, membership_id, created_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS date), $5, CAST($6 AS uuid),
             CAST($7 AS timestamptz))`,
    [id, driverId, active, effectiveOn, note, membershipId, nowIso],
  );
}
