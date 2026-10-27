import type { Queryable } from "../db";
import { settlementIsClean } from "./clean";
import { parkLabel } from "./labels";

// The pay run's list of paystubs for one week, shared by the settlements screen and the agent's
// get_settlements tool. Reads only: nothing here reaches a money module.

export type PeriodOption = { id: string; start: string; end: string; status: string };

export type SettlementListRow = {
  id: string;
  driverId: string;
  driverCode: string;
  driverName: string;
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  exceptionCount: number;
  // The live card's exception categories (empty when there is no card or they do not read).
  exceptions: string[];
  status: string;
  parkedReason: string | null;
  parkedLabel: string | null;
  proposalId: string | null;
  proposalStatus: string | null;
  auditor: string | null;
  auditorAgrees: boolean | null;
  clean: boolean;
};

export const nameOf = (first: string, last: string) => `${first} ${last}`.trim();

// The paystub "Ask about this paystub" opens the home page with: its driver's name and the week's
// last day, or null when the id is not one of this carrier's paystubs. The caller checks the id.
export async function readPaystubAsk(
  q: Queryable,
  settlementId: string,
): Promise<{ driverName: string; periodEnd: string } | null> {
  const [row] = await q.query<{ first_name: string; last_name: string; end_date: string }>(
    `SELECT d.first_name, d.last_name, CAST(p.period_end AS text) AS end_date
       FROM settlements s
       JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
       JOIN settlement_periods p ON p.tenant_id = s.tenant_id AND p.id = s.period_id
      WHERE s.tenant_id = current_tenant_id() AND s.id = CAST($1 AS uuid)`,
    [settlementId],
  );
  return row ? { driverName: nameOf(row.first_name, row.last_name), periodEnd: row.end_date } : null;
}

// A proposal's exception categories, read as text (the Data API returns json as text) and parsed.
// Anything but a list of strings reads as no categories, which keeps the row out of "clean".
export function categoriesOf(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((c) => typeof c === "string") ? parsed : null;
  } catch {
    return null;
  }
}

// Open periods and the last paid one, newest first. The selected one is the asked id when it is in
// that list, else the newest open one.
export async function readPeriods(q: Queryable): Promise<PeriodOption[]> {
  const rows = await q.query<{ id: string; period_start: string; period_end: string; status: string }>(
    `SELECT id, CAST(period_start AS text) AS period_start, CAST(period_end AS text) AS period_end, status
       FROM settlement_periods
      WHERE tenant_id = current_tenant_id()
        AND (status <> 'paid' OR id = (SELECT id FROM settlement_periods
                                        WHERE tenant_id = current_tenant_id() AND status = 'paid'
                                        ORDER BY period_start DESC LIMIT 1))
      ORDER BY period_start DESC
      LIMIT 12`,
  );
  return rows.map((r) => ({ id: r.id, start: r.period_start, end: r.period_end, status: r.status }));
}

type ListRow = {
  id: string;
  driver_id: string;
  code: string;
  first_name: string;
  last_name: string;
  gross_cents: number | string;
  deductions_cents: number | string;
  net_cents: number | string;
  exception_count: number;
  status: string;
  parked_reason: string | null;
  proposal_id: string | null;
  proposal_status: string | null;
  exceptions: string | null;
  flagged_input_id: string | null;
  auditor_verdict: string | null;
  auditor_agrees: boolean | null;
};

// The live card per paystub (one at most, by the live-card index), else the newest one. Exported so
// the agent tool tests can serve it from a seed plan.
export const SETTLEMENT_ROWS = `SELECT s.id, s.driver_id, d.code, d.first_name, d.last_name, s.gross_cents, s.deductions_cents,
            s.net_cents, s.exception_count, s.status, s.parked_reason,
            p.id AS proposal_id, p.status AS proposal_status, CAST(p.exceptions AS text) AS exceptions,
            p.flagged_input_id,
            p.auditor_verdict, p.auditor_agrees
       FROM settlements s
       JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
       LEFT JOIN LATERAL (
         SELECT id, status, exceptions, flagged_input_id, auditor_verdict, auditor_agrees
           FROM proposals
          WHERE tenant_id = s.tenant_id AND kind = 'settlement_approve' AND subject_id = s.id
          ORDER BY (status IN ('proposed', 'approved', 'executing')) DESC, created_at DESC, id
          LIMIT 1
       ) p ON true
      WHERE s.tenant_id = current_tenant_id() AND s.period_id = CAST($1 AS uuid)
      ORDER BY d.code, s.id`;

// The week's paystubs in driver order, each with its live card (else its newest one), and how many
// cards are still waiting for the auditor.
export async function readSettlementRows(
  q: Queryable,
  periodId: string,
): Promise<{ rows: SettlementListRow[]; awaitingAuditor: number }> {
  const rows = await q.query<ListRow>(
    SETTLEMENT_ROWS,
    [periodId],
  );
  let awaitingAuditor = 0;
  const list: SettlementListRow[] = rows.map((r) => {
    const exceptions = categoriesOf(r.exceptions);
    const proposal = {
      status: r.proposal_status ?? "",
      exceptions: exceptions ?? [],
      flaggedInputId: r.flagged_input_id,
      auditorVerdict: r.auditor_verdict,
      auditorAgrees: r.auditor_agrees,
    };
    if (r.proposal_status === "proposed" && r.auditor_verdict === null) awaitingAuditor += 1;
    const net = Number(r.net_cents);
    return {
      id: r.id,
      driverId: r.driver_id,
      driverCode: r.code,
      driverName: nameOf(r.first_name, r.last_name),
      grossCents: Number(r.gross_cents),
      deductionsCents: Number(r.deductions_cents),
      netCents: net,
      exceptionCount: r.exception_count,
      exceptions: exceptions ?? [],
      status: r.status,
      parkedReason: r.parked_reason,
      parkedLabel: r.parked_reason ? parkLabel(r.parked_reason) : null,
      proposalId: r.proposal_id,
      proposalStatus: r.proposal_status,
      auditor: r.auditor_verdict,
      auditorAgrees: r.auditor_agrees,
      clean:
        r.proposal_id !== null &&
        exceptions !== null &&
        settlementIsClean({ status: r.status, net_cents: net, parked_reason: r.parked_reason }, proposal),
    };
  });
  return { rows: list, awaitingAuditor };
}
