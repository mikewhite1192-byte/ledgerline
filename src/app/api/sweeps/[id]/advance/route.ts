import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { advanceSweep } from "@/lib/sweep/run";
import { isUuid } from "@/lib/uuid";
import { failed, refused, reply } from "../../reply";

// POST: one more slice of a running sweep (each under the route's 30 s). A run another request is
// carrying answers busy, and the page asks again; a finished run answers its final state.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.sweepEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return refused("bad_request");
  try {
    const state = await advanceSweep(session, id, Date.now() + flags.sweepLimits.sliceMs);
    if (!state.ok) return refused(state.category);
    return reply(state, 200);
  } catch (err) {
    return failed("sweep advance", err);
  }
}
