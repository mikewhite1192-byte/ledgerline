import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { advanceSweep, startSweep } from "@/lib/sweep/run";
import { isUuid } from "@/lib/uuid";
import { failed, objectBody, refused, reply } from "./reply";

// POST: "Run sweep now". Body { runId (a uuid the page made), periodId? }. Opens the run (a
// replay or a second press returns the running one) and runs its first slice; the page then calls
// .../advance until the run is done. The sweep only drafts; nothing here approves or pays.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here and again inside startSweep and advanceSweep.
  if (!flags.sweepEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const body = await objectBody(request);
  const periodId = body?.periodId ?? null;
  if (!body || !isUuid(body.runId) || (periodId !== null && !isUuid(periodId))) return refused("bad_request");
  try {
    const started = await startSweep(session, {
      runId: body.runId as string,
      periodId: periodId as string | null,
      trigger: "button",
    });
    if (!started.ok) return refused(started.category);
    const deadline = Date.now() + flags.sweepLimits.sliceMs;
    const state = await advanceSweep(session, started.runId, deadline);
    // Another request is carrying the run on: the page polls it like any other slice.
    if (!state.ok && state.category === "busy") return reply({ runId: started.runId, status: "running", busy: true }, 202);
    if (!state.ok) return refused(state.category);
    return reply(state, 202);
  } catch (err) {
    return failed("sweep start", err);
  }
}
