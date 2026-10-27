import { flags } from "@/config/flags";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { internalKey, keyMatches } from "@/lib/sweep/internal-key";
import { advanceSweep, startSweep } from "@/lib/sweep/run";
import { serviceSession } from "@/lib/sweep/service-session";
import { isUuid } from "@/lib/uuid";
import { failed, objectBody, refused, reply } from "../../sweeps/reply";

// POST: the nightly kicker (infra/lambda/sweep-kicker). Header x-sweep-key; body
// { action: 'start', tenantId } or { action: 'advance', tenantId, runId }. It never reads a
// person's session: the key is the only way in, and every write runs as the carrier's sweep
// login (0018), which can draft but never approve. Off unless sweepScheduleEnabled is on.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  // A browser page never calls this; the kicker sends no Sec-Fetch-Site.
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  let key: string | null;
  try {
    key = await internalKey();
  } catch {
    key = null;
  }
  if (!key) return refused("not_configured");
  if (!keyMatches(request.headers.get("x-sweep-key"), key)) return reply({ error: "forbidden" }, 403);
  if (!flags.sweepScheduleEnabled) return refused("schedule_off");
  if (!flags.sweepEnabled) return refused("disabled");
  const body = await objectBody(request);
  if (!body || !isUuid(body.tenantId)) return refused("bad_request");
  const action = body.action;
  if (action !== "start" && action !== "advance") return refused("bad_request");
  if (action === "advance" && !isUuid(body.runId)) return refused("bad_request");
  try {
    const db = getDb();
    // The sweep login is the allowlist: a carrier without one is not swept.
    const session = await serviceSession(db, body.tenantId as string);
    if (!session) return refused("not_found");
    if (action === "start") {
      const started = await startSweep(session, { runId: crypto.randomUUID(), trigger: "schedule" }, { db });
      if (!started.ok) return refused(started.category);
      return reply({ runId: started.runId, existing: started.existing }, 200);
    }
    const state = await advanceSweep(session, body.runId as string, Date.now() + flags.sweepLimits.sliceMs, { db });
    if (!state.ok) return refused(state.category);
    console.info(
      `sweep run ${state.runId} ${state.status} found=${state.counts.found ?? 0} ` +
        `drafted=${state.counts.fixes_drafted ?? 0} clean=${state.counts.clean ?? 0}`,
    );
    return reply(state, 200);
  } catch (err) {
    return failed("sweep internal", err);
  }
}
