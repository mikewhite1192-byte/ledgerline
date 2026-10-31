import { flags } from "@/config/flags";
import { parseFaultChange } from "@/lib/adapters/tms-source/faults";
import { readRole } from "@/lib/auth/role";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { assertMembership } from "@/lib/tenant/context";
import { saveDemoFaults } from "@/lib/tms/demo-faults";
import { failed, objectBody, refused, reply } from "../../sweeps/reply";

// POST: Settings > Demo's dispatch fault switches. A signed-in admin of the carrier (the only role
// the page shows the panel to; staff and judges are refused) turns some of the synthetic dispatch
// feed's faults on or off: the body is { <fault>: true | false, ... }, every key one of the fixed
// faults and every value a boolean, or the whole request is refused. It writes only the caller's
// own tenant's tms_connections.demo_faults (RLS), and answers 404 while
// flags.tmsSync.demoFaultsEnabled is off or the carrier has no synthetic connection. It reads and
// writes nothing else: no load moves, no money moves, nothing is sent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here, again where the switches are written, and again in the feed.
  if (flags.tmsSync.demoFaultsEnabled !== true) return refused("not_found");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const body = await objectBody(request, 1_000);
  const change = body === null ? null : parseFaultChange(body);
  try {
    const out = await getDb().withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      if ((await readRole(q, session)) !== "admin") return "role" as const;
      if (change === null) return "bad_request" as const;
      return saveDemoFaults(q, change);
    });
    if (out === "role" || out === "bad_request") return refused(out);
    if (out.kind !== "ok") return refused("not_found");
    return reply({ faults: out.faults }, 200);
  } catch (err) {
    return failed("demo faults", err);
  }
}
