import type { Param } from "../../../db";
import { QUARTER_DETENTION_SQL, QUARTER_PROPOSALS_SQL, QUARTER_RECOVERY_SQL } from "../../../briefs/quarter-figures";
import { chargeArgsOf, detentionChargeOf } from "../../../data/detention-charge";
import {
  ESCROW_LINES,
  LOAD_NUMBERS_FIRST,
  LOAD_NUMBERS_NEXT,
  MONEY_CODE_DRIVER_SQL,
  MONEY_CODE_LOAD_SQL,
  MONEY_CODES_SQL,
  PAID_WHERE,
  PURCHASED_BETWEEN,
  QUEUE_CHILDREN,
  QUEUE_LOADS,
  TRUST_DECISIONS_FIRST,
  TRUST_DECISIONS_NEXT,
} from "../../../data/read";
import { DUE_SQL as ESCROW_DUE_SQL } from "../../../escrow/due";
import { DRIVER_ESCROW_SQL, DRIVER_RELEASES_SQL } from "../../../escrow/read";
import { STATEMENT_WEEKS_SQL } from "../../../escrow/statement";
import { PACKET_DOCUMENTS_SQL, PACKET_INVOICES_SQL, PACKET_PODS_SQL } from "../../../factoring/packet";
import { SUMMARY_SQL as FACTORING_REQUESTS_SQL } from "../../../factoring/read";
import { QUEUE_CARD_LOADS_SQL } from "../../../invoices/made-by-queue";
import type { TenantRows } from "../../../data/rows";
import { buildCarrierPlan, type CarrierPlan } from "../../../seed/plan";
import { DEMO_CARRIERS } from "../../../seed/carriers";
import { SETTLEMENT_ROWS } from "../../../settlements/list";
import { FakeDb, TENANT, type Handler, type Row } from "./fake-db";

// A FakeDb that serves one synthetic carrier's seed plan through the record readers' own SQL, so
// the limits and tools run against the real readers and the real rules engine with no database.
// Each statement shape the readers send is matched whole; anything else goes to the extra
// handler or fails the test.

const FROM =
  /^SELECT .+? FROM (\w+) WHERE tenant_id = current_tenant_id\(\)(?: AND (.+))? ORDER BY (\w+)(?: LIMIT (\d+))?$/s;
// A paged read: its filter in parentheses and, after the first page, the last key it saw, as the
// statement's last parameter.
const AFTER_KEY = / AND id > CAST\(\$(\d+) AS uuid\)$/;
const BY_COLUMN = /^(\w+) = CAST\(\$1 AS uuid\)$/;
const BY_DRIVER_LOADS =
  "load_id IN (SELECT id FROM loads WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid))";

const DELIVERED_BETWEEN = "delivered_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)";
const PINNED_RATES =
  /^SELECT .+ FROM pinned_rates\s+WHERE tenant_id = current_tenant_id\(\) AND status = 'pinned' AND retired_at IS NULL AND kind = \$1\s+ORDER BY /s;
const DELIVERED_LOADS = `load_id IN (SELECT id FROM loads WHERE tenant_id = current_tenant_id() AND ${DELIVERED_BETWEEN})`;
const DELIVERED_CUSTOMERS = `id IN (SELECT customer_id FROM loads WHERE tenant_id = current_tenant_id() AND ${DELIVERED_BETWEEN})`;

// The ledger's rows for one subject (money/read.ts readBySubject). The plan holds none, so this
// answers from a money_actions list a test adds, or none.
export const LEDGER_BY_SUBJECT =
  /^SELECT CAST\(id AS text\) AS id, .+ FROM money_actions WHERE tenant_id = current_tenant_id\(\) AND subject_table = \$1 AND subject_id = CAST\(\$2 AS uuid\) ORDER BY created_at, attempt, id$/s;

// The ledger's rows of one kind (money/read.ts readByKind), answered the same way.
export const LEDGER_BY_KIND =
  /^SELECT CAST\(id AS text\) AS id, .+ FROM money_actions WHERE tenant_id = current_tenant_id\(\) AND kind = \$1 ORDER BY created_at, attempt, id$/s;

// The money-code list the pages and get_money_codes read (money-codes/read.ts). The plan holds no
// codes, so this answers from a money_codes list a test adds, or none.
export const MONEY_CODE_LIST = /^\s*SELECT CAST\(c\.id AS text\) AS id, .+ FROM money_codes c\s+JOIN drivers /s;

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
    if (LEDGER_BY_SUBJECT.test(sql)) {
      return (tables.money_actions ?? [])
        .filter((r) => r.subject_table === params[0] && r.subject_id === params[1])
        .map((r) => ({ ...r }));
    }
    // get_settlements' list: the plan's stored paystubs for the week with their drivers. A seed
    // plan holds no approval cards, so every card column is null.
    if (sql === SETTLEMENT_ROWS) {
      const drivers = new Map(plan.rows.drivers.map((d) => [d.id, d]));
      return plan.rows.settlements
        .filter((s) => s.period_id === params[0])
        .map((s) => {
          const d = drivers.get(s.driver_id)!;
          return {
            id: s.id,
            driver_id: s.driver_id,
            code: d.code,
            first_name: d.first_name,
            last_name: d.last_name,
            gross_cents: s.gross_cents,
            deductions_cents: s.deductions_cents,
            net_cents: s.net_cents,
            exception_count: s.exception_count,
            status: s.status,
            parked_reason: s.parked_reason,
            proposal_id: null,
            proposal_status: null,
            exceptions: null,
            flagged_input_id: null,
            auditor_verdict: null,
            auditor_agrees: null,
          };
        })
        .sort((x, y) => (x.code === y.code ? (x.id < y.id ? -1 : 1) : x.code < y.code ? -1 : 1));
    }
    // The money-code check's reads (data/read.ts readMoneyCodeInput): the driver's switch, the
    // load, and the recent codes or those citing the same evidence (none in a plan unless a test
    // adds them).
    if (sql === MONEY_CODE_DRIVER_SQL) {
      return plan.rows.drivers.filter((d) => d.id === params[0]).map((d) => ({ money_armed: d.money_armed }));
    }
    if (sql === MONEY_CODE_LOAD_SQL) {
      return plan.rows.loads
        .filter((l) => l.id === params[0])
        .map((l) => ({
          id: l.id,
          driver_id: l.driver_id,
          status: l.status,
          load_number: l.load_number,
          delivered_on: l.delivered_on,
        }));
    }
    if (sql === MONEY_CODES_SQL) {
      return (tables.money_codes ?? [])
        .filter(
          (r) =>
            r.driver_id === params[0] ||
            r.load_id === params[1] ||
            (params[3] !== null && r.document_id === params[3]) ||
            (params[4] !== null && r.voice_note_id === params[4]),
        )
        .map((r) => ({ ...r }));
    }
    if (MONEY_CODE_LIST.test(sql)) return [];
    if (LEDGER_BY_KIND.test(sql)) {
      return (tables.money_actions ?? []).filter((r) => r.kind === params[0]).map((r) => ({ ...r }));
    }
    // The escrow release reads (escrow/read.ts, due.ts, statement.ts): the plan's drivers and paid
    // weeks, and releases from an escrow_releases list a test adds (the plan holds none).
    if (sql === DRIVER_ESCROW_SQL) {
      return plan.rows.drivers
        .filter((d) => d.id === params[0])
        .map((d) => ({
          id: d.id,
          code: d.code,
          active_from: d.active_from,
          active_to: d.active_to,
          escrow_balance_cents: d.escrow_balance_cents,
        }));
    }
    if (sql === DRIVER_RELEASES_SQL) {
      return (tables.escrow_releases ?? []).filter((r) => r.driver_id === params[0]).map((r) => ({ ...r }));
    }
    if (sql === ESCROW_DUE_SQL) {
      const held = new Set(
        (tables.escrow_releases ?? [])
          .filter((r) => ["issuing", "released", "unknown"].includes(String(r.status)))
          .map((r) => r.driver_id),
      );
      return plan.rows.drivers
        .filter((d) => d.active_to !== null && d.active_to <= String(params[0]))
        .filter((d) => d.escrow_balance_cents > 0 && !held.has(d.id))
        .sort((x, y) => (x.active_to === y.active_to ? (x.code < y.code ? -1 : 1) : x.active_to! < y.active_to! ? -1 : 1))
        .slice(0, Number(params[1]))
        .map((d) => ({ id: d.id, code: d.code, active_to: d.active_to, escrow_balance_cents: d.escrow_balance_cents }));
    }
    if (sql === STATEMENT_WEEKS_SQL) return [];
    // The factoring papers: the named invoices' loads, then the uploaded papers and the portal's
    // proof of delivery, from lists a test adds (the plan holds neither), or none.
    if (sql === PACKET_INVOICES_SQL) {
      const ids = new Set(JSON.parse(String(params[0])) as string[]);
      return plan.rows.invoices
        .filter((i) => ids.has(i.id))
        .map((i) => ({ id: i.id, load_id: i.load_id ?? null }));
    }
    if (sql === PACKET_DOCUMENTS_SQL || sql === PACKET_PODS_SQL) return [];
    // The factoring request list: the plan holds no requests.
    if (sql.startsWith(FACTORING_REQUESTS_SQL)) return [];
    // The loads an approved invoice card wrote an invoice for. The plan holds no cards, so this
    // answers from a proposals list a test adds, or none: every seeded invoice is history.
    if (sql === QUEUE_CARD_LOADS_SQL) {
      const cards = (tables.proposals ?? []).filter(
        (r) =>
          r.kind === "invoice_post" &&
          r.origin === "engine" &&
          r.subject_table === "loads" &&
          ["executing", "done", "failed"].includes(String(r.status)) &&
          (params[0] === null || r.subject_id === params[0]),
      );
      return [...new Set(cards.map((r) => String(r.subject_id)))].map((load_id) => ({ load_id }));
    }
    // get_pinned_rates: the live pins of one kind. A seed plan pins none, so this answers from rows
    // a test adds, or none.
    if (PINNED_RATES.test(sql)) {
      return (tables.pinned_rates ?? [])
        .filter((r) => r.status === "pinned" && r.retired_at === null && r.kind === params[0])
        .map((r) => ({ ...r }));
    }
    // The quarter review's own reads (briefs/quarter-figures.ts). A seed plan holds no proposals,
    // so the fixes and the detention they billed answer from a proposals list a test adds, or none.
    if (sql === QUARTER_RECOVERY_SQL) {
      return (tables.settlement_lines ?? [])
        .filter((r) => r.kind === "advance_recovery")
        .map((r) => ({ settlement_id: r.settlement_id, kind: r.kind, amount_cents: r.amount_cents }));
    }
    if (sql === QUARTER_PROPOSALS_SQL) {
      const since = String(params[0]);
      return (tables.proposals ?? [])
        .filter((r) => String(r.created_at) >= since || (r.decided_at != null && String(r.decided_at) >= since))
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          direction: r.direction,
          amount_cents: r.amount_cents,
          created_at: r.created_at,
          decided_at: r.decided_at ?? null,
        }));
    }
    if (sql === QUARTER_DETENTION_SQL) {
      const fixes = new Map((tables.proposals ?? []).map((p) => [String(p.id), p]));
      return (tables.load_accessorials ?? [])
        .filter((a) => a.kind === "detention" && a.proposal_id != null && fixes.has(String(a.proposal_id)))
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
        .map((a) => {
          const p = fixes.get(String(a.proposal_id))!;
          return {
            id: a.id,
            load_id: a.load_id,
            amount_cents: a.amount_cents,
            proposal_id: p.id,
            proposal_status: p.status,
            decided_at: p.decided_at ?? null,
          };
        });
    }
    // The paged read of load ids and numbers (data/read.ts readLoadNumbers): the loads in id order,
    // after the last id seen on the next pages, up to the limit.
    const numbers = / LIMIT (\d+)$/.exec(sql);
    const stem = numbers ? sql.slice(0, numbers.index) : null;
    if (numbers && (stem === LOAD_NUMBERS_FIRST || stem === LOAD_NUMBERS_NEXT)) {
      const after = stem === LOAD_NUMBERS_NEXT ? String(params[0]) : null;
      return [...(tables.loads ?? [])]
        .filter((r) => after === null || String(r.id) > after)
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
        .slice(0, Number(numbers[1]))
        .map((r) => ({ id: r.id, load_number: r.load_number }));
    }
    // The trust meter's paged read (data/read.ts readTrustInput): the decided, unexpired proposals
    // in the window of instants, in id order, after the last id seen on the next pages. A seed plan
    // holds no proposals, so this answers from a proposals list a test adds, or none.
    if (numbers && (stem === TRUST_DECISIONS_FIRST || stem === TRUST_DECISIONS_NEXT)) {
      const [start, end] = [String(params[0]), String(params[1])];
      const after = stem === TRUST_DECISIONS_NEXT ? String(params[2]) : null;
      return [...(tables.proposals ?? [])]
        .filter((r) => r.decided_at != null && r.status !== "expired")
        .filter((r) => String(r.decided_at) >= start && String(r.decided_at) < end)
        .filter((r) => after === null || String(r.id) > after)
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
        .slice(0, Number(numbers[1]))
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          decided_at: r.decided_at,
          decision_note: r.decision_note ?? null,
          auditor_verdict: r.auditor_verdict ?? null,
          engine_check: r.engine_check ?? null,
          auditor_overridden: r.auditor_override_reason != null,
          engine_overridden: r.engine_override_reason != null,
        }));
    }
    const m = FROM.exec(sql);
    if (!m) return undefined;
    const all = tables[m[1]] ?? [];
    if (m[4] !== undefined) return pageRows(plan.rows, all, m[2], m[3], Number(m[4]), params);
    return filterRows(plan.rows, all, m[2], params).map((r) => ({ ...r }));
  };
  return new FakeDb(tables, handler);
}

// One page as the database gives it: the filter's rows in key order, after the last key seen, up
// to the limit.
function pageRows(
  rows: TenantRows,
  all: Row[],
  where: string | undefined,
  key: string,
  limit: number,
  params: Param[],
): Row[] {
  if (where === undefined || key !== "id") throw new Error("unexpected paged read");
  const last = AFTER_KEY.exec(where);
  if (last && Number(last[1]) !== params.length) throw new Error("the page key is not the last parameter");
  const after = last ? String(params[params.length - 1]) : null;
  const inner = last ? where.slice(0, last.index) : where;
  if (!inner.startsWith("(") || !inner.endsWith(")")) {
    throw new Error(`unexpected paged where clause: ${inner.slice(0, 60)}`);
  }
  const filterParams = after === null ? params : params.slice(0, -1);
  return filterRows(rows, all, inner.slice(1, -1), filterParams)
    .filter((r) => after === null || String(r.id) > after)
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
    .slice(0, limit)
    .map((r) => ({ ...r }));
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
  if (where === ESCROW_LINES) return all.filter((r) => r.kind === "escrow");
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
  if (where === DELIVERED_BETWEEN || where === DELIVERED_LOADS || where === DELIVERED_CUSTOMERS) {
    const [start, end] = params as string[];
    const loads = rows.loads.filter(
      (l) => l.delivered_on !== null && l.delivered_on >= start && l.delivered_on <= end,
    );
    const loadIds = new Set(loads.map((l) => l.id));
    if (where === DELIVERED_BETWEEN) return all.filter((r) => loadIds.has(r.id as string));
    if (where === DELIVERED_CUSTOMERS) {
      const customerIds = new Set(loads.map((l) => l.customer_id));
      return all.filter((r) => customerIds.has(r.id as string));
    }
    return all.filter((r) => loadIds.has(r.load_id as string));
  }
  if (where === PURCHASED_BETWEEN) {
    const [start, end] = params as string[];
    return all.filter((r) => typeof r.purchased_on === "string" && r.purchased_on >= start && r.purchased_on <= end);
  }
  const paidWhere = [PAID_WHERE.all, PAID_WHERE.oneDriver].find((w) => Object.values(w).includes(where));
  if (paidWhere) {
    const [start, end] = (params.slice(0, 2) as string[]).map((t) => Date.parse(t));
    // One driver's read names the driver in $3, in every statement.
    const one = paidWhere === PAID_WHERE.oneDriver ? String(params[2]) : null;
    if (params.length !== (one === null ? 2 : 3)) throw new Error("unexpected year-end parameters");
    const mine = (driverId: unknown) => one === null || driverId === one;
    const inWindow = (st: Row) => {
      const at = typeof st.paid_at === "string" ? Date.parse(st.paid_at) : NaN;
      return st.status === "paid" && at >= start && at < end && mine(st.driver_id);
    };
    if (where === paidWhere.settlements) return all.filter(inWindow);
    const paid = rows.settlements.filter((st) => inWindow(st as unknown as Row));
    if (where === paidWhere.drivers) {
      const ids = new Set(paid.map((st) => st.driver_id));
      return all.filter((r) => ids.has(r.id as string) && mine(r.id));
    }
    const ids = new Set(paid.map((st) => st.id));
    const corrections = rows.pay_items.filter(
      (i) => i.ref_table === "proposals" && i.settlement_id !== null && ids.has(i.settlement_id) && mine(i.driver_id),
    );
    if (where === paidWhere.pay_items) {
      const found = new Set(corrections.map((i) => i.id));
      return all.filter((r) => found.has(r.id as string));
    }
    // The earning lines, and a deduction line only when its first source is a correction's pay item.
    const correctionIds = new Set(corrections.map((i) => i.id));
    const earning = ["load_pay", "accessorial_pay", "reimbursement"];
    return all.filter((r) => {
      if (!ids.has(r.settlement_id as string)) return false;
      if (earning.includes(r.kind as string)) return true;
      const first = Array.isArray(r.sources) ? (r.sources[0] as { table?: unknown; id?: unknown } | undefined) : undefined;
      return r.kind === "other_deduction" && first?.table === "pay_items" && correctionIds.has(first.id as string);
    });
  }
  throw new Error(`unexpected where clause: ${where.slice(0, 60)}`);
}

// The proposal id sample-args gives get_proposal. Proposals are not in a seed plan, so a test
// serves one stored proposal through withProposal.
export const PROPOSAL_ID = "6a1f0c2e-9d3b-4c5a-8e7f-1b2c3d4e5f60";

export type ProposalKindName = "advance_payout" | "pay_correction" | "invoice_fix" | "detention_charge";

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
  if (kind === "detention_charge") {
    const load = rows.loads.find((l) => l.id === plan.planted.detentionLoadIds[0])!;
    const check = detentionChargeOf({
      load,
      customer: rows.customers.find((c) => c.id === load.customer_id)!,
      miles: rows.load_state_miles.filter((m) => m.load_id === load.id),
      accessorials: rows.load_accessorials.filter((a) => a.load_id === load.id),
      invoices: rows.invoices.filter((i) => i.load_id === load.id),
    });
    if (!check.ok) throw new Error("the planted detention load has no charge");
    return {
      ...base,
      title: "Bill unbilled detention",
      subject_table: "loads",
      subject_id: load.id,
      subject_label: load.load_number,
      amount_cents: check.charge.amountCents,
      direction: "in",
      operator_verdict: "not_given",
      sources: JSON.stringify(check.charge.sources),
      args: JSON.stringify(chargeArgsOf(check.charge)),
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
