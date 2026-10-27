import { sortVersions } from "../../../data/config-version";
import { readTable, readTenant } from "../../../data/read";
import type { Queryable } from "../../../db";
import { addDays, localDateOf, periodContaining } from "../../../time/local-date";
import { isUuid } from "../../../uuid";
import type {
  TraceCall,
  TraceDecision,
  TraceExtraCall,
  TraceProposal,
  TraceRef,
  TraceStep,
  TurnTrace,
  WeekRaw,
} from "../../../trace/types";

// Reading back how a turn was worked out, and this carrier's model week, from model_calls,
// turn_steps, gateway_decisions, screenings and proposals. Read-only, inside the store's tenant
// transaction: row security limits every table to the carrier on the session, and each query
// also names current_tenant_id() and joins on the tenant. A turn's trace is shown only to the
// person who started its conversation, as the turn itself is.

const EXTRA_CALLS = 50;
const MONDAY = 1;

type CallCols = {
  m_id: string | null;
  m_target: string | null;
  m_model: string | null;
  m_purpose: string | null;
  m_effort: string | null;
  m_status: string | null;
  m_failure: string | null;
  m_duration_ms: number | string | null;
  m_cost: number | string | null;
};

type StepRow = CallCols & {
  seq: number | string;
  kind: string;
  label: string;
  state: string;
  proposal_id: string | null;
  category: string | null;
  result: string | null;
  tool_calls: string | null;
  call_status: string | null;
  attempts: string | null;
  finished_by: string | null;
  g_id: string | null;
  g_tool: string | null;
  g_decision: string | null;
  g_reason: string | null;
  g_limit: number | string | null;
  g_issued_by: string | null;
  g_refs: string | null;
};

type ProposalRow = CallCols & {
  id: string;
  gateway_decision_id: string;
  operator_verdict: string;
  auditor_verdict: string | null;
  flagged: boolean;
  exceptions: string | null;
};

type ExtraRow = CallCols & { after_seq: number | string; screen_verdict: string | null; screen_via: string | null };

const CODE = /^[a-z_]{2,40}$/;
const COUNT = /^[0-9]{1,6}$/;

const codeOrNull = (v: unknown): string | null => (typeof v === "string" && CODE.test(v) ? v : null);

// A whole number from a driver that may hand integers back as numbers or digit strings.
function wholeOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v === "string" && /^-?[0-9]{1,16}$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function callOf(r: CallCols): TraceCall | null {
  if (!r.m_id || !r.m_target || !r.m_model || !r.m_purpose || !r.m_status) return null;
  return {
    id: r.m_id,
    target: r.m_target,
    model: r.m_model,
    purpose: r.m_purpose,
    effort: r.m_effort,
    status: r.m_status,
    failure: r.m_failure,
    durationMs: wholeOrNull(r.m_duration_ms),
    // Null is "not settled yet". A value that is not a whole number becomes -1, which every
    // display reads as "cost unknown" rather than as a figure.
    costNanocents: r.m_cost === null ? null : (wholeOrNull(r.m_cost) ?? -1),
  };
}

function parseArray(text: string | null): unknown[] {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function refsOf(text: string | null): TraceRef[] {
  return parseArray(text).flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const { table, id } = r as Record<string, unknown>;
    return typeof table === "string" && typeof id === "string" ? [{ table, id }] : [];
  });
}

function decisionOf(r: StepRow): TraceDecision | null {
  if (!r.g_id || !r.g_tool || !r.g_decision || !r.g_reason) return null;
  return {
    id: r.g_id,
    tool: r.g_tool,
    decision: r.g_decision,
    reason: r.g_reason,
    limitCents: wholeOrNull(r.g_limit),
    issuedBy: r.g_issued_by,
    refs: refsOf(r.g_refs),
  };
}

function stepOf(r: StepRow): TraceStep {
  const attempts = r.attempts !== null && COUNT.test(r.attempts) ? Number(r.attempts) : null;
  const finishedBy = codeOrNull(r.finished_by);
  return {
    seq: Number(r.seq),
    kind: r.kind,
    label: r.label,
    state: r.state,
    call: callOf(r),
    decision: decisionOf(r),
    proposalId: r.proposal_id,
    category: codeOrNull(r.category),
    result: codeOrNull(r.result),
    toolCalls: r.tool_calls !== null && COUNT.test(r.tool_calls) ? Number(r.tool_calls) : null,
    incomplete: r.call_status === "incomplete",
    escalation: r.kind === "escalation" ? { attempts: attempts ?? 2, finishedBy: finishedBy ?? "none" } : null,
  };
}

const CALL_SELECT = (a: string) =>
  `${a}.id AS m_id, ${a}.target AS m_target, ${a}.model AS m_model, ${a}.purpose AS m_purpose,
   ${a}.reasoning_effort AS m_effort, ${a}.status AS m_status, ${a}.failure AS m_failure,
   ${a}.duration_ms AS m_duration_ms, ${a}.cost_nanocents AS m_cost`;

export async function readTurnTrace(q: Queryable, sub: string, turnId: string): Promise<TurnTrace | null> {
  const turns = await q.query<{ id: string; status: string; trace_id: string }>(
    `SELECT t.id, t.status, t.trace_id
       FROM turns t
       JOIN conversations c ON c.id = t.conversation_id AND c.tenant_id = t.tenant_id
      WHERE t.id = CAST($1 AS uuid) AND c.created_by = $2 AND t.tenant_id = current_tenant_id()`,
    [turnId, sub],
  );
  if (turns.length !== 1) return null;
  const turn = turns[0];

  const steps = await q.query<StepRow>(
    `SELECT s.seq, s.kind, s.label, s.state, s.proposal_id,
            s.detail->>'category' AS category, s.detail->>'result' AS result,
            s.detail->>'toolCalls' AS tool_calls, s.detail->>'status' AS call_status,
            s.detail->>'attempts' AS attempts, s.detail->>'finishedBy' AS finished_by,
            ${CALL_SELECT("m")},
            g.id AS g_id, g.tool AS g_tool, g.decision AS g_decision, g.reason AS g_reason,
            g.limit_cents AS g_limit, g.model_call_id AS g_issued_by, CAST(g.refs AS text) AS g_refs
       FROM turn_steps s
       LEFT JOIN model_calls m ON m.id = s.model_call_id AND m.tenant_id = s.tenant_id
       LEFT JOIN gateway_decisions g ON g.id = s.gateway_decision_id AND g.tenant_id = s.tenant_id
      WHERE s.turn_id = CAST($1 AS uuid) AND s.tenant_id = current_tenant_id()
      ORDER BY s.seq`,
    [turn.id],
  );

  const proposals = await q.query<ProposalRow>(
    `SELECT p.id, p.gateway_decision_id, p.operator_verdict, p.auditor_verdict,
            p.flagged_input_id IS NOT NULL AS flagged, CAST(p.exceptions AS text) AS exceptions,
            ${CALL_SELECT("a")}
       FROM proposals p
       LEFT JOIN model_calls a ON a.id = p.auditor_call_id AND a.tenant_id = p.tenant_id
      WHERE p.turn_id = CAST($1 AS uuid) AND p.tenant_id = current_tenant_id()
      ORDER BY p.created_at, p.id`,
    [turn.id],
  );

  // The turn's other calls: every call carries the turn's trace id, so a screening (or a call
  // whose step failed before linking it) is found here. Calls a step or a proposal names are left
  // out. A trace id that is not a uuid cannot match model_calls.trace_id, so it is not tried.
  let extras: ExtraRow[] = [];
  if (isUuid(turn.trace_id)) {
    extras = await q.query<ExtraRow>(
      `SELECT ${CALL_SELECT("m")},
              COALESCE((SELECT max(s.seq) FROM turn_steps s
                         WHERE s.turn_id = CAST($2 AS uuid) AND s.tenant_id = m.tenant_id
                           AND s.started_at <= m.created_at), 0) AS after_seq,
              sc.verdict AS screen_verdict, sc.via AS screen_via
         FROM model_calls m
         LEFT JOIN LATERAL (
           SELECT x.verdict, x.via FROM screenings x
            WHERE x.model_call_id = m.id AND x.tenant_id = m.tenant_id
            ORDER BY x.created_at DESC, x.id DESC LIMIT 1
         ) sc ON true
        WHERE m.tenant_id = current_tenant_id() AND m.trace_id = CAST($1 AS uuid)
          AND m.id NOT IN (SELECT s.model_call_id FROM turn_steps s
                            WHERE s.turn_id = CAST($2 AS uuid) AND s.model_call_id IS NOT NULL)
          AND m.id NOT IN (SELECT p.auditor_call_id FROM proposals p
                            WHERE p.turn_id = CAST($2 AS uuid) AND p.auditor_call_id IS NOT NULL)
        ORDER BY m.created_at, m.id
        LIMIT ${EXTRA_CALLS}`,
      [turn.trace_id, turn.id],
    );
  }

  return {
    turnId: turn.id,
    status: turn.status,
    steps: steps.map(stepOf),
    extraCalls: extras.flatMap((r): TraceExtraCall[] => {
      const call = callOf(r);
      if (!call) return [];
      const verdict = codeOrNull(r.screen_verdict);
      const via = codeOrNull(r.screen_via);
      return [
        {
          ...call,
          afterSeq: wholeOrNull(r.after_seq) ?? 0,
          screen: verdict && via ? { verdict, via } : null,
        },
      ];
    }),
    proposals: proposals.map(
      (r): TraceProposal => ({
        id: r.id,
        gatewayDecisionId: r.gateway_decision_id,
        operatorVerdict: r.operator_verdict,
        auditorVerdict: r.auditor_verdict,
        auditorCall: callOf(r),
        flagged: r.flagged === true,
        exceptions: parseArray(r.exceptions).filter((c): c is string => typeof c === "string" && CODE.test(c)),
      }),
    ),
  };
}

type GroupRow = {
  target: string;
  model: string;
  status: string;
  calls: number | string;
  cost: number | string;
  held: number | string;
  unsettled: number | string;
};

// Whole numbers the summary checks again; a value that is not one stays as it came, so the
// summary refuses it instead of reading it as zero.
const n = (v: number | string): number => wholeOrNull(v) ?? Number.NaN;

// This carrier's model week. The week is the carrier's pay week in its own time zone, as the
// agent's summary states it; a carrier with no pay config yet counts its weeks from Monday.
export async function readModelWeek(q: Queryable, now: Date): Promise<WeekRaw> {
  const tenant = await readTenant(q);
  const zone = tenant?.timezone ?? "UTC";
  const today = localDateOf(now.toISOString(), zone);
  // Every pay config version has the same week shape, so the oldest names the week's first day.
  // A carrier with no pay config yet counts from Monday; a broken one is refused, never guessed.
  const versions = await readTable(q, "pay_configs");
  const dow = versions.length === 0 ? MONDAY : sortVersions(versions)[0].week_start_dow;
  const week = periodContaining(today, dow);
  const range = [zone, `${week.start}T00:00:00`, `${addDays(week.end, 1)}T00:00:00`];
  const inWeek = (col: string) =>
    `${col} >= timezone(CAST($1 AS text), CAST($2 AS timestamp))
     AND ${col} < timezone(CAST($1 AS text), CAST($3 AS timestamp))`;

  const groups = await q.query<GroupRow>(
    `SELECT target, model, status, CAST(count(*) AS integer) AS calls,
            CAST(COALESCE(SUM(cost_nanocents), 0) AS bigint) AS cost,
            CAST(COALESCE(SUM(CASE WHEN cost_nanocents IS NULL THEN reserved_nanocents ELSE 0 END), 0)
                 AS bigint) AS held,
            CAST(count(*) FILTER (WHERE cost_nanocents IS NULL) AS integer) AS unsettled
       FROM model_calls
      WHERE tenant_id = current_tenant_id() AND ${inWeek("created_at")}
      GROUP BY target, model, status
      ORDER BY target, model, status`,
    range,
  );
  const latencies = await q.query<{ target: string; p50: number | string | null }>(
    `SELECT target,
            CAST(percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms) AS integer) AS p50
       FROM model_calls
      WHERE tenant_id = current_tenant_id() AND ${inWeek("created_at")}
        AND status IN ('ok', 'incomplete') AND duration_ms IS NOT NULL
      GROUP BY target
      ORDER BY target`,
    range,
  );
  const decisions = await q.query<{ decision: string; count: number | string }>(
    `SELECT decision, CAST(count(*) AS integer) AS count
       FROM gateway_decisions
      WHERE tenant_id = current_tenant_id() AND ${inWeek("created_at")}
      GROUP BY decision
      ORDER BY decision`,
    range,
  );
  const screenings = await q.query<{ verdict: string; via: string; count: number | string }>(
    `SELECT verdict, via, CAST(count(*) AS integer) AS count
       FROM screenings
      WHERE tenant_id = current_tenant_id() AND ${inWeek("created_at")}
      GROUP BY verdict, via
      ORDER BY verdict, via`,
    range,
  );
  const escalations = await q.query<{ count: number | string }>(
    `SELECT CAST(count(*) AS integer) AS count
       FROM turn_steps
      WHERE tenant_id = current_tenant_id() AND kind = 'escalation' AND ${inWeek("started_at")}`,
    range,
  );

  return {
    week: { start: week.start, end: week.end, zone },
    groups: groups.map((g) => ({
      target: g.target,
      model: g.model,
      status: g.status,
      calls: n(g.calls),
      costNanocents: n(g.cost),
      heldNanocents: n(g.held),
      unsettled: n(g.unsettled),
    })),
    latencies: latencies.map((l) => ({ target: l.target, p50Ms: l.p50 === null ? null : n(l.p50) })),
    decisions: decisions.map((d) => ({ decision: d.decision, count: n(d.count) })),
    screenings: screenings.map((s) => ({ verdict: s.verdict, via: s.via, count: n(s.count) })),
    escalations: escalations.length === 1 ? n(escalations[0].count) : Number.NaN,
  };
}
