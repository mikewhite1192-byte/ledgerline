import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import { readSettlementInput } from "../data/read";
import {
  cents,
  settleDriver,
  type LineKind,
  type PayLine,
  type Period,
  type SettlementInput,
  type SettlementResult,
  type SourceRef,
} from "../rules-engine";
import { findContradictions, readSourceFacts } from "./contradiction";
import {
  checkLineSources,
  parkReasonOf,
  reconcileSettlement,
  rowKey,
  type ParkReason,
  type SourceRow,
} from "./reconcile";

// The stored paystub as the database holds it, the records its lines cite as they stand now, and
// the pre-pay recheck that compares the two. Every read here runs inside the caller's tenant
// transaction, after the caller's locks.

export type StoredSettlement = {
  id: string;
  periodId: string;
  driverId: string;
  status: "draft" | "approved" | "paid";
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  carryForwardCents: number;
  exceptionCount: number;
  paidAt: string | null;
  parkedReason: string | null;
  parkedAt: string | null;
};

type Row = {
  id: string;
  period_id: string;
  driver_id: string;
  status: StoredSettlement["status"];
  gross_cents: number | string;
  deductions_cents: number | string;
  net_cents: number | string;
  carry_forward_cents: number | string;
  exception_count: number | string;
  paid_at: string | null;
  parked_reason: string | null;
  parked_at: string | null;
};

const COLUMNS =
  "id, period_id, driver_id, status, gross_cents, deductions_cents, net_cents, carry_forward_cents," +
  " exception_count, to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS paid_at," +
  " parked_reason, to_char(parked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS parked_at";

function whole(value: number | string, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} is not whole cents`);
  return n;
}

function storedOf(r: Row): StoredSettlement {
  return {
    id: r.id,
    periodId: r.period_id,
    driverId: r.driver_id,
    status: r.status,
    grossCents: whole(r.gross_cents, "gross"),
    deductionsCents: whole(r.deductions_cents, "deductions"),
    netCents: whole(r.net_cents, "net"),
    carryForwardCents: whole(r.carry_forward_cents, "carry forward"),
    exceptionCount: whole(r.exception_count, "exception count"),
    paidAt: r.paid_at,
    parkedReason: r.parked_reason,
    parkedAt: r.parked_at,
  };
}

// One settlement, locked for the rest of the caller's transaction (lock: true), or read.
export async function readStoredSettlement(
  q: Queryable,
  settlementId: string,
  lock: boolean,
): Promise<StoredSettlement | null> {
  const rows = await q.query<Row>(
    `SELECT ${COLUMNS} FROM settlements
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)${lock ? " FOR UPDATE" : ""}`,
    [settlementId],
  );
  return rows[0] ? storedOf(rows[0]) : null;
}

type LineRow = {
  seq: number | string;
  kind: string;
  label: string;
  amount_cents: number | string;
  sources: unknown;
  meta: unknown;
  entered_by: string | null;
  source_ref: string | null;
};

function sourcesOf(value: unknown): SourceRef[] {
  const list: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(list)) throw new Error("a stored line's sources are not a list");
  return list.map((s: unknown) => {
    const ref = s as { table?: unknown; id?: unknown };
    if (typeof ref?.table !== "string" || typeof ref?.id !== "string") {
      throw new Error("a stored line cites a record it cannot name");
    }
    return { table: ref.table as SourceRef["table"], id: ref.id };
  });
}

// The stored lines in seq order, as the engine's PayLine. A line a person typed (0084) carries who
// typed it and the record it cites, as the engine's line does; any other line has neither field.
export async function readStoredLines(q: Queryable, settlementId: string): Promise<PayLine[]> {
  const rows = await q.query<LineRow>(
    `SELECT seq, kind, label, amount_cents, sources, meta, CAST(entered_by AS text) AS entered_by, source_ref
       FROM settlement_lines
      WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid)
      ORDER BY seq`,
    [settlementId],
  );
  return rows.map((r) => {
    const meta: unknown = typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta;
    return {
      seq: whole(r.seq, "seq"),
      kind: r.kind as LineKind,
      label: r.label,
      amountCents: cents(whole(r.amount_cents, "line amount"), "line amount"),
      sources: sourcesOf(r.sources),
      ...(meta && typeof meta === "object" ? { meta: meta as PayLine["meta"] } : {}),
      ...(r.entered_by !== null || r.source_ref !== null
        ? { enteredBy: r.entered_by, sourceRef: r.source_ref }
        : {}),
    };
  });
}

export async function readPeriod(
  q: Queryable,
  periodId: string,
  lock = false,
): Promise<(Period & { id: string; status: string }) | null> {
  const rows = await q.query<{ id: string; period_start: string; period_end: string; status: string }>(
    `SELECT id, CAST(period_start AS text) AS period_start, CAST(period_end AS text) AS period_end, status
       FROM settlement_periods WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
       ${lock ? "FOR UPDATE" : ""}`,
    [periodId],
  );
  const r = rows[0];
  return r ? { id: r.id, start: r.period_start, end: r.period_end, status: r.status } : null;
}

// The records a driver's paystub can cite, keyed table:id, from the same read the engine ran on.
// Anything the lines cite that is not here reads as missing (unknown is not zero).
export function sourceRowsOf(input: SettlementInput): Map<string, SourceRow | null> {
  const rows = new Map<string, SourceRow | null>();
  const put = (table: SourceRef["table"], id: string, row: SourceRow) => rows.set(rowKey({ table, id }), row);
  for (const l of input.loads) {
    put("loads", l.id, { table: "loads", record: l });
    for (const a of l.accessorials) put("load_accessorials", a.id, { table: "other" });
  }
  for (const d of input.days) put("driver_days", d.id, { table: "other" });
  for (const i of input.items) put("pay_items", i.id, { table: "pay_items", record: i });
  for (const s of input.schedules) put("deduction_schedules", s.id, { table: "deduction_schedules", record: s });
  for (const a of input.advances) put("advances", a.id, { table: "advances", record: a });
  for (const d of input.deficits) put("driver_deficits", d.id, { table: "driver_deficits", record: d });
  put("drivers", input.driver.id, { table: "other" });
  return rows;
}

export type Recheck = {
  fresh: SettlementResult;
  period: Period;
  park: ParkReason | null;
};

// The pre-pay recheck: a fresh engine run over the driver's records as they stand now, compared
// whole with the stored totals and lines, then every cited record checked, then, while
// flags.namedLines is on, every typed line and insurance line against the records it claims to
// match (contradiction.ts). Pure past the reads.
export async function recheckSettlement(
  q: Queryable,
  stored: StoredSettlement,
  lines: readonly PayLine[],
): Promise<Recheck> {
  const input = await readSettlementInput(q, stored.driverId, stored.periodId);
  const fresh = settleDriver(input);
  const reconcile = reconcileSettlement(
    {
      grossCents: stored.grossCents,
      deductionsCents: stored.deductionsCents,
      netCents: stored.netCents,
      carryForwardCents: stored.carryForwardCents,
      lines,
    },
    fresh,
  );
  const problems = checkLineSources(lines, stored.id, input.period, sourceRowsOf(input));
  if (flags.namedLines.enabled) {
    problems.push(...findContradictions(lines, await readSourceFacts(q, lines, stored.driverId), stored.id));
  }
  return { fresh, period: input.period, park: parkReasonOf(reconcile, problems) };
}

// Parks a draft: it is never paid until "Run the week" recomputes it. Returns the rows moved.
export async function parkSettlement(
  q: Queryable,
  settlementId: string,
  reason: ParkReason,
  now: Date,
): Promise<number> {
  return q.execute(
    `UPDATE settlements SET parked_reason = $2, parked_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'draft'
        AND parked_reason IS NULL`,
    [settlementId, reason, now.toISOString()],
  );
}

// A per-tenant advisory lock for the rest of the transaction, so two runs of one job cannot
// interleave. The name is a constant from this package, never input.
export async function tenantLock(q: Queryable, name: string): Promise<void> {
  await q.query(
    `SELECT count(*) AS n FROM (
       SELECT pg_advisory_xact_lock(hashtext(CAST(current_tenant_id() AS text) || ':' || $1))
     ) AS l`,
    [name],
  );
}
