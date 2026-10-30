import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { kickPortalRun, runnerReady, type Kick } from "./runner/kick";
import {
  latestEvidence,
  MAX_RESUME_ATTEMPTS,
  portalReference,
  STALLED_AFTER_MS,
  UNCLAIMED_AFTER_MS,
  type EvidenceView,
} from "./views";

// Starting a portal run (design 4.1): only a person starts one, through the start route; the
// agent's tool only reads runs. One live run per load: the partial unique index on portal_runs is
// the dedupe key, so the same ask twice is one run.

export type StartOutcome =
  | { kind: "disabled" }
  | { kind: "no_portal_load" }
  | { kind: "done"; runId: string; evidence: EvidenceView }
  | { kind: "live"; runId: string; status: "queued" | "running" | "waiting_approval" }
  | { kind: "queued"; runId: string };

export type StartInput = { loadId: string; refresh: boolean; turnId: string | null };

// Whether runs may start: the switch, and a runner configured for this environment.
export function portalRunsAvailable(): boolean {
  return flags.portalRunnerEnabled && runnerReady();
}

// Clears the load's live runs that no worker will finish, so a lost worker or a failed kick never
// holds the load's one live slot: running longer than STALLED_AFTER_MS since its claim, or queued
// and unclaimed for UNCLAIMED_AFTER_MS (views.ts isStale, the same rule). Both statements run in
// the start's transaction; a worker that comes back finds its claim gone and writes nothing.
//
// First, a stalled running run that has executed at least one model step, has its portal session
// and has been put back fewer than MAX_RESUME_ATTEMPTS times goes back in the queue to carry on
// from its last executed step (resume_step), its counter raised by one. Its held POD and paused
// hash stay as they are. Then every other stale run ends as a runner error, as before. Returns the
// run put back, for the caller to start once the transaction commits (one live run per load, so
// at most one).
async function endStaleRuns(q: Queryable, loadId: string, now: Date): Promise<string | null> {
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const lastExecuted =
    "SELECT max(s.seq) FROM portal_run_steps s WHERE s.tenant_id = current_tenant_id() AND s.run_id = r.id" +
    " AND s.executed AND s.seq > 0";
  const requeued = await q.query<{ id: string }>(
    "UPDATE portal_runs r SET status = 'queued', queued_at = CAST($2 AS timestamptz), claim_token = NULL," +
      ` resume_attempts = r.resume_attempts + 1, resume_step = (${lastExecuted})` +
      " WHERE r.tenant_id = current_tenant_id() AND r.load_id = CAST($1 AS uuid) AND r.status = 'running'" +
      " AND COALESCE(r.claimed_at, r.queued_at) < CAST($3 AS timestamptz) AND r.session_id IS NOT NULL" +
      ` AND r.resume_attempts < $4 AND (${lastExecuted}) IS NOT NULL` +
      " RETURNING r.id",
    [loadId, now.toISOString(), before(STALLED_AFTER_MS), MAX_RESUME_ATTEMPTS],
  );
  await q.execute(
    "UPDATE portal_runs SET status = 'failed', ended_reason = 'runner_error', finished_at = CAST($2 AS timestamptz)," +
      " claim_token = NULL, held_pod_pdf = NULL, held_pod_step_seq = NULL, paused_pod_hash = NULL" +
      " WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid) AND (" +
      "(status = 'running' AND COALESCE(claimed_at, queued_at) < CAST($3 AS timestamptz))" +
      " OR (status = 'queued' AND queued_at < CAST($4 AS timestamptz)))",
    [loadId, now.toISOString(), before(STALLED_AFTER_MS), before(UNCLAIMED_AFTER_MS)],
  );
  return requeued[0]?.id ?? null;
}

async function liveRun(q: Queryable, loadId: string) {
  const rows = await q.query<{ id: string; status: "queued" | "running" | "waiting_approval" }>(
    "SELECT id, status FROM portal_runs WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)" +
      " AND status IN ('queued', 'running', 'waiting_approval')",
    [loadId],
  );
  return rows[0] ?? null;
}

// Inside the caller's tenant transaction (membership already confirmed). Creates the run row when
// there is nothing to reuse; the caller starts the worker once that transaction commits.
export async function createRunIn(
  q: Queryable,
  session: Session,
  input: StartInput,
  now: Date,
): Promise<StartOutcome> {
  if (!portalRunsAvailable()) return { kind: "disabled" };
  const reference = await portalReference(q, input.loadId);
  if (reference === null) return { kind: "no_portal_load" };
  if (!input.refresh) {
    const done = await latestEvidence(q, input.loadId);
    if (done) return { kind: "done", runId: done.runId, evidence: done };
  }
  // A run put back in the queue is this load's live run again, and it needs a worker: it reads as
  // queued, so the start route starts it after the commit.
  const requeued = await endStaleRuns(q, input.loadId, now);
  if (requeued) return { kind: "queued", runId: requeued };
  const live = await liveRun(q, input.loadId);
  if (live) return { kind: "live", runId: live.id, status: live.status };
  const runId = randomUUID();
  const inserted = await q.query<{ id: string }>(
    "INSERT INTO portal_runs (id, tenant_id, load_id, reference, requested_by, turn_id, trace_id, model, status," +
      " created_at, queued_at)" +
      " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, CAST($5 AS uuid), $6, $7, 'queued'," +
      " CAST($8 AS timestamptz), CAST($8 AS timestamptz))" +
      " ON CONFLICT DO NOTHING RETURNING id",
    [
      runId,
      input.loadId,
      reference,
      session.sub,
      input.turnId,
      randomUUID(),
      flags.portalRunnerModel,
      now.toISOString(),
    ],
  );
  if (inserted.length === 1) return { kind: "queued", runId };
  // Another request made the live run between the read and the insert.
  const raced = await liveRun(q, input.loadId);
  return raced ? { kind: "live", runId: raced.id, status: raced.status } : { kind: "disabled" };
}

// The start route's path: its own tenant transaction, then the worker after the commit.
export async function startPortalRun(
  session: Session,
  input: StartInput,
  deps: { db?: TenantDb; kick?: Kick; now?: Date } = {},
): Promise<StartOutcome> {
  if (!portalRunsAvailable()) return { kind: "disabled" };
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const outcome = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return createRunIn(q, session, input, now);
  });
  if (outcome.kind === "queued") (deps.kick ?? kickPortalRun)({ tenantId: session.tenantId, runId: outcome.runId });
  return outcome;
}
