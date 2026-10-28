import type { Queryable } from "../db";
import { readReportInput, ReadLimitError } from "../data/read";
import {
  customerOf,
  driverOf,
  loadStopsOf,
  loadsOf,
  periodOf,
  receivablesInputOf,
  settlementOf,
} from "../data/records";
import { marginLines } from "../reports/margin-per-load";
import { payConfigOn } from "../reports/run";
import {
  quarterOf,
  type BriefFigure,
  type Quarter,
  type QuarterDetentionCharge,
  type QuarterInput,
  type QuarterProposal,
} from "../rules-engine";
import { addDays, localDateOf, type LocalDate, type Period } from "../time/local-date";
import { figuresText } from "./figures";

// What the quarter review reads: the calendar quarter so far, from the carrier's own records,
// handed to the rules engine (rules-engine/quarter.ts) for every number. Reads only (SELECT,
// inside the caller's tenant transaction); nothing here reaches a model.

// More of the agent's fixes than this in one quarter stops the read rather than count part of them.
export const MAX_QUARTER_PROPOSALS = 5_000;

// Exported so a test's fake database can match these statements whole.
// Only the recovery lines: the one kind the review sums, so the read stays small.
export const QUARTER_RECOVERY_SQL = `SELECT CAST(settlement_id AS text) AS settlement_id, kind, amount_cents
   FROM settlement_lines
  WHERE tenant_id = current_tenant_id() AND kind = 'advance_recovery'`;

// The agent's fixes made or decided from just before the quarter's first day (a day either side
// covers any zone), with UTC instants the caller turns into the carrier's dates.
export const QUARTER_PROPOSALS_SQL = `SELECT CAST(id AS text) AS id, kind, status, direction, amount_cents,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
   FROM proposals
  WHERE tenant_id = current_tenant_id()
    AND (created_at >= CAST($1 AS timestamptz) OR decided_at >= CAST($1 AS timestamptz))
  ORDER BY id
  LIMIT ${MAX_QUARTER_PROPOSALS + 1}`;

// Detention charges the agent found, each with its fix's status and when it was decided.
export const QUARTER_DETENTION_SQL = `SELECT CAST(a.id AS text) AS id, CAST(a.load_id AS text) AS load_id, a.amount_cents,
        CAST(p.id AS text) AS proposal_id, p.status AS proposal_status,
        to_char(p.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
   FROM load_accessorials a
   JOIN proposals p ON p.tenant_id = a.tenant_id AND p.id = a.proposal_id
  WHERE a.tenant_id = current_tenant_id() AND a.kind = 'detention' AND a.proposal_id IS NOT NULL
  ORDER BY a.id`;

type ProposalRow = {
  id: string;
  kind: string;
  status: string;
  direction: string;
  amount_cents: number | string;
  created_at: string;
  decided_at: string | null;
};

type DetentionRow = {
  id: string;
  load_id: string;
  amount_cents: number | string;
  proposal_id: string;
  proposal_status: string;
  decided_at: string | null;
};

// Whole cents, or the read fails: a value that is not a whole number is never counted as zero.
function cents(value: unknown): number {
  const n = typeof value === "string" && /^-?[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new RangeError("amount is not whole cents");
  return n;
}

// The carrier's records for the quarter so far, ready for quarterOf.
export async function readQuarterInput(
  q: Queryable,
  quarter: Period,
  asOf: LocalDate,
  timezone: string,
): Promise<QuarterInput> {
  const rows = await readReportInput(q, [
    "loads",
    "load_state_miles",
    "load_accessorials",
    "drivers",
    "customers",
    "pay_configs",
    "invoices",
    "customer_payments",
    "payment_applications",
    "settlement_periods",
    "settlements",
  ]);
  const lines = await q.query<{ settlement_id: string; kind: string; amount_cents: number | string }>(
    QUARTER_RECOVERY_SQL,
  );
  const since = `${addDays(quarter.start, -2)}T00:00:00.000Z`;
  const proposalRows = await q.query<ProposalRow>(QUARTER_PROPOSALS_SQL, [since]);
  if (proposalRows.length > MAX_QUARTER_PROPOSALS) throw new ReadLimitError();
  const detentionRows = await q.query<DetentionRow>(QUARTER_DETENTION_SQL);
  const day = (instant: string | null) => (instant === null ? null : localDateOf(instant, timezone));

  const proposals: QuarterProposal[] = proposalRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    direction: r.direction,
    amountCents: cents(r.amount_cents),
    createdOn: localDateOf(r.created_at, timezone),
    decidedOn: day(r.decided_at),
  }));
  const detention: QuarterDetentionCharge[] = detentionRows.map((r) => ({
    id: r.id,
    loadId: r.load_id,
    amountCents: cents(r.amount_cents),
    proposalId: r.proposal_id,
    proposalStatus: r.proposal_status,
    decidedOn: day(r.decided_at),
  }));
  const customers = rows.customers.map(customerOf);
  const drivers = rows.drivers.map(driverOf);
  const margin = marginLines(
    {
      loads: loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials),
      drivers,
      customers,
      payConfigOn: payConfigOn(rows.pay_configs),
    },
    { start: quarter.start, end: asOf },
  );
  return {
    periods: rows.settlement_periods.map(periodOf),
    settlements: rows.settlements.map(settlementOf),
    lines: lines.map((l) => ({ settlementId: l.settlement_id, kind: l.kind, amountCents: cents(l.amount_cents) })),
    drivers: drivers.map((d) => ({ id: d.id, name: `${d.firstName} ${d.lastName}` })),
    customers,
    margin,
    receivables: receivablesInputOf(rows, asOf),
    loads: rows.loads.map(loadStopsOf),
    accessorials: rows.load_accessorials.map((a) => ({ loadId: a.load_id, kind: a.kind })),
    proposals,
    detention,
  };
}

// The quarter so far as the engine counts it.
export async function readQuarter(q: Queryable, quarter: Period, asOf: LocalDate, timezone: string): Promise<Quarter> {
  return quarterOf(await readQuarterInput(q, quarter, asOf, timezone), quarter, asOf);
}

// The figures the model is given: from the top while the numbered list fits in maxChars, so the
// headline figures always survive and the per-driver ones are the first cut. The keys stay f1..fN
// in order, since only a run from the top is kept.
export function packFigures(figures: readonly BriefFigure[], maxChars: number): BriefFigure[] {
  let kept = 0;
  let size = 0;
  for (const f of figures) {
    const line = figuresText([f]).length + (kept > 0 ? 1 : 0);
    if (size + line > maxChars) break;
    size += line;
    kept += 1;
  }
  return figures.slice(0, kept);
}
