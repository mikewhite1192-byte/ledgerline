import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { kickPortalRun, runnerReady, type Kick } from "./runner/kick";
import { latestEvidence, type EvidenceView } from "./views";

// Starting a portal run (design 4.1): the start route and the agent's fetch_portal_evidence tool
// both come here. One live run per load: the partial unique index on portal_runs is the dedupe
// key, so the same ask twice is one run.

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
  if (!isUuid(input.loadId)) return { kind: "no_portal_load" };
  const portal = await q.query<{ reference: string }>(
    "SELECT reference FROM portal_loads WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)",
    [input.loadId],
  );
  if (portal.length !== 1) return { kind: "no_portal_load" };
  if (!input.refresh) {
    const done = await latestEvidence(q, input.loadId);
    if (done) return { kind: "done", runId: done.runId, evidence: done };
  }
  const live = await liveRun(q, input.loadId);
  if (live) return { kind: "live", runId: live.id, status: live.status };
  const runId = randomUUID();
  const inserted = await q.query<{ id: string }>(
    "INSERT INTO portal_runs (id, tenant_id, load_id, reference, requested_by, turn_id, trace_id, model, status," +
      " created_at)" +
      " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, CAST($5 AS uuid), $6, $7, 'queued'," +
      " CAST($8 AS timestamptz))" +
      " ON CONFLICT DO NOTHING RETURNING id",
    [
      runId,
      input.loadId,
      portal[0].reference,
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
