import type { Param } from "../../../db";
import { QUEUE_CHILDREN, QUEUE_LOADS } from "../../../data/read";
import type { TenantRows } from "../../../data/rows";
import { buildCarrierPlan, type CarrierPlan } from "../../../seed/plan";
import { DEMO_CARRIERS } from "../../../seed/carriers";
import { FakeDb, TENANT, type Handler, type Row } from "./fake-db";

// A FakeDb that serves one synthetic carrier's seed plan through the record readers' own SQL, so
// the limits and tools run against the real readers and the real rules engine with no database.
// Each statement shape the readers send is matched whole; anything else goes to the extra
// handler or fails the test.

const FROM =
  /^SELECT .+? FROM (\w+) WHERE tenant_id = current_tenant_id\(\)(?: AND (.+))? ORDER BY \w+$/s;
const BY_COLUMN = /^(\w+) = CAST\(\$1 AS uuid\)$/;
const BY_DRIVER_LOADS =
  "load_id IN (SELECT id FROM loads WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid))";

export const PLAN_ANCHOR = "2026-11-02";

let cached: CarrierPlan | null = null;
export function blueRidgePlan(): CarrierPlan {
  cached ??= buildCarrierPlan(DEMO_CARRIERS[0], PLAN_ANCHOR);
  return cached;
}

export function planDb(plan: CarrierPlan, extra?: Handler): FakeDb {
  const rows = plan.rows as unknown as Record<string, Row[]>;
  const tables: Record<string, Row[]> = { ...rows };
  const handler: Handler = (sql, params) => {
    const custom = extra?.(sql, params);
    if (custom !== undefined) return custom;
    if (sql === "SELECT id, slug, name, timezone FROM tenants WHERE id = current_tenant_id()") {
      const c = plan.carrier;
      return [{ id: TENANT, slug: c.slug, name: c.name, timezone: c.timezone }];
    }
    const m = FROM.exec(sql);
    if (!m) return undefined;
    const all = tables[m[1]] ?? [];
    return filterRows(plan.rows, all, m[2], params).map((r) => ({ ...r }));
  };
  return new FakeDb(tables, handler);
}

function filterRows(rows: TenantRows, all: Row[], where: string | undefined, params: Param[]): Row[] {
  if (where === undefined) return all;
  const col = BY_COLUMN.exec(where);
  if (col) return all.filter((r) => r[col[1]] === params[0]);
  if (where === BY_DRIVER_LOADS) {
    const loadIds = new Set(rows.loads.filter((l) => l.driver_id === params[0]).map((l) => l.id));
    return all.filter((r) => loadIds.has(r.load_id as string));
  }
  if (where === "status = $1") return all.filter((r) => r.status === params[0]);
  if (where === QUEUE_LOADS || where === QUEUE_CHILDREN) {
    const invoiced = new Set(rows.invoices.map((i) => i.load_id));
    const queued = new Set(
      rows.loads
        .filter(
          (l) =>
            l.status === "delivered" &&
            l.delivered_on !== null &&
            l.delivered_on >= (params[0] as string) &&
            !invoiced.has(l.id),
        )
        .map((l) => l.id),
    );
    return all.filter((r) => queued.has((where === QUEUE_LOADS ? r.id : r.load_id) as string));
  }
  throw new Error(`unexpected where clause: ${where.slice(0, 60)}`);
}

// The proposal id sample-args gives get_proposal. Proposals are not in a seed plan, so a test
// serves one stored proposal through withProposal.
export const PROPOSAL_ID = "6a1f0c2e-9d3b-4c5a-8e7f-1b2c3d4e5f60";

export type ProposalKindName = "advance_payout" | "pay_correction" | "invoice_fix";

// One stored proposal per kind, as get_proposal's select returns it, over the plan's own records.
export function proposalRowFor(plan: CarrierPlan, kind: ProposalKindName, over: Row = {}): Row {
  const rows = plan.rows;
  const hero = rows.drivers.find((d) => d.code === plan.carrier.heroCode) ?? rows.drivers[0];
  const open = rows.settlement_periods.find((p) => p.status === "open")!;
  const invoice = rows.invoices.find((i) => i.source === "load" && i.status === "open")!;
  const base: Row = {
    id: PROPOSAL_ID,
    kind,
    status: "proposed",
    reasons: JSON.stringify([{ category: "driver_asked" }]),
    exceptions: "[]",
    flagged: false,
    flag_categories: null,
  };
  if (kind === "advance_payout") {
    return {
      ...base,
      title: "Pay advance",
      subject_table: "drivers",
      subject_id: hero.id,
      subject_label: hero.code,
      amount_cents: 10_000,
      direction: "out",
      operator_verdict: "eligible",
      sources: JSON.stringify([{ table: "drivers", id: hero.id }]),
      args: JSON.stringify({ driverId: hero.id, amountCents: 10_000, requestedOn: "2026-10-31" }),
      ...over,
    };
  }
  if (kind === "pay_correction") {
    return {
      ...base,
      title: "Pay correction",
      subject_table: "drivers",
      subject_id: hero.id,
      subject_label: hero.code,
      amount_cents: 2_500,
      direction: "out",
      operator_verdict: "owed_to_driver",
      sources: JSON.stringify([{ table: "drivers", id: hero.id }, { table: "settlement_periods", id: open.id }]),
      args: JSON.stringify({ driverId: hero.id, periodId: open.id, deltaCents: 2_500 }),
      ...over,
    };
  }
  return {
    ...base,
    title: "Invoice fix",
    subject_table: "invoices",
    subject_id: invoice.id,
    subject_label: invoice.invoice_number,
    amount_cents: 100,
    direction: "in",
    operator_verdict: "not_given",
    sources: JSON.stringify([{ table: "invoices", id: invoice.id }]),
    args: JSON.stringify({ invoiceId: invoice.id, newAmountCents: invoice.amount_cents + 100 }),
    ...over,
  };
}

// Serves one stored proposal: the gateway's reference check and get_proposal's select.
export function withProposal(row: Row, extra?: Handler): Handler {
  return (sql, params) => {
    if (sql.startsWith("SELECT 1 AS ok FROM proposals ")) return params[0] === row.id ? [{ ok: 1 }] : [];
    if (sql.includes("FROM proposals p")) return params[0] === row.id ? [{ ...row }] : [];
    return extra?.(sql, params);
  };
}
