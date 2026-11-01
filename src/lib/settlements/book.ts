import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import { NO_LIVE_PULL, readTenant } from "../data/read";
import { cents } from "../rules-engine";
import { isUuid } from "../uuid";
import { paidWritesOf } from "./paid";
import { readPeriod, readStoredLines, readStoredSettlement } from "./stored";

// The writes a paid settlement makes, the same ones the seed's history makes (paidWritesOf is
// shared): the settlement to paid with its escrow columns, every pay item its lines cite stamped
// with it, each advance recovery added, each deficit recovery added to its deficit (settled by this
// stub once it is whole), the driver's escrow balance moved to the closing balance, and next week's
// carried_shortfall item when the week ran short. All inside the caller's tenant
// transaction, with the settlement and the driver locked. Returns false when the settlement was
// already paid (a second confirm changes nothing), and throws on anything it cannot write whole,
// which rolls the caller's transaction back.

const uuidList = (ids: readonly string[]): string => {
  for (const id of ids) if (!isUuid(id)) throw new Error("not a record id");
  return `{${ids.join(",")}}`;
};

export async function bookPaidSettlement(q: Queryable, settlementId: string, now: Date): Promise<boolean> {
  const stored = await readStoredSettlement(q, settlementId, true);
  if (!stored) throw new Error("no such settlement");
  if (stored.status === "paid") return false;
  if (stored.status !== "approved") throw new Error("only an approved settlement is booked");
  const lines = await readStoredLines(q, settlementId);
  // A stub drafted while deficit recovery was on and paid after it was turned off waits for the
  // switch: nothing is written, so it never half-books.
  if (!flags.deficitRecovery.enabled && lines.some((l) => l.kind === "deficit_recovery")) {
    throw new Error("deficit recovery is off");
  }
  const period = await readPeriod(q, stored.periodId);
  const tenant = await readTenant(q);
  if (!period || !tenant) throw new Error("the settlement's period or carrier is missing");
  const [driver] = await q.query<{ escrow_balance_cents: number | string }>(
    `SELECT escrow_balance_cents FROM drivers
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [stored.driverId],
  );
  if (!driver) throw new Error("the settlement's driver is missing");
  const writes = paidWritesOf({
    settlementId,
    lines,
    carryForwardCents: cents(stored.carryForwardCents, "carry forward"),
    openingCents: Number(driver.escrow_balance_cents),
    periodEnd: period.end,
  });
  const at = now.toISOString();

  const paid = await q.execute(
    `UPDATE settlements
        SET status = 'paid', paid_at = CAST($2 AS timestamptz),
            escrow_opening_cents = $3, escrow_charges_cents = $4, escrow_withheld_cents = $5,
            escrow_closing_cents = $6
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
    [
      settlementId,
      at,
      writes.escrow.openingCents,
      writes.escrow.chargesCents,
      writes.escrow.withheldCents,
      writes.escrow.closingCents,
    ],
  );
  if (paid !== 1) throw new Error("settlement booking lost its lock");

  if (writes.stampItemIds.length > 0) {
    // An item already stamped by another settlement is never taken over: the count must match.
    const stamped = await q.execute(
      `UPDATE pay_items SET settlement_id = CAST($1 AS uuid)
        WHERE tenant_id = current_tenant_id() AND id = ANY(CAST($2 AS uuid[]))
          AND driver_id = CAST($3 AS uuid)
          AND (settlement_id IS NULL OR settlement_id = CAST($1 AS uuid))`,
      [settlementId, uuidList(writes.stampItemIds), stored.driverId],
    );
    if (stamped !== writes.stampItemIds.length) throw new Error("a pay item was settled elsewhere");
  }

  for (const r of writes.recoveries) {
    // The advances CHECK (recovered <= amount + fee) refuses an over-recovery whole. An advance a
    // card pull-back is taking back right now (NO_LIVE_PULL) changes no row, so the booking waits
    // not_booked until the pull settles, and the pull's own write is never left without room.
    const moved = await q.execute(
      `UPDATE advances SET recovered_cents = recovered_cents + $2
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
          AND driver_id = CAST($3 AS uuid) AND status = 'paid' AND ${NO_LIVE_PULL}`,
      [r.advanceId, r.cents, stored.driverId],
    );
    if (moved !== 1) throw new Error("an advance recovery found no paid advance");
  }

  for (const d of writes.deficitSettlements) {
    // The 0080 CHECKs refuse an over-recovery whole (recovered never above the amount, settled only
    // when whole); a deficit settled by another stub or not this driver's changes no row. The pay
    // read counts what the driver's other approved, unbooked stubs hold on a deficit as taken
    // (readSettlementInput), so a later week takes only what is left and a draft that took the same
    // part parks at its approval's recheck. Should two approvals still both take it (both at the
    // same instant), the second booking is refused (driver_deficits_recovered_within, or no open
    // deficit once the first settled it) and waits not_booked for a person to settle.
    const moved = await q.execute(
      `UPDATE driver_deficits
          SET recovered_cents = recovered_cents + $2,
              settled_in = CASE WHEN recovered_cents + $2 = amount_cents THEN CAST($3 AS uuid) END
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
          AND driver_id = CAST($4 AS uuid) AND settled_in IS NULL`,
      [d.deficitId, d.cents, settlementId, stored.driverId],
    );
    if (moved !== 1) throw new Error("a deficit recovery found no open deficit");
  }

  await q.execute(
    `UPDATE drivers SET escrow_balance_cents = $2
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [stored.driverId, writes.escrow.closingCents],
  );

  if (writes.carried) {
    const c = writes.carried;
    // One carried item per settlement: its item_ref names the settlement, so a replay adds none.
    await q.execute(
      `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date,
                              ref_table, ref_id, item_ref, description)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5,
               CAST($6 AS date), $7, CAST($8 AS uuid), $9, $10)
       ON CONFLICT (tenant_id, item_ref) DO NOTHING`,
      [
        randomUUID(),
        stored.driverId,
        c.kind,
        c.subkind,
        c.amountCents,
        c.itemDate,
        c.refTable,
        c.refId,
        `${tenant.slug}-carry-${settlementId}`,
        c.description,
      ],
    );
  }

  await rollUpPeriod(q, stored.periodId);
  return true;
}

// A period moves forward only: every settlement paid makes it paid; every one approved or paid
// makes it approved. A period with no settlements stays as it is.
export async function rollUpPeriod(q: Queryable, periodId: string): Promise<void> {
  const [counts] = await q.query<{ total: number | string; paid: number | string; settled: number | string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE status = 'paid') AS paid,
            count(*) FILTER (WHERE status IN ('approved', 'paid')) AS settled
       FROM settlements WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid)`,
    [periodId],
  );
  const total = Number(counts?.total ?? 0);
  if (total === 0) return;
  if (Number(counts.paid) === total) {
    await q.execute(
      `UPDATE settlement_periods SET status = 'paid'
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status IN ('open', 'approved')`,
      [periodId],
    );
  } else if (Number(counts.settled) === total) {
    await q.execute(
      `UPDATE settlement_periods SET status = 'approved'
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'open'`,
      [periodId],
    );
  }
}
