import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { isUuid } from "../uuid";
import { iso } from "./sql";

// A person's decision on one safety check (design 3.4). This is the only code that sets a check
// to approved. Any member of the carrier may decide (D2: the run only reads). One click per
// check; a repeat click, or a click on a run that has moved on, returns the state and writes
// nothing. The run row is locked first, so two clicks at once are decided one after the other.

export type DecideOutcome =
  | { kind: "not_found" }
  | { kind: "unchanged"; runStatus: string; checkStatus: string }
  | { kind: "approved"; resume: boolean }
  | { kind: "declined" }
  | { kind: "expired" }
  | { kind: "session_expired" };

async function endRun(q: Queryable, runId: string, status: "declined" | "stopped", reason: string, now: string) {
  await q.execute(
    "UPDATE portal_runs SET status = $2, ended_reason = $3, finished_at = CAST($4 AS timestamptz)," +
      " held_pod_pdf = NULL, held_pod_step_seq = NULL, paused_pod_hash = NULL" +
      " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'waiting_approval'",
    [runId, status, reason, now],
  );
}

async function expirePending(q: Queryable, runId: string, by: string, now: string) {
  await q.execute(
    "UPDATE portal_run_checks SET status = 'expired', decided_by = $2, decided_at = CAST($3 AS timestamptz)" +
      " WHERE tenant_id = current_tenant_id() AND run_id = CAST($1 AS uuid) AND status = 'pending'",
    [runId, by, now],
  );
}

// Inside the caller's tenant transaction, membership already confirmed.
export async function decideCheck(
  q: Queryable,
  session: Session,
  input: { runId: string; checkId: string; decision: "approve" | "decline" },
  now: Date,
): Promise<DecideOutcome> {
  if (!isUuid(input.runId) || !isUuid(input.checkId)) return { kind: "not_found" };
  const runs = await q.query<{ status: string; session_id: string | null }>(
    "SELECT status, session_id FROM portal_runs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)" +
      " FOR UPDATE",
    [input.runId],
  );
  if (runs.length !== 1) return { kind: "not_found" };
  const checks = await q.query<{ status: string; seq: number; created_at: string }>(
    `SELECT c.status, s.seq, ${iso("c.created_at")} FROM portal_run_checks c` +
      " JOIN portal_run_steps s ON s.tenant_id = c.tenant_id AND s.id = c.step_id" +
      " WHERE c.tenant_id = current_tenant_id() AND c.run_id = CAST($1 AS uuid) AND c.id = CAST($2 AS uuid)",
    [input.runId, input.checkId],
  );
  if (checks.length !== 1) return { kind: "not_found" };
  const run = runs[0];
  const check = checks[0];
  if (check.status !== "pending" || run.status !== "waiting_approval") {
    return { kind: "unchanged", runStatus: run.status, checkStatus: check.status };
  }
  const at = now.toISOString();
  const by = session.sub;

  if (now.getTime() - Date.parse(check.created_at) > flags.portalRunLimits.approvalWaitMinutes * 60_000) {
    await expirePending(q, input.runId, by, at);
    await endRun(q, input.runId, "stopped", "approval_expired", at);
    return { kind: "expired" };
  }

  const decide = (status: "approved" | "declined") =>
    q.execute(
      "UPDATE portal_run_checks SET status = $3, decided_by = $4, decided_at = CAST($5 AS timestamptz)" +
        " WHERE tenant_id = current_tenant_id() AND run_id = CAST($1 AS uuid) AND id = CAST($2 AS uuid)" +
        " AND status = 'pending'",
      [input.runId, input.checkId, status, by, at],
    );

  if (input.decision === "decline") {
    await decide("declined");
    await expirePending(q, input.runId, by, at);
    await endRun(q, input.runId, "declined", "declined", at);
    return { kind: "declined" };
  }

  // The run can only go on inside its portal session's 60 minutes.
  const alive = run.session_id
    ? await q.query<{ ok: number }>(
        "SELECT 1 AS ok FROM portal_sessions WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)" +
          " AND session_expires_at > CAST($2 AS timestamptz)",
        [run.session_id, at],
      )
    : [];
  if (alive.length !== 1) {
    await expirePending(q, input.runId, by, at);
    await endRun(q, input.runId, "stopped", "session_expired", at);
    return { kind: "session_expired" };
  }

  await decide("approved");
  const left = await q.query<{ n: number }>(
    "SELECT CAST(count(*) AS integer) AS n FROM portal_run_checks WHERE tenant_id = current_tenant_id()" +
      " AND run_id = CAST($1 AS uuid) AND status = 'pending'",
    [input.runId],
  );
  if (Number(left[0]?.n ?? 1) > 0) return { kind: "approved", resume: false };
  await q.execute(
    "UPDATE portal_runs SET status = 'queued', resume_step = $2, queued_at = CAST($3 AS timestamptz)" +
      " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'waiting_approval'",
    [input.runId, Number(check.seq), at],
  );
  return { kind: "approved", resume: true };
}
