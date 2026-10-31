import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { setPaused } from "@/lib/autopilot/state";
import { isCrossSite } from "@/lib/http/same-site";
import { failed, objectBody, refused, reply } from "../../sweeps/reply";

// POST: "Pause autopilot" and "Resume". Body { paused: true | false }. A signed-in staff member may
// pause; only an admin may resume; a demo visitor may do neither. Pausing stops every approval the
// autopilot would make (the desk handler and the approval gate both read it); nothing here approves,
// pays or sends.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (flags.autopilot.enabled !== true) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const body = await objectBody(request, 200);
  if (!body || typeof body.paused !== "boolean" || Object.keys(body).length !== 1) return refused("bad_request");
  try {
    const out = await setPaused(session, body.paused);
    if (!out.ok) return refused(out.category);
    return reply({ ok: true, paused: out.paused }, 200);
  } catch (err) {
    return failed("autopilot pause", err);
  }
}
