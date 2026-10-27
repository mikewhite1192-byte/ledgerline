import { CLEAN_SQL, isClean, type CleanFields } from "../agent/proposals/clean";
import type { Queryable } from "../db";

// "Approve all clean" for the pay run: a paystub is clean when its card is clean (still waiting,
// no exception, nothing flagged, the auditor passed and agreed), the draft is still a draft, it is
// not parked, and there is money to send. A $0 week is never clean: a person looks at it (D-P2).

export type CleanSettlement = { status: string; net_cents: number; parked_reason: string | null };

export function settlementIsClean(settlement: CleanSettlement, proposal: CleanFields): boolean {
  return (
    isClean(proposal) &&
    settlement.status === "draft" &&
    settlement.parked_reason === null &&
    Number.isSafeInteger(settlement.net_cents) &&
    settlement.net_cents > 0
  );
}

export type CleanItem = {
  proposalId: string;
  settlementId: string;
  driverId: string;
  driverCode: string;
  driverName: string;
  netCents: number;
};

export type CleanSet = { items: CleanItem[]; totalCents: number };

type Row = {
  proposal_id: string;
  settlement_id: string;
  driver_id: string;
  code: string;
  first_name: string;
  last_name: string;
  net_cents: number | string;
};

// The period's clean paystubs, in driver order, with their total. The same test as
// settlementIsClean, in SQL over the card and the draft.
export async function readCleanSet(q: Queryable, periodId: string): Promise<CleanSet> {
  const rows = await q.query<Row>(
    `SELECT p.id AS proposal_id, s.id AS settlement_id, d.id AS driver_id, d.code, d.first_name,
            d.last_name, s.net_cents
       FROM proposals p
       JOIN settlements s ON s.tenant_id = p.tenant_id AND s.id = p.subject_id
       JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
      WHERE p.tenant_id = current_tenant_id() AND p.kind = 'settlement_approve'
        AND p.subject_table = 'settlements' AND s.period_id = CAST($1 AS uuid)
        AND s.status = 'draft' AND s.parked_reason IS NULL AND s.net_cents > 0
        AND ${CLEAN_SQL}
      ORDER BY d.code, s.id`,
    [periodId],
  );
  const items = rows.map((r) => ({
    proposalId: r.proposal_id,
    settlementId: r.settlement_id,
    driverId: r.driver_id,
    driverCode: r.code,
    driverName: `${r.first_name} ${r.last_name}`,
    netCents: Number(r.net_cents),
  }));
  let total = 0;
  for (const i of items) {
    if (!Number.isSafeInteger(i.netCents)) throw new Error("a net amount is not whole cents");
    total += i.netCents;
  }
  if (!Number.isSafeInteger(total)) throw new Error("the clean total is not whole cents");
  return { items, totalCents: total };
}
