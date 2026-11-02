import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import { NO_LIVE_PULL, readTenant } from "../data/read";
import { cents } from "../rules-engine";
import { dayOfWeek, localDateOf, periodContaining } from "../time/local-date";
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
  const carryForwardCents = cents(stored.carryForwardCents, "carry forward");
  // A shortfall carried into a later week that can no longer draft it would never be charged, so
  // it is dated at the start of the earliest later week that can still draft it for this driver
  // (open, with no approved or paid stub of this driver), else past every later week that cannot
  // (carriedItemDate): a week already closed (approved or paid, which "Run the week" refuses), with
  // or without a stub of this driver, and an open week where this driver's stub is already
  // approved or paid. The driver's lock above is the one every approval of this driver's stubs
  // takes before its recheck (lockPayDrivers), so no other week's stub of this driver changes
  // status between this read and the commit; the later weeks' rows are held FOR SHARE, so no
  // roll-up closes the week the item lands in before this booking commits (rollUpPeriod).
  const laterWeeks =
    carryForwardCents > 0
      ? await q.query<{ period_start: string; period_end: string; state: string }>(
          `SELECT CAST(p.period_start AS text) AS period_start, CAST(p.period_end AS text) AS period_end,
                  CASE WHEN p.status <> 'open'
                         OR EXISTS (SELECT 1 FROM settlements s
                                     WHERE s.tenant_id = p.tenant_id AND s.period_id = p.id
                                       AND s.driver_id = CAST($1 AS uuid) AND s.status IN ('approved', 'paid'))
                       THEN 'settled' ELSE 'drafts' END AS state
             FROM settlement_periods p
            WHERE p.tenant_id = current_tenant_id() AND p.period_start > CAST($2 AS date)
            ORDER BY p.period_start
              FOR SHARE OF p`,
          [stored.driverId, period.start],
        )
      : [];
  const settledWeeks = laterWeeks.filter((w) => w.state === "settled").map((w) => ({ start: w.period_start, end: w.period_end }));
  const draftingWeek = laterWeeks.find((w) => w.state === "drafts")?.period_start ?? null;
  // With no week to draft it yet, the item never falls in a week already over: the earliest day is
  // the first of the week holding the carrier's local today, from the same zone (tenants.timezone)
  // and week shape (every period starts on the pay rules' week start day) the pay week roll opens
  // that week from. Only while the roll is on, since nothing opens a week otherwise.
  const notBefore =
    carryForwardCents > 0 && draftingWeek === null && flags.payWeekRoll.enabled
      ? periodContaining(localDateOf(now.toISOString(), tenant.timezone), dayOfWeek(period.start)).start
      : null;
  const writes = paidWritesOf({
    settlementId,
    lines,
    carryForwardCents,
    openingCents: Number(driver.escrow_balance_cents),
    periodEnd: period.end,
    settledWeeks,
    draftingWeek,
    notBefore,
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
// makes it approved. A period with no settlements stays as it is, and so does one holding a pay
// item on no paystub yet for a driver with no paystub in the week (a shortfall carried into it
// after its stubs were drafted, D-090): only a run of an open week drafts that item, so closing
// the week would strand it; open, the week stays the one paid next and a person's run drafts it.
// The period row is locked first, the lock a booking takes on every later week while it dates a
// carried shortfall (FOR SHARE above), so an item and the roll-up of its week never interleave.
export async function rollUpPeriod(q: Queryable, periodId: string): Promise<void> {
  const period = await readPeriod(q, periodId, true);
  if (!period) return;
  const [counts] = await q.query<{ total: number | string; paid: number | string; settled: number | string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE status = 'paid') AS paid,
            count(*) FILTER (WHERE status IN ('approved', 'paid')) AS settled
       FROM settlements WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid)`,
    [periodId],
  );
  const total = Number(counts?.total ?? 0);
  if (total === 0) return;
  const unstubbed = await q.query<{ id: string }>(
    `SELECT i.id FROM pay_items i
      WHERE i.tenant_id = current_tenant_id() AND i.settlement_id IS NULL
        AND i.item_date BETWEEN CAST($2 AS date) AND CAST($3 AS date)
        AND NOT EXISTS (SELECT 1 FROM settlements s
                         WHERE s.tenant_id = i.tenant_id AND s.period_id = CAST($1 AS uuid)
                           AND s.driver_id = i.driver_id)
      LIMIT 1`,
    [periodId, period.start, period.end],
  );
  if (unstubbed.length > 0) return;
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
