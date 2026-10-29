import { CLEAN_SQL } from "../agent/proposals/clean";
import { parseChecklist, type Checklist } from "../agent/checklist";
import { readProposalViews } from "../agent/gateway/store/views";
import type { ProposalView } from "../agent/view";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { readFanoutTree, type FanoutTree } from "./fanout/tree";
import { endSweep } from "./checklist";
import { countItems, type SweepCounts } from "./run";

// What the sweep pages show: rows only, every number from the database, no model text except an
// explanation that already passed the figures check.

export type SweepRunView = {
  id: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  trigger: string;
  status: "running" | "done" | "failed";
  phase: string;
  capCents: number;
  spentCents: number;
  counts: Partial<SweepCounts>;
  truncatedReason: string | null;
  failureCategory: string | null;
  conversationId: string | null;
  startedAt: string;
  finishedAt: string | null;
  // This run's fixes that are done (approved and written).
  approved: number;
  // The run's phases as a checklist, ticked as it moves; null for a run started without one.
  checklist?: Checklist | null;
};

export type SweepItemView = {
  id: string;
  check: string;
  category: string;
  leg: number;
  kind: "fix" | "needs_person";
  driverCode: string | null;
  driverName: string | null;
  expectedCents: number | null;
  note: string | null;
  sourceRefs: { table: string; id: string }[];
  status: string;
  refusalCategory: string | null;
  proposalId: string | null;
  proposalStatus: string | null;
  amountCents: number | null;
  direction: string | null;
  auditorVerdict: string | null;
  decidedAt: string | null;
  clean: boolean;
  explanation: string | null;
  explainCategory: string | null;
  auditAttempts: number;
};

export type SweepPage = {
  run: SweepRunView;
  items: SweepItemView[];
  // Counted from the items now (the run row keeps the counts as they were when it finished).
  counts: SweepCounts;
  // The drafted proposals as the cards show them, by id.
  proposals: Record<string, ProposalView>;
  // What "Approve all clean" would send: this run's clean fixes, id order, and their total.
  clean: { proposalIds: string[]; totalCents: number };
  // How the week was checked a second time, or null when the run never reached that step.
  fanout: FanoutTree | null;
};

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type RunRow = {
  id: string;
  period_id: string;
  period_start: string;
  period_end: string;
  trigger: string;
  status: SweepRunView["status"];
  phase: string;
  cap_cents: number | string;
  spent_cents: number | string;
  counts: string;
  truncated_reason: string | null;
  failure_category: string | null;
  conversation_id: string | null;
  started_at: string;
  finished_at: string | null;
  approved: number | string;
  checklist: string | null;
};

const RUN_SELECT = `
  SELECT r.id, r.period_id, CAST(sp.period_start AS text) AS period_start,
         CAST(sp.period_end AS text) AS period_end, r.trigger, r.status, r.phase, r.cap_cents,
         r.spent_cents, CAST(r.counts AS text) AS counts, r.truncated_reason, r.failure_category,
         r.conversation_id, ${TS("r.started_at")} AS started_at, ${TS("r.finished_at")} AS finished_at,
         CAST(r.checklist AS text) AS checklist,
         (SELECT count(DISTINCT p.id) FROM sweep_items i JOIN proposals p ON p.id = i.proposal_id
           WHERE i.seen_run_id = r.id AND p.status = 'done') AS approved
    FROM sweep_runs r JOIN settlement_periods sp ON sp.id = r.period_id`;

function runOf(r: RunRow): SweepRunView {
  let counts: Partial<SweepCounts> = {};
  try {
    const v: unknown = JSON.parse(r.counts);
    if (v && typeof v === "object" && !Array.isArray(v)) counts = v as Partial<SweepCounts>;
  } catch {
    // stays empty
  }
  // A run given up while nobody held it ends without its last write: what it left is not finished.
  const list = parseChecklist(r.checklist);
  const checklist = list && r.status === "failed" ? endSweep(list, "failed") : list;
  return {
    id: r.id,
    periodId: r.period_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    trigger: r.trigger,
    status: r.status,
    phase: r.phase,
    capCents: Number(r.cap_cents),
    spentCents: Number(r.spent_cents),
    counts,
    truncatedReason: r.truncated_reason,
    failureCategory: r.failure_category,
    conversationId: r.conversation_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    approved: Number(r.approved),
    checklist,
  };
}

type ItemRow = {
  id: string;
  check_name: string;
  category: string;
  leg: number | string;
  kind: SweepItemView["kind"];
  driver_code: string | null;
  driver_name: string | null;
  expected_cents: number | string | null;
  note: string | null;
  source_refs: string;
  status: string;
  refusal_category: string | null;
  proposal_id: string | null;
  proposal_status: string | null;
  amount_cents: number | string | null;
  direction: string | null;
  auditor_verdict: string | null;
  decided_at: string | null;
  clean: boolean | null;
  explanation: string | null;
  explain_category: string | null;
  audit_attempts: number | string;
};

const num = (v: number | string | null) => (v === null ? null : Number(v));

function refsOf(text: string): { table: string; id: string }[] {
  try {
    const v: unknown = JSON.parse(text);
    if (!Array.isArray(v)) return [];
    return v.flatMap((r) => {
      const { table, id } = (r ?? {}) as Record<string, unknown>;
      return typeof table === "string" && typeof id === "string" ? [{ table, id }] : [];
    });
  } catch {
    return [];
  }
}

export async function readSweepPage(
  session: Session,
  runId: string,
  deps: { db?: TenantDb } = {},
): Promise<SweepPage | null> {
  if (!isUuid(runId)) return null;
  const db = deps.db ?? getDb();
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const runs = await q.query<RunRow>(`${RUN_SELECT} WHERE r.id = CAST($1 AS uuid)`, [runId]);
    if (runs.length !== 1) return null;
    const items = await q.query<ItemRow>(
      `SELECT i.id, i.check_name, i.category, i.leg, i.kind, d.code AS driver_code,
              CASE WHEN d.id IS NULL THEN NULL ELSE d.first_name || ' ' || d.last_name END AS driver_name,
              i.expected_cents, i.note, CAST(i.source_refs AS text) AS source_refs, i.status, i.refusal_category, i.proposal_id,
              p.status AS proposal_status, p.amount_cents, p.direction, p.auditor_verdict,
              ${TS("p.decided_at")} AS decided_at,
              (p.id IS NOT NULL AND p.kind = 'pay_correction' AND i.kind = 'fix' AND ${CLEAN_SQL}) AS clean,
              i.explanation, i.explain_category, i.audit_attempts
         FROM sweep_items i
         LEFT JOIN drivers d ON d.id = i.driver_id
         LEFT JOIN proposals p ON p.id = i.proposal_id
        WHERE i.seen_run_id = CAST($1 AS uuid)
        ORDER BY (i.kind = 'fix') DESC, d.code NULLS LAST, i.check_name, i.leg, i.finding_key`,
      [runId],
    );
    const views: SweepItemView[] = items.map((i) => ({
      id: i.id,
      check: i.check_name,
      category: i.category,
      leg: Number(i.leg),
      kind: i.kind,
      driverCode: i.driver_code,
      driverName: i.driver_name,
      expectedCents: num(i.expected_cents),
      note: i.note,
      sourceRefs: refsOf(i.source_refs),
      status: i.status,
      refusalCategory: i.refusal_category,
      proposalId: i.proposal_id,
      proposalStatus: i.proposal_status,
      amountCents: num(i.amount_cents),
      direction: i.direction,
      auditorVerdict: i.auditor_verdict,
      decidedAt: i.decided_at,
      clean: i.clean === true,
      explanation: i.explanation,
      explainCategory: i.explain_category,
      auditAttempts: Number(i.audit_attempts),
    }));
    const clean = views.filter((v) => v.clean && v.proposalId !== null);
    const ids = [...new Set(clean.map((v) => v.proposalId as string))].sort();
    const total = ids.reduce((n, id) => n + (clean.find((v) => v.proposalId === id)?.amountCents ?? 0), 0);
    const linked = [...new Set(views.flatMap((v) => (v.proposalId ? [v.proposalId] : [])))];
    const proposals: Record<string, ProposalView> = {};
    for (const p of await readProposalViews(q, linked)) proposals[p.id] = p;
    const counts = await countItems(q, runId);
    const fanout = await readFanoutTree(q, runId);
    return {
      run: runOf(runs[0]),
      items: views,
      counts,
      proposals,
      clean: { proposalIds: ids, totalCents: total },
      fanout,
    };
  });
}

export type SweepHome = {
  openPeriod: { id: string; periodStart: string; periodEnd: string } | null;
  runs: SweepRunView[];
};

// The sweep's own page and the home card: the open week and the latest runs.
export async function readSweepHome(session: Session, deps: { db?: TenantDb } = {}): Promise<SweepHome> {
  const db = deps.db ?? getDb();
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const open = await q.query<{ id: string; period_start: string; period_end: string }>(
      `SELECT id, CAST(period_start AS text) AS period_start, CAST(period_end AS text) AS period_end
         FROM settlement_periods WHERE status = 'open' ORDER BY period_start DESC LIMIT 2`,
    );
    const runs = await q.query<RunRow>(`${RUN_SELECT} ORDER BY r.started_at DESC, r.id LIMIT 10`);
    return {
      openPeriod:
        open.length === 1 ? { id: open[0].id, periodStart: open[0].period_start, periodEnd: open[0].period_end } : null,
      runs: runs.map(runOf),
    };
  });
}
