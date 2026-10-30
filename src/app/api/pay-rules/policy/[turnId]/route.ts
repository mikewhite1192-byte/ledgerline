import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { advancePolicyRun, readPolicyRun } from "@/lib/policy-onboard/run";
import { failure, refused, reply } from "../reply";

// GET: the run as it stands (its steps, checklist, how it ended and its card's id). POST: run its
// next stage (read, screen, propose or the second check), one per request, and answer the run as
// it then stands; busy when another request is running a stage. POST is staff only (a judge never
// runs a step that follows an upload); GET only reads. Only the person who started the run sees
// it. Behind flags.policyOnboardEnabled, read here and again inside the run.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

type Params = { params: Promise<{ turnId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.policyOnboardEnabled) return refused("disabled");
  const { turnId } = await params;
  try {
    const view = await readPolicyRun(session, turnId);
    if (!view) return refused("not_found");
    return reply({ run: view }, 200);
  } catch (err) {
    return failure("read", err);
  }
}

export async function POST(request: Request, { params }: Params) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  if (!flags.policyOnboardEnabled) return refused("disabled");
  const { turnId } = await params;
  try {
    const outcome = await advancePolicyRun(session, turnId);
    if (!outcome.ok) return refused(outcome.error);
    return reply({ run: outcome.view, busy: outcome.busy }, 200);
  } catch (err) {
    return failure("advance", err);
  }
}
