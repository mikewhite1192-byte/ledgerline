import { z } from "zod";
import { refuse, reply } from "@/lib/advances/http";
import { readDeskLoads, readDeskSuggestion } from "@/lib/advances/read";
import { advancesOn } from "@/lib/advances/switches";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { withSessionTenant } from "@/lib/tenant/context";

// POST: what the request desk shows once a driver (and maybe a load) is picked: the driver's
// recent delivered loads and the pay rules' suggested amount, with the load's cap. Reads only; the
// engine computes every number, no model is asked.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.strictObject({ driverId: z.uuid(), loadId: z.uuid().optional() });

export async function POST(request: Request) {
  if (isCrossSite(request)) return refuse("forbidden");
  if (!advancesOn()) return refuse("disabled");
  const session = await getSession();
  if (!session) return refuse("unauthenticated");
  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return refuse("bad_request");
    body = parsed.data;
  } catch {
    return refuse("bad_request");
  }
  const driverId = body.driverId.toLowerCase();
  const loadId = body.loadId === undefined ? null : body.loadId.toLowerCase();
  const now = new Date();
  try {
    const out = await withSessionTenant(session, async (q) => {
      const loads = await readDeskLoads(q, driverId, now);
      const suggestion = await readDeskSuggestion(q, driverId, loadId, now);
      return { loads, suggestion };
    });
    if (out.suggestion === "not_found" || out.suggestion === "load_not_drivers") return refuse(out.suggestion);
    return reply({ ok: true, loads: out.loads, suggestion: out.suggestion }, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden");
    console.error("advance suggestion failed:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
