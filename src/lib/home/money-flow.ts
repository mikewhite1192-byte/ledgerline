import { DbError, type Queryable } from "@/lib/db";
import type { LocalDate } from "@/lib/time/local-date";
import { wholeNumber } from "./loaded";

// Money in and out by pay week, for the chart on Home: customer payments received and paystubs
// paid out in each of the last few pay weeks that have started. Read inside the caller's carrier
// transaction; every sum names its carrier. Integer cents. Nothing here writes.

export const FLOW_WEEKS = 4;

export type FlowWeek = { start: LocalDate; end: LocalDate; inCents: number; outCents: number };

type Row = { period_start: unknown; period_end: unknown; in_cents: unknown; out_cents: unknown };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateOf(value: unknown): LocalDate {
  // A week whose dates do not read cannot be placed on the chart: the card fails, never guesses.
  if (typeof value !== "string" || !DATE.test(value)) throw new DbError("unknown");
  return value;
}

// today is the carrier's date (carrierToday). A payment counts on the day it was received; a
// paystub on the carrier-local day it was paid. Weeks come back oldest first.
export async function readMoneyFlow(q: Queryable, today: LocalDate): Promise<FlowWeek[]> {
  const rows = await q.query<Row>(
    `SELECT CAST(p.period_start AS text) AS period_start, CAST(p.period_end AS text) AS period_end,
            (SELECT CAST(COALESCE(sum(cp.amount_cents), 0) AS bigint) FROM customer_payments cp
              WHERE cp.tenant_id = current_tenant_id()
                AND cp.received_on BETWEEN p.period_start AND p.period_end) AS in_cents,
            (SELECT CAST(COALESCE(sum(s.net_cents), 0) AS bigint) FROM settlements s
              WHERE s.tenant_id = current_tenant_id() AND s.status = 'paid'
                AND CAST(s.paid_at AT TIME ZONE t.timezone AS date) BETWEEN p.period_start AND p.period_end)
              AS out_cents
       FROM settlement_periods p
       JOIN tenants t ON t.id = p.tenant_id
      WHERE p.tenant_id = current_tenant_id() AND t.id = current_tenant_id()
        AND p.period_start <= CAST($1 AS date)
      ORDER BY p.period_start DESC
      LIMIT ${FLOW_WEEKS}`,
    [today],
  );
  return rows
    .map((r) => ({
      start: dateOf(r.period_start),
      end: dateOf(r.period_end),
      inCents: wholeNumber(r.in_cents),
      outCents: wholeNumber(r.out_cents),
    }))
    .reverse();
}
