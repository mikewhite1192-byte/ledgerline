import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Session } from "../auth/claims";
import { requireStaff } from "../auth/role";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { isCanonicalUuid } from "../money/keys";
import { cents } from "../rules-engine";
import { findContradictions, parseSourceRef, sourceRefOf, type NamedRef } from "./contradiction";
import { rowKey } from "./reconcile";
import { runPayPeriod } from "./run";
import { readPeriod, readStoredSettlement, tenantLock } from "./stored";

// A named stub line (design-s8, 0084): a staff member puts one reimbursement or deduction on a
// driver's open draft paystub that cites one real record of that driver, a fuel purchase or a lumper
// the driver paid, with their name on it. It is never a line written past the engine: it is a pay
// item, and the rules engine makes the line and the totals from it as from every other item.
//
// Two steps:
//   1. One tenant transaction, the run lock then the draft locked (the order the pay run takes
//      them): the caller must be staff, the draft open and unparked, its week open and on or after
//      the settlements start. The record is read under row security, bound to the draft's driver;
//      none is source_missing. Another pay item already citing it is already_cited (a named line
//      must not pay it twice). An amount other than the record's, to the cent, is
//      contradicting_line. Each refusal writes nothing. Clean: one pay item, upserted on its
//      item_ref.
//   2. "Run the week" for that week, the same call the button makes: the engine turns the item
//      into the line, rewrites the draft and replaces its card.
//
// Dedupe key: pay_items.item_ref 'named:<settlement id>:<table>:<record id>'. The same request
// twice is one item and one line; a new amount for the same record replaces the item while it is
// unsettled, which is also the fix when the record changed after entry. If step 2 fails after step
// 1 committed, the item stays and the next run adopts it: nothing is lost and nothing doubles.
// Nothing here moves money or writes outside the app.

export const NAMED_LINE_SUBKIND = "named";
export const NAMED_LABEL_MAX = 80;

export const namedItemRef = (settlementId: string, ref: NamedRef): string =>
  `named:${settlementId}:${sourceRefOf(ref)}`;

// The route's body, strict: any other key is refused. Money is whole cents, above zero and below
// the column's bound; the label is optional, 1 to 80 characters with no control characters.
export const NamedLineBody = z.strictObject({
  kind: z.enum(["reimbursement", "other_deduction"]),
  sourceRef: z.string().max(120),
  amountCents: z.int().positive().lt(1_000_000_000),
  label: z
    .string()
    .trim()
    .min(1)
    .max(NAMED_LABEL_MAX)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s))
    .optional(),
});
export type NamedLineInput = z.infer<typeof NamedLineBody>;

export type NamedLineRefusal =
  | "disabled"
  | "bad_request"
  | "not_found"
  | "not_draft"
  | "parked"
  | "not_open"
  | "before_start"
  | "source_missing"
  | "already_cited"
  | "contradicting_line";

export type NamedLineResult =
  | { ok: true; settlementId: string; payItemId: string }
  | { ok: false; category: NamedLineRefusal; retryable: false };

const refuse = (category: NamedLineRefusal): { ok: false; category: NamedLineRefusal; retryable: false } => ({
  ok: false,
  category,
  retryable: false,
});

// The caller's membership id, which entered_by names; requireStaff first, so a judge is refused.
async function staffMembershipId(q: Queryable, session: Session): Promise<string> {
  await requireStaff(q, session);
  const [m] = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  if (!m || !isCanonicalUuid(m.id)) throw new Error("membership could not be read");
  return m.id;
}

// The record's amount, read bound to the driver; null when there is no such record of theirs. A
// load accessorial counts only as a lumper the driver paid (0004: the only one a driver pays, and
// detention, layover and stop pay are already on the load's accessorial line).
async function readRecordAmount(q: Queryable, ref: NamedRef, driverId: string): Promise<number | null> {
  const rows =
    ref.table === "fuel_purchases"
      ? await q.query<{ amount_cents: number | string }>(
          `SELECT amount_cents FROM fuel_purchases
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)`,
          [ref.id, driverId],
        )
      : await q.query<{ amount_cents: number | string }>(
          `SELECT a.amount_cents FROM load_accessorials a
             JOIN loads l ON l.tenant_id = a.tenant_id AND l.id = a.load_id
            WHERE a.tenant_id = current_tenant_id() AND a.id = CAST($1 AS uuid)
              AND l.driver_id = CAST($2 AS uuid) AND a.paid_by_driver`,
          [ref.id, driverId],
        );
  if (rows.length !== 1) return null;
  const n = Number(rows[0].amount_cents);
  return Number.isSafeInteger(n) ? n : null;
}

type Entry = { ok: true; periodId: string; payItemId: string } | { ok: false; category: NamedLineRefusal };

async function enter(q: Queryable, session: Session, settlementId: string, input: NamedLineInput): Promise<Entry> {
  const membership = await staffMembershipId(q, session);
  // The pay run's lock before the draft's row lock, the order draftDriver takes them.
  await tenantLock(q, "settlement_run");
  const stored = await readStoredSettlement(q, settlementId, true);
  if (!stored) return refuse("not_found");
  if (stored.status !== "draft") return refuse("not_draft");
  if (stored.parkedReason !== null) return refuse("parked");
  const period = await readPeriod(q, stored.periodId);
  if (!period) return refuse("not_found");
  if (period.status !== "open") return refuse("not_open");
  if (period.start < flags.settlementsStart) return refuse("before_start");

  const ref = parseSourceRef(input.sourceRef);
  if (!ref) return refuse("source_missing");
  const recordCents = await readRecordAmount(q, ref, stored.driverId);
  if (recordCents === null) return refuse("source_missing");
  const itemRef = namedItemRef(stored.id, ref);
  const others = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM pay_items
      WHERE tenant_id = current_tenant_id() AND ref_table = $1 AND ref_id = CAST($2 AS uuid) AND item_ref <> $3`,
    [ref.table, ref.id, itemRef],
  );
  if (Number(others[0]?.n ?? NaN) !== 0) return refuse("already_cited");
  // The entry check is the approval's own rule on the line this item becomes.
  const line = {
    kind: input.kind,
    amountCents: cents(input.kind === "reimbursement" ? input.amountCents : -input.amountCents, "named line"),
    sources: [],
    enteredBy: membership,
    sourceRef: sourceRefOf(ref),
  };
  const facts = { amounts: new Map([[rowKey(ref), recordCents]]), days: new Map<string, string | null>() };
  if (findContradictions([line], facts, stored.id).length > 0) return refuse("contradicting_line");

  const description =
    input.label ?? (ref.table === "fuel_purchases" ? "Fuel purchase named by staff" : "Accessorial named by staff");
  const rows = await q.query<{ id: string }>(
    `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date, ref_table, ref_id,
                            item_ref, description, settlement_id, entered_by)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, CAST($6 AS date), $7,
             CAST($8 AS uuid), $9, $10, NULL, CAST($11 AS uuid))
     ON CONFLICT (tenant_id, item_ref) DO UPDATE
        SET kind = EXCLUDED.kind, amount_cents = EXCLUDED.amount_cents, description = EXCLUDED.description,
            entered_by = EXCLUDED.entered_by
      WHERE pay_items.settlement_id IS NULL AND pay_items.driver_id = EXCLUDED.driver_id
     RETURNING CAST(id AS text) AS id`,
    [
      randomUUID(),
      stored.driverId,
      input.kind,
      NAMED_LINE_SUBKIND,
      input.amountCents,
      period.end,
      ref.table,
      ref.id,
      itemRef,
      description,
      membership,
    ],
  );
  // A conflict that updated nothing: the item is already on a paid stub.
  if (rows.length !== 1) return refuse("not_draft");
  return { ok: true, periodId: stored.periodId, payItemId: rows[0].id };
}

export async function addNamedLine(
  db: TenantDb,
  session: Session,
  settlementId: string,
  body: unknown,
  now: Date,
): Promise<NamedLineResult> {
  // Asked here as well as by the route, so a caller that skips the route is still refused.
  if (!flags.namedLines.enabled || !flags.settlementsEnabled) return refuse("disabled");
  if (!isCanonicalUuid(settlementId)) return refuse("bad_request");
  const parsed = NamedLineBody.safeParse(body);
  if (!parsed.success) return refuse("bad_request");
  const entry = await db.withTenant(session.tenantId, (q) => enter(q, session, settlementId, parsed.data));
  if (!entry.ok) return refuse(entry.category);
  const run = await runPayPeriod(db, session, entry.periodId, now);
  if (!run.ok) return refuse(run.category);
  return { ok: true, settlementId, payItemId: entry.payItemId };
}
