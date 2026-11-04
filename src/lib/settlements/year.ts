import type { Queryable } from "../db";

// What the driver was paid this calendar year and where their escrow stands, both read from stored
// rows. yearToDate counts the driver's paid stubs whose paid time, in the carrier's own time zone,
// falls in the year this stub's week ends; a stub counts in the year it was paid. escrow is the
// balance the booking stored on a paid stub; on a draft or approved stub it is the driver's balance
// now plus this stub's escrow line, the balance once it is paid.
export type PaystubYear = {
  yearToDate: { year: number; paidCents: number; stubs: number; zone: string };
  escrow: { balanceCents: number; asOf: "paid" | "after_this_paystub" };
};

function wholeOf(value: number | string, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} is not a whole number`);
  return n;
}

// One statement, matched whole by the agent tests' seed-plan fake (plan-db.ts).
export const PAYSTUB_YEAR_SQL = `SELECT s.status, s.escrow_closing_cents, d.escrow_balance_cents, t.timezone,
            CAST(date_part('year', sp.period_end) AS integer) AS year,
            (SELECT CAST(COALESCE(sum(abs(l.amount_cents)), 0) AS bigint) FROM settlement_lines l
              WHERE l.tenant_id = current_tenant_id() AND l.settlement_id = s.id AND l.kind = 'escrow')
              AS withheld_cents,
            y.paid_cents, y.stubs
       FROM settlements s
       JOIN settlement_periods sp ON sp.tenant_id = s.tenant_id AND sp.id = s.period_id
       JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
       JOIN tenants t ON t.id = s.tenant_id
       CROSS JOIN LATERAL (
         SELECT CAST(COALESCE(sum(p.net_cents), 0) AS bigint) AS paid_cents, count(*) AS stubs
           FROM settlements p
          WHERE p.tenant_id = current_tenant_id() AND p.driver_id = s.driver_id
            AND p.status = 'paid' AND p.paid_at IS NOT NULL
            AND date_part('year', p.paid_at AT TIME ZONE t.timezone) = date_part('year', sp.period_end)
       ) y
      WHERE s.tenant_id = current_tenant_id() AND t.id = current_tenant_id() AND s.id = CAST($1 AS uuid)`;

// One stub's year to date and escrow balance, or null when the stub is not this carrier's.
export async function readPaystubYear(q: Queryable, settlementId: string): Promise<PaystubYear | null> {
  const [r] = await q.query<{
    status: string;
    escrow_closing_cents: number | string;
    escrow_balance_cents: number | string;
    withheld_cents: number | string;
    timezone: string;
    year: number | string;
    paid_cents: number | string;
    stubs: number | string;
  }>(PAYSTUB_YEAR_SQL, [settlementId]);
  if (!r) return null;
  const paid = r.status === "paid";
  return {
    yearToDate: {
      year: wholeOf(r.year, "year"),
      paidCents: wholeOf(r.paid_cents, "paid this year"),
      stubs: wholeOf(r.stubs, "paid stubs"),
      zone: r.timezone,
    },
    escrow: paid
      ? { balanceCents: wholeOf(r.escrow_closing_cents, "escrow closing"), asOf: "paid" }
      : {
          balanceCents: wholeOf(r.escrow_balance_cents, "escrow balance") + wholeOf(r.withheld_cents, "escrow line"),
          asOf: "after_this_paystub",
        },
  };
}
