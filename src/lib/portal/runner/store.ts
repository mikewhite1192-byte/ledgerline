import { randomUUID } from "node:crypto";
import type { ComputerScreenshot, SafetyCheck } from "../../ai";
import { untrustedContentHash } from "../../data/content-hash";
import { getDb, type Queryable, type TenantDb } from "../../db";
import { mintSession, type MintedSession } from "../session";
import { iso } from "../sql";
import type { ActionSummary } from "./actions";
import type { PortalRecord, Readback } from "./answer";

// The runner's reads and writes, one short tenant transaction each (design 3.3). The loop never
// holds a transaction across a model call or a browser action. Every write after the claim is
// guarded by the claim token and status 'running', so a worker that lost its claim writes nothing.

export type RunRow = {
  id: string;
  loadId: string;
  reference: string;
  requestedBy: string;
  turnId: string | null;
  traceId: string;
  model: "wonder" | "spark";
  stepCount: number;
  modelCallCount: number;
  costNanocents: number;
  lastUrl: string | null;
  sessionId: string | null;
  resumeStep: number | null;
};

export type ClaimResult =
  | { kind: "claimed"; run: RunRow; member: boolean }
  | { kind: "not_queued" }
  | { kind: "missing" };

export type StoredStep = {
  id: string;
  seq: number;
  callItem: Record<string, unknown> | null;
  upstreamCallId: string | null;
  executed: boolean;
  urlAfter: string | null;
  pendingCheckCount: number;
};

export type StoredCheck = {
  id: string;
  stepId: string;
  checkId: string;
  status: "pending" | "approved" | "declined" | "expired";
  createdAt: string;
};

export type NewStep = {
  seq: number;
  modelCallId: string | null;
  call: { callId: string; raw: Record<string, unknown> } | null;
  summary: ActionSummary[];
  executed: boolean;
  stoppedEarly: boolean;
  screenshot: ComputerScreenshot | null;
  urlAfter: string | null;
  costNanocents: number;
  pendingCheckCount: number;
};

export type Progress = {
  costNanocents: number;
  modelCallCount: number;
  stepCount: number;
  lastUrl: string | null;
};

export type EvidenceRow = {
  checkedIn: string | null;
  checkedOut: string | null;
  zone: string | null;
  timesStepSeq: number | null;
  pod: { bytes: Uint8Array; hash: string; stepSeq: number } | null;
  answer: Record<string, unknown>;
  untrustedInputId: string;
  screenVerdict: "clean" | "flagged";
  readback: Readback;
};

export type Ending = { status: "done" | "failed" | "declined" | "stopped"; reason: string; result?: unknown };

export interface RunStore {
  claim(runId: string, token: string, now: Date): Promise<ClaimResult>;
  // The load number and the carrier number the task text needs.
  context(run: RunRow): Promise<{ loadNumber: string; carrierNumber: string } | null>;
  // A new session for a new run, attached to it.
  mintSession(run: RunRow, token: string, now: Date): Promise<MintedSession | null>;
  sessionState(sessionId: string, now: Date): Promise<"alive" | "not_signed_in" | "expired">;
  steps(runId: string): Promise<StoredStep[]>;
  screenshot(runId: string, seq: number): Promise<ComputerScreenshot | null>;
  checks(runId: string): Promise<StoredCheck[]>;
  insertStep(runId: string, token: string, step: NewStep): Promise<string>;
  // A paused step, now executed after approval.
  completeStep(
    runId: string,
    token: string,
    seq: number,
    done: { screenshot: ComputerScreenshot; urlAfter: string; stoppedEarly: boolean },
  ): Promise<void>;
  // Pauses the run on a step's checks: one pending row per check, stamped with the runner's clock
  // (the approval wait counts from it), the run waiting for a person.
  pause(
    runId: string,
    token: string,
    stepId: string,
    checks: SafetyCheck[],
    progress: Progress,
    now: Date,
  ): Promise<void>;
  progress(runId: string, token: string, progress: Progress): Promise<void>;
  finish(runId: string, token: string, ending: Ending, progress: Progress | null, now: Date): Promise<void>;
  portalRecord(loadId: string): Promise<PortalRecord | null>;
  // The model's answer, stored as outside text for the screener.
  storeAnswer(text: string, now: Date): Promise<string>;
  // The evidence row and the run's end, in one transaction.
  finishWithEvidence(
    runId: string,
    token: string,
    loadId: string,
    evidence: EvidenceRow,
    ending: Ending,
    progress: Progress,
    now: Date,
  ): Promise<void>;
}

// A write that should have touched a row and did not: the claim was lost or the run moved on.
export class LostClaimError extends Error {
  constructor() {
    super("the run is no longer claimed by this worker");
    this.name = "LostClaimError";
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const RUN_COLUMNS =
  "id, load_id, reference, requested_by, turn_id, trace_id, model, step_count, model_call_count," +
  " cost_nanocents, last_url, session_id, resume_step";

type RawRun = {
  id: string;
  load_id: string;
  reference: string;
  requested_by: string;
  turn_id: string | null;
  trace_id: string;
  model: "wonder" | "spark";
  step_count: number;
  model_call_count: number;
  cost_nanocents: number;
  last_url: string | null;
  session_id: string | null;
  resume_step: number | null;
};

const runOf = (r: RawRun): RunRow => ({
  id: r.id,
  loadId: r.load_id,
  reference: r.reference,
  requestedBy: r.requested_by,
  turnId: r.turn_id,
  traceId: r.trace_id,
  model: r.model,
  stepCount: Number(r.step_count),
  modelCallCount: Number(r.model_call_count),
  costNanocents: Number(r.cost_nanocents),
  lastUrl: r.last_url,
  sessionId: r.session_id,
  resumeStep: r.resume_step === null ? null : Number(r.resume_step),
});

const GUARD = "tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND claim_token = CAST($2 AS uuid) AND status = 'running'";

async function progressIn(q: Queryable, runId: string, token: string, p: Progress): Promise<void> {
  const n = await q.execute(
    "UPDATE portal_runs SET cost_nanocents = $3, model_call_count = $4, step_count = $5, last_url = $6" +
      ` WHERE ${GUARD}`,
    [runId, token, p.costNanocents, p.modelCallCount, p.stepCount, p.lastUrl],
  );
  if (n !== 1) throw new LostClaimError();
}

async function finishIn(
  q: Queryable,
  runId: string,
  token: string,
  ending: Ending,
  now: Date,
): Promise<void> {
  const n = await q.execute(
    "UPDATE portal_runs SET status = $3, ended_reason = $4, finished_at = CAST($5 AS timestamptz)," +
      " result = CAST($6 AS jsonb), claim_token = NULL" +
      ` WHERE ${GUARD}`,
    [runId, token, ending.status, ending.reason, now.toISOString(), JSON.stringify(ending.result ?? null)],
  );
  if (n !== 1) throw new LostClaimError();
}

export function dbRunStore(tenantId: string, db: TenantDb = getDb()): RunStore {
  const tx = <T>(fn: (q: Queryable) => Promise<T>) => db.withTenant(tenantId, fn);
  return {
    claim: (runId, token, now) =>
      tx(async (q) => {
        const rows = await q.query<RawRun>(
          "UPDATE portal_runs SET status = 'running', claim_token = CAST($2 AS uuid)," +
            " claimed_at = CAST($3 AS timestamptz), started_at = COALESCE(started_at, CAST($3 AS timestamptz))" +
            " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'queued'" +
            ` RETURNING ${RUN_COLUMNS}`,
          [runId, token, now.toISOString()],
        );
        if (rows.length !== 1) {
          const seen = await q.query<{ ok: number }>(
            "SELECT 1 AS ok FROM portal_runs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
            [runId],
          );
          return { kind: seen.length === 1 ? "not_queued" : "missing" };
        }
        const run = runOf(rows[0]);
        // The run acts for the person who asked for it, so that person must still be a member.
        const member = await q.query<{ ok: number }>(
          "SELECT 1 AS ok FROM memberships WHERE cognito_sub = $1",
          [run.requestedBy],
        );
        return { kind: "claimed", run, member: member.length === 1 };
      }),

    context: (run) =>
      tx(async (q) => {
        const rows = await q.query<{ load_number: string; carrier_number: string }>(
          "SELECT l.load_number, a.carrier_number FROM loads l" +
            " JOIN portal_accounts a ON a.tenant_id = l.tenant_id" +
            " WHERE l.tenant_id = current_tenant_id() AND l.id = CAST($1 AS uuid)",
          [run.loadId],
        );
        return rows.length === 1 ? { loadNumber: rows[0].load_number, carrierNumber: rows[0].carrier_number } : null;
      }),

    mintSession: (run, token, now) =>
      tx(async (q) => {
        const minted = await mintSession(q, { runId: run.id, createdBy: run.requestedBy, now });
        const n = await q.execute(
          `UPDATE portal_runs SET session_id = CAST($3 AS uuid) WHERE ${GUARD} AND session_id IS NULL`,
          [run.id, token, minted.sessionId],
        );
        if (n !== 1) throw new LostClaimError();
        return minted;
      }),

    sessionState: (sessionId, now) =>
      tx(async (q) => {
        const rows = await q.query<{ signed_in: boolean; alive: boolean }>(
          "SELECT signed_in_at IS NOT NULL AS signed_in," +
            " COALESCE(session_expires_at > CAST($2 AS timestamptz), false) AS alive" +
            " FROM portal_sessions WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
          [sessionId, now.toISOString()],
        );
        if (rows.length !== 1) return "expired";
        if (!rows[0].signed_in) return "not_signed_in";
        return rows[0].alive ? "alive" : "expired";
      }),

    steps: (runId) =>
      tx(async (q) => {
        const rows = await q.query<{
          id: string;
          seq: number;
          call_item: Record<string, unknown> | string | null;
          upstream_call_id: string | null;
          executed: boolean;
          url_after: string | null;
          pending_check_count: number;
        }>(
          "SELECT id, seq, call_item, upstream_call_id, executed, url_after, pending_check_count" +
            " FROM portal_run_steps WHERE tenant_id = current_tenant_id() AND run_id = CAST($1 AS uuid)" +
            " ORDER BY seq",
          [runId],
        );
        return rows.map((r) => ({
          id: r.id,
          seq: Number(r.seq),
          callItem: typeof r.call_item === "string" ? JSON.parse(r.call_item) : r.call_item,
          upstreamCallId: r.upstream_call_id,
          executed: r.executed,
          urlAfter: r.url_after,
          pendingCheckCount: Number(r.pending_check_count),
        }));
      }),

    screenshot: (runId, seq) =>
      tx(async (q) => {
        const rows = await q.query<{ mime: "image/png" | "image/jpeg" | null; data: string | null }>(
          "SELECT screenshot_mime AS mime, encode(screenshot, 'base64') AS data FROM portal_run_steps" +
            " WHERE tenant_id = current_tenant_id() AND run_id = CAST($1 AS uuid) AND seq = $2",
          [runId, seq],
        );
        if (rows.length !== 1 || !rows[0].mime || !rows[0].data) return null;
        return { mime: rows[0].mime, bytes: new Uint8Array(Buffer.from(rows[0].data, "base64")) };
      }),

    checks: (runId) =>
      tx(async (q) => {
        const rows = await q.query<{
          id: string;
          step_id: string;
          check_id: string;
          status: StoredCheck["status"];
          created_at: string;
        }>(
          `SELECT id, step_id, check_id, status, ${iso("created_at")} FROM portal_run_checks` +
            " WHERE tenant_id = current_tenant_id() AND run_id = CAST($1 AS uuid) ORDER BY created_at, check_id",
          [runId],
        );
        return rows.map((r) => ({
          id: r.id,
          stepId: r.step_id,
          checkId: r.check_id,
          status: r.status,
          createdAt: r.created_at,
        }));
      }),

    insertStep: (runId, token, step) =>
      tx(async (q) => {
        const owned = await q.query<{ ok: number }>(`SELECT 1 AS ok FROM portal_runs WHERE ${GUARD}`, [runId, token]);
        if (owned.length !== 1) throw new LostClaimError();
        const id = randomUUID();
        await q.execute(
          "INSERT INTO portal_run_steps (id, tenant_id, run_id, seq, model_call_id, upstream_call_id, call_item," +
            " action_summary, executed, stopped_early, screenshot_mime, screenshot, screenshot_bytes, url_after," +
            " cost_nanocents, pending_check_count)" +
            " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS uuid), $5," +
            " CAST($6 AS jsonb), CAST($7 AS jsonb), $8, $9, $10, decode($11, 'base64'), $12, $13, $14, $15)",
          [
            id,
            runId,
            step.seq,
            step.modelCallId,
            step.call ? step.call.callId : null,
            step.call ? JSON.stringify(step.call.raw) : null,
            JSON.stringify(step.summary),
            step.executed,
            step.stoppedEarly,
            step.screenshot ? step.screenshot.mime : null,
            step.screenshot ? b64(step.screenshot.bytes) : null,
            step.screenshot ? step.screenshot.bytes.length : null,
            step.urlAfter,
            step.costNanocents,
            step.pendingCheckCount,
          ],
        );
        return id;
      }),

    completeStep: (runId, token, seq, done) =>
      tx(async (q) => {
        const owned = await q.query<{ ok: number }>(`SELECT 1 AS ok FROM portal_runs WHERE ${GUARD}`, [runId, token]);
        if (owned.length !== 1) throw new LostClaimError();
        const n = await q.execute(
          "UPDATE portal_run_steps SET executed = true, stopped_early = $3, screenshot_mime = $4," +
            " screenshot = decode($5, 'base64'), screenshot_bytes = $6, url_after = $7" +
            " WHERE tenant_id = current_tenant_id() AND run_id = CAST($1 AS uuid) AND seq = $2 AND NOT executed",
          [
            runId,
            seq,
            done.stoppedEarly,
            done.screenshot.mime,
            b64(done.screenshot.bytes),
            done.screenshot.bytes.length,
            done.urlAfter,
          ],
        );
        if (n !== 1) throw new LostClaimError();
      }),

    pause: (runId, token, stepId, checks, progress, now) =>
      tx(async (q) => {
        await progressIn(q, runId, token, progress);
        for (const c of checks) {
          await q.execute(
            "INSERT INTO portal_run_checks (id, tenant_id, run_id, step_id, check_id, code, message, status," +
              " created_at) VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid)," +
              " $4, $5, $6, 'pending', CAST($7 AS timestamptz))",
            [randomUUID(), runId, stepId, c.id, c.code, c.message, now.toISOString()],
          );
        }
        const n = await q.execute(
          `UPDATE portal_runs SET status = 'waiting_approval', claim_token = NULL, resume_step = NULL WHERE ${GUARD}`,
          [runId, token],
        );
        if (n !== 1) throw new LostClaimError();
      }),

    progress: (runId, token, progress) => tx((q) => progressIn(q, runId, token, progress)),

    finish: (runId, token, ending, progress, now) =>
      tx(async (q) => {
        if (progress) await progressIn(q, runId, token, progress);
        await finishIn(q, runId, token, ending, now);
      }),

    portalRecord: (loadId) =>
      tx(async (q) => {
        const rows = await q.query<{
          delivery_checked_in_at: string | null;
          delivery_checked_out_at: string | null;
          facility_time_zone: string;
          pod_content_hash: string | null;
        }>(
          `SELECT ${iso("delivery_checked_in_at")}, ${iso("delivery_checked_out_at")}, facility_time_zone,` +
            " pod_content_hash FROM portal_loads WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)",
          [loadId],
        );
        if (rows.length !== 1) return null;
        return {
          checkedIn: rows[0].delivery_checked_in_at,
          checkedOut: rows[0].delivery_checked_out_at,
          zone: rows[0].facility_time_zone,
          podContentHash: rows[0].pod_content_hash,
        };
      }),

    storeAnswer: (text, now) =>
      tx(async (q) => {
        const id = randomUUID();
        await q.execute(
          "INSERT INTO untrusted_inputs (id, tenant_id, kind, source, body_text, content_hash, received_at)" +
            " VALUES (CAST($1 AS uuid), current_tenant_id(), 'portal', 'portal_run', $2, $3, CAST($4 AS timestamptz))",
          [id, text, untrustedContentHash("portal", text), now.toISOString()],
        );
        return id;
      }),

    finishWithEvidence: (runId, token, loadId, ev, ending, progress, now) =>
      tx(async (q) => {
        await progressIn(q, runId, token, progress);
        await q.execute(
          "INSERT INTO portal_evidence (id, tenant_id, run_id, load_id, delivery_checked_in_at," +
            " delivery_checked_out_at, facility_time_zone, times_step_seq, pod_pdf, pod_byte_length," +
            " pod_content_hash, pod_step_seq, answer, untrusted_input_id, screen_verdict, readback_match)" +
            " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid)," +
            " CAST($4 AS timestamptz), CAST($5 AS timestamptz), $6, $7, decode($8, 'base64'), $9, $10, $11," +
            " CAST($12 AS jsonb), CAST($13 AS uuid), $14, $15)",
          [
            randomUUID(),
            runId,
            loadId,
            ev.checkedIn,
            ev.checkedOut,
            ev.zone,
            ev.timesStepSeq,
            ev.pod ? b64(ev.pod.bytes) : null,
            ev.pod ? ev.pod.bytes.length : null,
            ev.pod ? ev.pod.hash : null,
            ev.pod ? ev.pod.stepSeq : null,
            JSON.stringify(ev.answer),
            ev.untrustedInputId,
            ev.screenVerdict,
            ev.readback,
          ],
        );
        await finishIn(q, runId, token, ending, now);
      }),
  };
}
