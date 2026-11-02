import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { setPaused, type PauseChange } from "@/lib/autopilot/state";
import { isCrossSite } from "@/lib/http/same-site";
import { failed, objectBody, refused, reply } from "../../sweeps/reply";

// POST: "Pause autopilot" and "Resume". Body { paused: true } or { paused: false, pausedAt }, where
// pausedAt is the pause the page showed (an ISO instant, or null); a Resume on a pause that has
// changed since is refused as changed (409). A signed-in staff member may pause; only an admin may
// resume; a demo visitor may do neither. Pausing stops every approval the autopilot would make (the
// desk handler and the approval gate both read it); nothing here approves, pays or sends.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

// The body's change, or null for anything else. A Resume must name the pause it saw.
function changeOf(body: Record<string, unknown> | null): PauseChange | null {
  if (!body) return null;
  const keys = Object.keys(body).length;
  if (body.paused === true) return keys === 1 ? { paused: true } : null;
  if (body.paused !== false || keys !== 2 || !Object.hasOwn(body, "pausedAt")) return null;
  const at = body.pausedAt;
  if (at === null) return { paused: false, pausedAt: null };
  return typeof at === "string" && at.length <= 40 ? { paused: false, pausedAt: at } : null;
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (flags.autopilot.enabled !== true) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const body = await objectBody(request, 200);
  const change = changeOf(body);
  if (!change) return refused("bad_request");
  try {
    const out = await setPaused(session, change);
    if (!out.ok) return refused(out.category);
    return reply({ ok: true, paused: out.paused }, 200);
  } catch (err) {
    return failed("autopilot pause", err);
  }
}
