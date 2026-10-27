import type { Queryable } from "../db";
import { isUuid } from "../uuid";
import { sentence, summariesFrom } from "./runner/actions";
import { minutesAtDock, type Readback } from "./runner/answer";
import { iso } from "./sql";
import { isFacilityZone, labelOf, stampText, type ZoneLabel } from "./zones";

// What the run pages, the run routes and the agent tool read about portal runs, inside a tenant
// transaction. No bytes here except the two single-object reads at the bottom; the platform's
// check message and the model's raw answer never leave the rows.

export const LIVE_STATUSES = ["queued", "running", "waiting_approval"] as const;
export type RunStatus = (typeof LIVE_STATUSES)[number] | "done" | "failed" | "declined" | "stopped";
// A run still "running" this long after its worker claimed it has no worker left (design 4.3).
export const STALLED_AFTER_MS = 6 * 60_000;

export type EvidenceView = {
  runId: string;
  checkedIn: string | null;
  checkedOut: string | null;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  zoneLabel: ZoneLabel | null;
  minutesAtDock: number | null;
  pod: "present" | "absent";
  podBytes: number | null;
  timesStepSeq: number | null;
  podStepSeq: number | null;
  screenVerdict: "clean" | "flagged" | "error";
  readback: Readback;
  untrustedInputId: string | null;
  createdAt: string;
};

type EvidenceRaw = {
  run_id: string;
  delivery_checked_in_at: string | null;
  delivery_checked_out_at: string | null;
  facility_time_zone: string | null;
  pod_byte_length: number | null;
  times_step_seq: number | null;
  pod_step_seq: number | null;
  screen_verdict: EvidenceView["screenVerdict"];
  readback_match: Readback;
  untrusted_input_id: string | null;
  created_at: string;
};

const EVIDENCE_COLUMNS =
  `e.run_id, ${iso("e.delivery_checked_in_at")}, ${iso("e.delivery_checked_out_at")}, e.facility_time_zone,` +
  ` e.pod_byte_length, e.times_step_seq, e.pod_step_seq, e.screen_verdict, e.readback_match,` +
  ` e.untrusted_input_id, ${iso("e.created_at")}`;

function evidenceOf(r: EvidenceRaw): EvidenceView {
  const zone = r.facility_time_zone && isFacilityZone(r.facility_time_zone) ? r.facility_time_zone : null;
  const stamp = (v: string | null) => (v && zone ? stampText(v, zone) : null);
  return {
    runId: r.run_id,
    checkedIn: stamp(r.delivery_checked_in_at),
    checkedOut: stamp(r.delivery_checked_out_at),
    checkedInAt: r.delivery_checked_in_at,
    checkedOutAt: r.delivery_checked_out_at,
    zoneLabel: zone ? labelOf(zone) : null,
    minutesAtDock: minutesAtDock(r.delivery_checked_in_at, r.delivery_checked_out_at),
    pod: r.pod_byte_length ? "present" : "absent",
    podBytes: r.pod_byte_length === null ? null : Number(r.pod_byte_length),
    timesStepSeq: r.times_step_seq === null ? null : Number(r.times_step_seq),
    podStepSeq: r.pod_step_seq === null ? null : Number(r.pod_step_seq),
    screenVerdict: r.screen_verdict,
    readback: r.readback_match,
    untrustedInputId: r.untrusted_input_id,
    createdAt: r.created_at,
  };
}

// The newest evidence for a load, from a finished run.
export async function latestEvidence(q: Queryable, loadId: string): Promise<EvidenceView | null> {
  if (!isUuid(loadId)) return null;
  const rows = await q.query<EvidenceRaw>(
    `SELECT ${EVIDENCE_COLUMNS} FROM portal_evidence e` +
      " WHERE e.tenant_id = current_tenant_id() AND e.load_id = CAST($1 AS uuid)" +
      " ORDER BY e.created_at DESC, e.id LIMIT 1",
    [loadId],
  );
  return rows.length === 1 ? evidenceOf(rows[0]) : null;
}

export type RunSummary = {
  id: string;
  loadId: string;
  loadNumber: string;
  reference: string;
  status: RunStatus;
  endedReason: string | null;
  model: "wonder" | "spark";
  stepCount: number;
  costNanocents: number;
  createdAt: string;
  finishedAt: string | null;
  requestedBy: string | null;
  stalled: boolean;
};

type RunRaw = {
  id: string;
  load_id: string;
  load_number: string;
  reference: string;
  status: RunStatus;
  ended_reason: string | null;
  model: "wonder" | "spark";
  step_count: number;
  cost_nanocents: number;
  created_at: string;
  finished_at: string | null;
  claimed_at: string | null;
  trace_id: string;
  requested_email: string | null;
};

const RUN_SELECT =
  "SELECT r.id, r.load_id, l.load_number, r.reference, r.status, r.ended_reason, r.model, r.step_count," +
  ` r.cost_nanocents, ${iso("r.created_at")}, ${iso("r.finished_at")}, ${iso("r.claimed_at")}, r.trace_id,` +
  " m.email AS requested_email" +
  " FROM portal_runs r JOIN loads l ON l.tenant_id = r.tenant_id AND l.id = r.load_id" +
  " LEFT JOIN memberships m ON m.tenant_id = r.tenant_id AND m.cognito_sub = r.requested_by" +
  " WHERE r.tenant_id = current_tenant_id()";

function summaryOf(r: RunRaw, now: Date): RunSummary {
  return {
    id: r.id,
    loadId: r.load_id,
    loadNumber: r.load_number,
    reference: r.reference,
    status: r.status,
    endedReason: r.ended_reason,
    model: r.model,
    stepCount: Number(r.step_count),
    costNanocents: Number(r.cost_nanocents),
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    requestedBy: r.requested_email,
    stalled:
      r.status === "running" && r.claimed_at !== null && now.getTime() - Date.parse(r.claimed_at) > STALLED_AFTER_MS,
  };
}

export async function listRuns(q: Queryable, now: Date, limit = 50): Promise<RunSummary[]> {
  const rows = await q.query<RunRaw>(`${RUN_SELECT} ORDER BY r.created_at DESC, r.id LIMIT $1`, [limit]);
  return rows.map((r) => summaryOf(r, now));
}

// The delivered loads a person can start a run for: those the portal knows.
export async function portalLoadChoices(q: Queryable): Promise<{ loadId: string; loadNumber: string; reference: string }[]> {
  const rows = await q.query<{ load_id: string; load_number: string; reference: string }>(
    "SELECT p.load_id, l.load_number, p.reference FROM portal_loads p" +
      " JOIN loads l ON l.tenant_id = p.tenant_id AND l.id = p.load_id" +
      " WHERE p.tenant_id = current_tenant_id() ORDER BY l.load_number LIMIT 200",
  );
  return rows.map((r) => ({ loadId: r.load_id, loadNumber: r.load_number, reference: r.reference }));
}

export type StepView = {
  seq: number;
  kind: "opening" | "action" | "answer";
  executed: boolean;
  stoppedEarly: boolean;
  hasScreenshot: boolean;
  sentences: string[];
  costNanocents: number;
  pendingCheckCount: number;
  createdAt: string;
};

export type CheckView = {
  id: string;
  stepSeq: number;
  status: "pending" | "approved" | "declined" | "expired";
  category: string;
  createdAt: string;
  decidedAt: string | null;
};

export type CallView = {
  id: string;
  target: string;
  purpose: string;
  status: string;
  costNanocents: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type RunView = {
  run: RunSummary;
  steps: StepView[];
  checks: CheckView[];
  evidence: EvidenceView | null;
  calls: CallView[];
};

// What a person is shown for a check: a category, never the platform's own text (design 3.4).
export function checkCategory(code: string): string {
  return code === "malicious_instructions"
    ? "The platform thinks this page is trying to instruct the agent"
    : `The platform flagged this step (code: ${code})`;
}

export async function runView(q: Queryable, runId: string, now: Date): Promise<RunView | null> {
  if (!isUuid(runId)) return null;
  const runs = await q.query<RunRaw>(`${RUN_SELECT} AND r.id = CAST($1 AS uuid)`, [runId]);
  if (runs.length !== 1) return null;
  const run = runs[0];
  const steps = await q.query<{
    seq: number;
    call_item_present: boolean;
    action_summary: unknown;
    executed: boolean;
    stopped_early: boolean;
    has_screenshot: boolean;
    cost_nanocents: number;
    pending_check_count: number;
    created_at: string;
  }>(
    "SELECT seq, call_item IS NOT NULL AS call_item_present, action_summary, executed, stopped_early," +
      ` screenshot IS NOT NULL AS has_screenshot, cost_nanocents, pending_check_count, ${iso("created_at")}` +
      " FROM portal_run_steps WHERE tenant_id = current_tenant_id() AND run_id = CAST($1 AS uuid) ORDER BY seq",
    [runId],
  );
  const checks = await q.query<{
    id: string;
    seq: number;
    code: string;
    status: CheckView["status"];
    created_at: string;
    decided_at: string | null;
  }>(
    `SELECT c.id, s.seq, c.code, c.status, ${iso("c.created_at")}, ${iso("c.decided_at")}` +
      " FROM portal_run_checks c JOIN portal_run_steps s ON s.tenant_id = c.tenant_id AND s.id = c.step_id" +
      " WHERE c.tenant_id = current_tenant_id() AND c.run_id = CAST($1 AS uuid) ORDER BY c.created_at, c.id",
    [runId],
  );
  const evidence = await q.query<EvidenceRaw>(
    `SELECT ${EVIDENCE_COLUMNS} FROM portal_evidence e WHERE e.tenant_id = current_tenant_id()` +
      " AND e.run_id = CAST($1 AS uuid)",
    [runId],
  );
  const calls = isUuid(run.trace_id)
    ? await q.query<{
        id: string;
        target: string;
        purpose: string;
        status: string;
        cost_nanocents: number | null;
        duration_ms: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
      }>(
        "SELECT id, target, purpose, status, cost_nanocents, duration_ms, input_tokens, output_tokens" +
          " FROM model_calls WHERE tenant_id = current_tenant_id() AND trace_id = CAST($1 AS uuid)" +
          " ORDER BY created_at, id LIMIT 100",
        [run.trace_id],
      )
    : [];
  const parse = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as unknown) : v);
  const num = (v: number | null) => (v === null ? null : Number(v));
  return {
    run: summaryOf(run, now),
    steps: steps.map((s) => ({
      seq: Number(s.seq),
      kind: Number(s.seq) === 0 ? "opening" : s.call_item_present ? "action" : "answer",
      executed: s.executed,
      stoppedEarly: s.stopped_early,
      hasScreenshot: s.has_screenshot,
      sentences: summariesFrom(parse(s.action_summary)).map(sentence),
      costNanocents: Number(s.cost_nanocents),
      pendingCheckCount: Number(s.pending_check_count),
      createdAt: s.created_at,
    })),
    checks: checks.map((c) => ({
      id: c.id,
      stepSeq: Number(c.seq),
      status: c.status,
      category: checkCategory(c.code),
      createdAt: c.created_at,
      decidedAt: c.decided_at,
    })),
    evidence: evidence.length === 1 ? evidenceOf(evidence[0]) : null,
    calls: calls.map((c) => ({
      id: c.id,
      target: c.target,
      purpose: c.purpose,
      status: c.status,
      costNanocents: num(c.cost_nanocents),
      durationMs: num(c.duration_ms),
      inputTokens: num(c.input_tokens),
      outputTokens: num(c.output_tokens),
    })),
  };
}

// One step's screenshot, the only image in its response.
export async function stepScreenshot(
  q: Queryable,
  runId: string,
  seq: number,
): Promise<{ mime: string; bytes: Uint8Array } | null> {
  if (!isUuid(runId) || !Number.isInteger(seq) || seq < 0 || seq > 100) return null;
  const rows = await q.query<{ mime: string | null; data: string | null }>(
    "SELECT screenshot_mime AS mime, encode(screenshot, 'base64') AS data FROM portal_run_steps" +
      " WHERE tenant_id = current_tenant_id() AND run_id = CAST($1 AS uuid) AND seq = $2",
    [runId, seq],
  );
  if (rows.length !== 1 || !rows[0].mime || !rows[0].data) return null;
  return { mime: rows[0].mime, bytes: new Uint8Array(Buffer.from(rows[0].data, "base64")) };
}

// The POD a run captured, from its evidence row.
export async function evidencePod(q: Queryable, runId: string): Promise<Uint8Array | null> {
  if (!isUuid(runId)) return null;
  const rows = await q.query<{ data: string | null }>(
    "SELECT encode(pod_pdf, 'base64') AS data FROM portal_evidence" +
      " WHERE tenant_id = current_tenant_id() AND run_id = CAST($1 AS uuid)",
    [runId],
  );
  if (rows.length !== 1 || !rows[0].data) return null;
  return new Uint8Array(Buffer.from(rows[0].data, "base64"));
}
