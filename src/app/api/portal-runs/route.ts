import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { failure, reply } from "@/lib/portal/http";
import { startPortalRun } from "@/lib/portal/start";

// POST: a person starts a portal run for one load. One live run per load: a second ask returns
// the live run's id. Nothing runs inside this request; the worker starts after the commit.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.strictObject({ loadId: z.uuid(), refresh: z.boolean().optional() });

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(JSON.parse(await request.text()));
    if (!parsed.success) return reply({ error: "bad_request" }, 400);
    body = parsed.data;
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  try {
    const outcome = await startPortalRun(session, { loadId: body.loadId, refresh: body.refresh !== false, turnId: null });
    switch (outcome.kind) {
      case "disabled":
        return reply({ started: false, reason: "disabled" }, 409);
      case "no_portal_load":
        return reply({ error: "no_portal_load" }, 404);
      case "live":
        return reply({ error: "live_run", runId: outcome.runId, status: outcome.status }, 409);
      case "done":
        return reply({ status: "done", runId: outcome.runId }, 200);
      case "queued":
        return reply({ status: "queued", runId: outcome.runId }, 202);
    }
  } catch (err) {
    return failure(err, "portal run start");
  }
}
