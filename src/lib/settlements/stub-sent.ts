import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { formatLocalDate } from "../format/dates";
import { formatCents } from "../format/money";
import { isCanonicalUuid } from "../money/keys";
import { isRole, type Role } from "../roles";
import { staffMembershipId } from "./named-line";
import { readStoredSettlement } from "./stored";

// Stub sent (design-s10, 0086): a staff member records that they sent a driver's paid paystub to
// the driver, when and who. The app sends nothing: there is no send tool and no send path, and
// the mark is only ever made by a person's click. The agent reads the mark and names the person by
// role only; no membership id or email ever leaves this file.
//
// One tenant transaction: the caller must be staff (a judge is refused by requireStaff), then the
// paystub is locked. Missing (another carrier's stub reads as missing under row security) is
// not_found; anything but paid is not_paid_yet. A stub already marked is returned as it stands
// with already: true and nothing is written, so a second click is one write. Otherwise one UPDATE,
// guarded on paid and unmarked; under the row lock any count but one is unknown and throws.
// Dedupe key: the row itself (stub_sent_at IS NULL). No undo.

export type StubSentRefusal = "disabled" | "bad_request" | "not_found" | "not_paid_yet";

export type StubSentResult =
  | { ok: true; already: boolean; sentAt: string }
  | { ok: false; category: StubSentRefusal; retryable: false };

const refuse = (category: StubSentRefusal): { ok: false; category: StubSentRefusal; retryable: false } => ({
  ok: false,
  category,
  retryable: false,
});

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

async function mark(q: Queryable, session: Session, settlementId: string, now: Date): Promise<StubSentResult> {
  const membership = await staffMembershipId(q, session);
  const stored = await readStoredSettlement(q, settlementId, true);
  if (!stored) return refuse("not_found");
  if (stored.status !== "paid") return refuse("not_paid_yet");
  if (stored.stubSentAt !== null) return { ok: true, already: true, sentAt: stored.stubSentAt };
  const rows = await q.query<{ stub_sent_at: string }>(
    `UPDATE settlements SET stub_sent_at = CAST($2 AS timestamptz), stub_sent_by = CAST($3 AS uuid)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'paid' AND stub_sent_at IS NULL
     RETURNING to_char(stub_sent_at AT TIME ZONE 'UTC', ${ISO}) AS stub_sent_at`,
    [stored.id, now.toISOString(), membership],
  );
  if (rows.length !== 1) throw new Error("the stub sent mark was not written");
  return { ok: true, already: false, sentAt: rows[0].stub_sent_at };
}

export async function markStubSent(
  db: TenantDb,
  session: Session,
  settlementId: string,
  now: Date,
): Promise<StubSentResult> {
  // Asked here as well as by the route, so a caller that skips the route is still refused.
  if (!flags.stubSent.enabled || !flags.settlementsEnabled) return refuse("disabled");
  if (!isCanonicalUuid(settlementId)) return refuse("bad_request");
  return db.withTenant(session.tenantId, (q) => mark(q, session, settlementId, now));
}

export type StubSent = { at: string; byRole: Role };

// The mark on one paystub, the person named by their role; null while unmarked. Not switched: a
// mark a person made stays readable after a rollback.
export async function readStubSent(q: Queryable, settlementId: string): Promise<StubSent | null> {
  const rows = await q.query<{ at: string; role: string }>(
    `SELECT to_char(s.stub_sent_at AT TIME ZONE 'UTC', ${ISO}) AS at, m.role
       FROM settlements s
       JOIN memberships m ON m.tenant_id = s.tenant_id AND m.id = s.stub_sent_by
      WHERE s.tenant_id = current_tenant_id() AND s.id = CAST($1 AS uuid) AND s.stub_sent_at IS NOT NULL`,
    [settlementId],
  );
  if (rows.length === 0) return null;
  const role = rows[0].role;
  if (rows.length !== 1 || !isRole(role)) throw new Error("the stub sent mark could not be read");
  return { at: rows[0].at, byRole: role };
}

export type StubSummaryInput = {
  driverName: string;
  driverCode: string;
  periodEnd: string;
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  carryForwardCents: number;
  // The calendar day the stub was paid, in the carrier's zone.
  paidOn: string;
};

// One line a person can read to the driver, written by code from the stored totals the engine
// computed and the pre-pay recheck confirmed to the cent; the model may read it out but never
// writes a figure in it. Pure: no clock, no rounding.
export function stubSummary(input: StubSummaryInput): string {
  const carry = input.carryForwardCents > 0 ? `; ${formatCents(input.carryForwardCents)} carried to next week` : "";
  return (
    `Pay stub for ${input.driverName} (${input.driverCode}), week ending ${formatLocalDate(input.periodEnd)}: ` +
    `gross ${formatCents(input.grossCents)}, deductions ${formatCents(input.deductionsCents)}, ` +
    `net ${formatCents(input.netCents)}${carry}. Paid ${formatLocalDate(input.paidOn)}.`
  );
}
