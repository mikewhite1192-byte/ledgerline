import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { advanceCardCheck, startCardCheck } from "@/lib/recon/run";
import { failed, refused, reply, runBody } from "../reply";

// POST: "Check cards". Opens a check (a check already running is carried on, never a second one)
// and runs its first slice; the page then calls .../check/[runId] until the check is done. The
// check reads and compares; nothing here approves, pays or posts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  // The slice's deadline counts from the request's start, so opening the check uses up its time too.
  const begun = Date.now();
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here and again inside startCardCheck and advanceCardCheck.
  if (!flags.cardRecon.enabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  try {
    const started = await startCardCheck(session);
    if (!started.ok) return refused(started.category);
    const state = await advanceCardCheck(session, started.runId, begun + flags.cardRecon.limits.sliceMs);
    if (!state.ok) return refused(state.category);
    return reply({ ...runBody(state.run), resumed: started.resumed }, 202);
  } catch (err) {
    return failed("card check start", err);
  }
}
