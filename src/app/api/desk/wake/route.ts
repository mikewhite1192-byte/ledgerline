import { randomUUID } from "node:crypto";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { wakeDesk } from "@/lib/desk/loop";
import { isCrossSite } from "@/lib/http/same-site";
import { serviceSession } from "@/lib/sweep/service-session";
import { assertMembership } from "@/lib/tenant/context";
import { failed, refused, reply } from "../../sweeps/reply";

// POST: "Wake now". A signed-in member of the carrier wakes its desk loop for one slice. The
// person's session proves membership; the loop's writes run as the carrier's sweep login (as the
// sweep page does), which can draft but never approve. Nothing here approves or pays.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here and again inside wakeDesk.
  if (flags.deskLoop.enabled !== true) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  try {
    const db = getDb();
    await db.withTenant(session.tenantId, (q) => assertMembership(q, session));
    const service = await serviceSession(db, session.tenantId);
    if (!service) return refused("not_configured");
    const result = await wakeDesk(
      service,
      { wakeId: randomUUID(), by: "button", deadlineMs: Date.now() + flags.deskLoop.limits.sliceMs },
      { db },
    );
    if (!result.ok) {
      if (result.category === "unavailable") return reply({ error: "unavailable", retryable: true }, 503);
      return refused(result.category);
    }
    if (result.status === "busy") return refused("busy");
    return reply({ wakeId: result.wakeId, status: result.status, reason: result.reason, counts: result.counts }, 200);
  } catch (err) {
    return failed("desk wake", err);
  }
}
