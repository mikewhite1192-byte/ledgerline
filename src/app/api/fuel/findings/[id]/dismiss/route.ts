import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { dismissFuelFinding, isDismissCategory } from "@/lib/fuel/propose";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";
import { failed, objectBody, refused, reply } from "../../../reply";

// POST: a finding's "Dismiss: it checks out". Body { category } from the fixed reason list; no free
// text is taken.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.fuelAnomalyEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  const body = await objectBody(request);
  if (!isUuid(id) || !body || !isDismissCategory(body.category)) return refused("bad_request");
  try {
    const out = await dismissFuelFinding(session, id, body.category);
    if (!out.ok) return refused(out.category);
    return reply({ ok: true }, 200);
  } catch (err) {
    return failed("fuel dismiss", err);
  }
}
