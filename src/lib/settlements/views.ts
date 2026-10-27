import type { Queryable } from "../db";
import { readBySubject } from "../money/read";
import type { MoneyActionState } from "../money/types";
import type { PayLine } from "../rules-engine";
import { isUuid } from "../uuid";
import { readCleanSet, type CleanSet } from "./clean";
import { exceptionLabel, parkLabel } from "./labels";
import { LEG_KINDS, latestOf, type LegKind } from "./legs";
import {
  categoriesOf,
  nameOf,
  readPeriods,
  readSettlementRows,
  type PeriodOption,
  type SettlementListRow,
} from "./list";
import { readStoredLines, readStoredSettlement, type StoredSettlement } from "./stored";

// The settlement screens' reads, each inside the request's tenant transaction. Every value is
// read from the stored rows; nothing here computes pay.

export type { PeriodOption, SettlementListRow } from "./list";

export type SettlementsView = {
  periods: PeriodOption[];
  period: PeriodOption | null;
  rows: SettlementListRow[];
  clean: CleanSet;
  // Proposed cards waiting for the auditor: why "Approve all clean" may be empty.
  awaitingAuditor: number;
  exemptDrivers: { id: string; code: string; name: string }[];
};

export async function readSettlementsView(q: Queryable, asked: string | null): Promise<SettlementsView> {
  const periods = await readPeriods(q);
  const want = asked && isUuid(asked) ? asked.toLowerCase() : null;
  const period =
    periods.find((p) => p.id === want) ?? periods.find((p) => p.status === "open") ?? periods[0] ?? null;
  const exempt = await q.query<{ id: string; code: string; first_name: string; last_name: string }>(
    `SELECT id, code, first_name, last_name FROM drivers
      WHERE tenant_id = current_tenant_id() AND own_insurance ORDER BY code`,
  );
  const exemptDrivers = exempt.map((d) => ({ id: d.id, code: d.code, name: nameOf(d.first_name, d.last_name) }));
  if (!period) {
    return { periods, period, rows: [], clean: { items: [], totalCents: 0 }, awaitingAuditor: 0, exemptDrivers };
  }
  const { rows: list, awaitingAuditor } = await readSettlementRows(q, period.id);
  return { periods, period, rows: list, clean: await readCleanSet(q, period.id), awaitingAuditor, exemptDrivers };
}

export type LegRow = {
  id: string;
  kind: LegKind;
  attempt: number;
  state: MoneyActionState;
  failureCategory: string | null;
  amountCents: number;
  createdAt: string;
};

export type SettlementRecordView = {
  settlement: StoredSettlement;
  lines: PayLine[];
  period: { id: string; start: string; end: string; status: string };
  driver: { id: string; code: string; name: string; workerType: "company" | "owner_operator"; ownInsurance: boolean };
  proposal: { id: string; status: string; note: string | null; exceptions: { category: string; label: string }[] } | null;
  legs: LegRow[];
  latest: Record<LegKind, MoneyActionState | null>;
  parkedLabel: string | null;
};

export async function readSettlementRecord(q: Queryable, id: string): Promise<SettlementRecordView | null> {
  const settlement = await readStoredSettlement(q, id, false);
  if (!settlement) return null;
  const [meta] = await q.query<{
    period_start: string;
    period_end: string;
    period_status: string;
    code: string;
    first_name: string;
    last_name: string;
    worker_type: "company" | "owner_operator";
    own_insurance: boolean;
  }>(
    `SELECT CAST(sp.period_start AS text) AS period_start, CAST(sp.period_end AS text) AS period_end,
            sp.status AS period_status, d.code, d.first_name, d.last_name, d.worker_type, d.own_insurance
       FROM settlements s
       JOIN settlement_periods sp ON sp.tenant_id = s.tenant_id AND sp.id = s.period_id
       JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
      WHERE s.tenant_id = current_tenant_id() AND s.id = CAST($1 AS uuid)`,
    [id],
  );
  if (!meta) return null;
  const [p] = await q.query<{ id: string; status: string; decision_note: string | null; exceptions: string | null }>(
    `SELECT id, status, decision_note, CAST(exceptions AS text) AS exceptions FROM proposals
      WHERE tenant_id = current_tenant_id() AND kind = 'settlement_approve' AND subject_id = CAST($1 AS uuid)
      ORDER BY (status IN ('proposed', 'approved', 'executing')) DESC, created_at DESC, id
      LIMIT 1`,
    [id],
  );
  const actions = await readBySubject(q, "settlements", id);
  const legs: LegRow[] = actions
    .filter((a): a is typeof a & { kind: LegKind } => (LEG_KINDS as readonly string[]).includes(a.kind))
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      attempt: a.attempt,
      state: a.state,
      failureCategory: a.failureCategory,
      amountCents: a.amountCents,
      createdAt: a.createdAt,
    }));
  const latest = Object.fromEntries(LEG_KINDS.map((k) => [k, latestOf(actions, k)?.state ?? null])) as Record<
    LegKind,
    MoneyActionState | null
  >;
  const categories = (p ? categoriesOf(p.exceptions) : null) ?? [];
  return {
    settlement,
    lines: await readStoredLines(q, id),
    period: { id: settlement.periodId, start: meta.period_start, end: meta.period_end, status: meta.period_status },
    driver: {
      id: settlement.driverId,
      code: meta.code,
      name: nameOf(meta.first_name, meta.last_name),
      workerType: meta.worker_type,
      ownInsurance: meta.own_insurance,
    },
    proposal: p
      ? {
          id: p.id,
          status: p.status,
          note: p.decision_note,
          exceptions: categories.map((c) => ({ category: c, label: exceptionLabel(c) })),
        }
      : null,
    legs,
    latest,
    parkedLabel: settlement.parkedReason ? parkLabel(settlement.parkedReason) : null,
  };
}

export type DriverRecordView = {
  id: string;
  code: string;
  name: string;
  workerType: "company" | "owner_operator";
  payBasis: string;
  escrowBalanceCents: number;
  ownInsurance: boolean;
  activeFrom: string;
  activeTo: string | null;
  settlements: { id: string; periodStart: string; periodEnd: string; status: string; netCents: number; parked: boolean }[];
  advances: { id: string; requestedOn: string; amountCents: number; status: string; recoveredCents: number }[];
};

export async function readDriverRecord(q: Queryable, id: string): Promise<DriverRecordView | null> {
  const [d] = await q.query<{
    id: string;
    code: string;
    first_name: string;
    last_name: string;
    worker_type: "company" | "owner_operator";
    pay_basis: string;
    escrow_balance_cents: number | string;
    own_insurance: boolean;
    active_from: string;
    active_to: string | null;
  }>(
    `SELECT id, code, first_name, last_name, worker_type, pay_basis, escrow_balance_cents, own_insurance,
            CAST(active_from AS text) AS active_from, CAST(active_to AS text) AS active_to
       FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [id],
  );
  if (!d) return null;
  const settlements = await q.query<{
    id: string;
    period_start: string;
    period_end: string;
    status: string;
    net_cents: number | string;
    parked_reason: string | null;
  }>(
    `SELECT s.id, CAST(sp.period_start AS text) AS period_start, CAST(sp.period_end AS text) AS period_end,
            s.status, s.net_cents, s.parked_reason
       FROM settlements s
       JOIN settlement_periods sp ON sp.tenant_id = s.tenant_id AND sp.id = s.period_id
      WHERE s.tenant_id = current_tenant_id() AND s.driver_id = CAST($1 AS uuid)
      ORDER BY sp.period_start DESC LIMIT 26`,
    [id],
  );
  const advances = await q.query<{
    id: string;
    requested_on: string;
    amount_cents: number | string;
    status: string;
    recovered_cents: number | string;
  }>(
    `SELECT id, CAST(requested_on AS text) AS requested_on, amount_cents, status, recovered_cents
       FROM advances WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
      ORDER BY requested_at DESC, id LIMIT 26`,
    [id],
  );
  return {
    id: d.id,
    code: d.code,
    name: nameOf(d.first_name, d.last_name),
    workerType: d.worker_type,
    payBasis: d.pay_basis,
    escrowBalanceCents: Number(d.escrow_balance_cents),
    ownInsurance: d.own_insurance,
    activeFrom: d.active_from,
    activeTo: d.active_to,
    settlements: settlements.map((s) => ({
      id: s.id,
      periodStart: s.period_start,
      periodEnd: s.period_end,
      status: s.status,
      netCents: Number(s.net_cents),
      parked: s.parked_reason !== null,
    })),
    advances: advances.map((a) => ({
      id: a.id,
      requestedOn: a.requested_on,
      amountCents: Number(a.amount_cents),
      status: a.status,
      recoveredCents: Number(a.recovered_cents),
    })),
  };
}

export type BatchItemView = {
  settlementId: string;
  driverCode: string;
  driverName: string;
  netCents: number;
  legs: Record<LegKind, MoneyActionState | null>;
};

export type BatchRecordView = {
  id: string;
  periodId: string | null;
  status: string;
  totalCents: number;
  legsReserved: number;
  createdAt: string;
  finishedAt: string | null;
  items: BatchItemView[];
};

export async function readBatchRecord(q: Queryable, id: string): Promise<BatchRecordView | null> {
  const [b] = await q.query<{
    id: string;
    period_id: string | null;
    status: string;
    scope: string;
    total_cents: number | string;
    legs_reserved: number;
    item_ids: string;
    created_at: string;
    finished_at: string | null;
  }>(
    `SELECT id, period_id, status, scope, total_cents, legs_reserved, CAST(item_ids AS text) AS item_ids,
            CAST(created_at AS text) AS created_at, CAST(finished_at AS text) AS finished_at
       FROM approval_batches WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [id],
  );
  if (!b || b.scope !== "settlements") return null;
  const items = await q.query<{ id: string; code: string; first_name: string; last_name: string; net_cents: number | string }>(
    `SELECT s.id, d.code, d.first_name, d.last_name, s.net_cents
       FROM settlements s
       JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
      WHERE s.tenant_id = current_tenant_id() AND s.id = ANY(CAST($1 AS uuid[]))
      ORDER BY d.code, s.id`,
    [b.item_ids],
  );
  const out: BatchItemView[] = [];
  for (const s of items) {
    const actions = await readBySubject(q, "settlements", s.id);
    out.push({
      settlementId: s.id,
      driverCode: s.code,
      driverName: nameOf(s.first_name, s.last_name),
      netCents: Number(s.net_cents),
      legs: Object.fromEntries(LEG_KINDS.map((k) => [k, latestOf(actions, k)?.state ?? null])) as Record<
        LegKind,
        MoneyActionState | null
      >,
    });
  }
  return {
    id: b.id,
    periodId: b.period_id,
    status: b.status,
    totalCents: Number(b.total_cents),
    legsReserved: b.legs_reserved,
    createdAt: b.created_at,
    finishedAt: b.finished_at,
    items: out,
  };
}
