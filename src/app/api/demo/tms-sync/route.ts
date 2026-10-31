import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { serviceSession } from "@/lib/sweep/service-session";
import { assertMembership } from "@/lib/tenant/context";
import { syncDispatchNow } from "@/lib/tms/sync";
import { failed, refused, reply } from "../../sweeps/reply";

// POST: Settings > Demo's "Sync dispatch now". A signed-in staff member pulls the dispatch mirror
// once, under the desk loop's lease (busy while a wake holds it). The person's session proves
// membership; the pull runs as the carrier's sweep login, as the desk does. It only reads the
// dispatch system and writes the mirror; a load moves later, on the desk, and only when its own
// switches are on. Nothing here approves, pays or sends.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here and again inside the sync.
  if (flags.tmsSync.enabled !== true) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  try {
    const db = getDb();
    await db.withTenant(session.tenantId, (q) => assertMembership(q, session));
    const service = await serviceSession(db, session.tenantId);
    if (!service) return refused("not_configured");
    const out = await syncDispatchNow(db, service, new Date());
    if (!out.ok) return refused(out.category === "switched_off" ? "disabled" : out.category);
    const r = out.result;
    if (!r.ran) return refused(r.category === "no_lease" ? "busy" : r.category === "switched_off" ? "disabled" : "not_configured");
    return reply(
      {
        listed: r.listed,
        read: r.read,
        written: r.written,
        gone: r.gone,
        failed: r.failed,
        passComplete: r.passComplete,
        listFailed: r.listFailed,
      },
      200,
    );
  } catch (err) {
    return failed("dispatch sync", err);
  }
}
