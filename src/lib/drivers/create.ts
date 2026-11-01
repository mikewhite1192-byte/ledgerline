import { randomUUID } from "node:crypto";
import { readMember } from "../advances/member";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { ForbiddenError } from "../tenant/context";
import { carrierToday } from "../tenant/shell";
import { daysBetween } from "../time/local-date";
import { DriverDraft } from "./draft";
import { driverAdminOn } from "./switch";

// Adding a driver (design-d1-drivers 5.2). Only an admin adds one, in their own carrier: one tenant
// transaction under row level security, one drivers row and nothing else. The new driver starts
// not armed (money_armed false) with no card, no escrow and no dispatch id, so no money action can
// reach them until an admin adds a card and arms them on their page. Nothing is paid or sent.
//
// Dedupe key: the driver's code within the carrier, UNIQUE (tenant_id, code), with the email,
// UNIQUE (tenant_id, email), beside it. The same form sent twice writes one row: the second send
// finds the code on file (or, sent at the same instant, its insert conflicts and writes nothing)
// and is answered code_taken. An email that differs only in case from one on file is email_taken.

export type CreateRefusal = "disabled" | "role" | "bad_request" | "code_taken" | "email_taken";

export type CreateResult =
  | { ok: true; changed: true; id: string }
  | { ok: false; category: CreateRefusal; retryable: false };

// How far a start date may sit from today in the carrier's zone, either side. A date further out
// is a typing slip (a wrong year), refused as bad_request before anything is written.
export const ACTIVE_FROM_MAX_DAYS = 366;

const refuse = (category: CreateRefusal): CreateResult => ({ ok: false, category, retryable: false });

export async function createDriver(
  session: Session,
  input: unknown,
  deps: { db?: TenantDb; clock?: () => Date; newId?: () => string } = {},
): Promise<CreateResult> {
  // Asked here as well as on the page and the route, so a caller that skips them is still refused.
  if (!driverAdminOn()) return refuse("disabled");
  const parsed = DriverDraft.safeParse(input);
  if (!parsed.success) return refuse("bad_request");
  const d = parsed.data;
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  const newId = deps.newId ?? randomUUID;
  return db.withTenant(session.tenantId, async (q) => {
    const member = await readMember(q, session);
    if (member.role !== "admin") return refuse("role");
    const tenants = await q.query<{ timezone: string }>("SELECT timezone FROM tenants WHERE id = current_tenant_id()");
    if (tenants.length !== 1) throw new ForbiddenError();
    const today = carrierToday(tenants[0].timezone, now);
    if (d.activeFrom !== undefined && Math.abs(daysBetween(today, d.activeFrom)) > ACTIVE_FROM_MAX_DAYS) {
      return refuse("bad_request");
    }
    const activeFrom = d.activeFrom ?? today;
    const before = await taken(q, d.code, d.email);
    if (before !== null) return refuse(before);
    const id = newId();
    const inserted = await q.execute(
      `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
                            per_mile_cents, percent_bps, flat_per_load_cents, advance_limit_cents,
                            truck_unit, tank_gallons, active_from, preferred_language, own_insurance,
                            money_armed, escrow_balance_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               CAST($14 AS date), $15, $16, false, 0)
       ON CONFLICT DO NOTHING`,
      [
        id,
        d.code,
        d.firstName,
        d.lastName,
        d.email,
        d.workerType,
        d.payBasis,
        d.payBasis === "per_mile" ? d.perMileCents : null,
        d.payBasis === "percent" ? d.percentBps : null,
        d.payBasis === "flat" ? d.flatPerLoadCents : null,
        d.advanceLimitCents ?? null,
        d.truckUnit ?? null,
        d.tankGallons,
        activeFrom,
        d.preferredLanguage,
        d.ownInsurance,
      ],
    );
    if (inserted === 1) return { ok: true, changed: true, id } as const;
    // Nothing was written: another send of the same driver committed between the check and the
    // insert. Name the key it met; a conflict on neither is one this code does not know, so it is
    // thrown (the route answers unavailable), never reported as done.
    const after = await taken(q, d.code, d.email);
    if (after !== null) return refuse(after);
    throw new Error("driver insert wrote nothing");
  });
}

// Which key a new driver would meet in this carrier, each compared whole: the code first (the same
// form sent again), then the email in any case.
async function taken(q: Queryable, code: string, email: string): Promise<"code_taken" | "email_taken" | null> {
  const rows = await q.query<{ code_taken: boolean; email_taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM drivers WHERE tenant_id = current_tenant_id() AND code = $1) AS code_taken,
            EXISTS (SELECT 1 FROM drivers WHERE tenant_id = current_tenant_id() AND lower(email) = $2) AS email_taken`,
    [code, email],
  );
  if (rows.length !== 1) throw new Error("driver key check read no row");
  if (rows[0].code_taken === true) return "code_taken";
  if (rows[0].email_taken === true) return "email_taken";
  return null;
}
