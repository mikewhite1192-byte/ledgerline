import { NextResponse } from "next/server";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getSession } from "../auth/session";
import { getDb, type Queryable, type TenantDb } from "../db";
import { isCrossSite } from "../http/same-site";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { decideCheck } from "./decide";
import { kickPortalRun, type Kick } from "./runner/kick";
import { portalRunsAvailable } from "./start";

// Shared pieces of the portal-run API routes: one reply shape, the member transaction, and the
// approve and decline handler both routes call.

export function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function failure(err: unknown, what: string) {
  if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
  console.error(`${what} failed: ${err instanceof Error ? err.name : "unknown"}`);
  return reply({ error: "unavailable" }, 503);
}

// A transaction in the session's tenant, membership confirmed first.
export function asMember<T>(session: Session, fn: (q: Queryable) => Promise<T>, db: TenantDb = getDb()): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

// POST approve or decline one check (design 3.4, D2: any member). Only a person's click reaches
// this; no code path calls it on its own. The decision commits first, then the worker is kicked.
export async function decideRoute(
  request: Request,
  params: Promise<{ id: string; checkId: string }>,
  decision: "approve" | "decline",
  deps: { db?: TenantDb; kick?: Kick; now?: Date } = {},
) {
  if (!flags.portalRunnerEnabled) return reply({ error: "not_found" }, 404);
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id, checkId } = await params;
  if (!isUuid(id) || !isUuid(checkId)) return reply({ error: "bad_request" }, 400);
  // An approval resumes the run, which needs a runner; a decline never does.
  if (decision === "approve" && !portalRunsAvailable()) return reply({ started: false, reason: "disabled" }, 409);
  try {
    const now = deps.now ?? new Date();
    const outcome = await asMember(session, (q) => decideCheck(q, session, { runId: id, checkId, decision }, now), deps.db);
    switch (outcome.kind) {
      case "not_found":
        return reply({ error: "not_found" }, 404);
      case "unchanged":
        return reply({ status: "unchanged", runStatus: outcome.runStatus, checkStatus: outcome.checkStatus }, 200);
      case "approved": {
        const resumed = outcome.resume ? (deps.kick ?? kickPortalRun)({ tenantId: session.tenantId, runId: id }) : false;
        return reply({ status: "approved", resumed }, 200);
      }
      case "declined":
        return reply({ status: "declined" }, 200);
      case "expired":
        return reply({ error: "approval_expired" }, 409);
      case "session_expired":
        return reply({ error: "session_expired" }, 409);
    }
  } catch (err) {
    return failure(err, "portal check decision");
  }
}
