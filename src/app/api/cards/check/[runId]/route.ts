import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { readRun } from "@/lib/data/card-recon";
import { isCrossSite } from "@/lib/http/same-site";
import { advanceCardCheck } from "@/lib/recon/run";
import { withSessionTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";
import { failed, refused, reply, runBody } from "../../reply";

// GET: where a check is (read-only). POST: one more slice of a running check, under the route's
// 30 s; a check another request is carrying on answers its state, and the page asks again.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

type Params = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Params) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.cardRecon.enabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { runId } = await params;
  if (!isUuid(runId)) return refused("bad_request");
  try {
    const run = await withSessionTenant(session, (q) => readRun(q, runId));
    return run ? reply(runBody(run), 200) : refused("not_found");
  } catch (err) {
    return failed("card check read", err);
  }
}

export async function POST(request: Request, { params }: Params) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.cardRecon.enabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { runId } = await params;
  if (!isUuid(runId)) return refused("bad_request");
  try {
    const state = await advanceCardCheck(session, runId, Date.now() + flags.cardRecon.limits.sliceMs);
    if (!state.ok) return refused(state.category);
    return reply(runBody(state.run), 200);
  } catch (err) {
    return failed("card check advance", err);
  }
}
