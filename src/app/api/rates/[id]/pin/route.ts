import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { pinSuggestion } from "@/lib/rates/pin";
import { isUuid } from "@/lib/uuid";
import { failed, objectBody, refused, reply } from "../../reply";

// POST: a suggestion's "Pin this rate". Body { effectiveFrom }. An admin only. The suggestion
// becomes the carrier's rate from that day and the rate it replaces is retired, in one
// transaction. Nothing is recalculated, billed or sent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.groundedRatesEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  const body = await objectBody(request);
  if (!isUuid(id) || !body) return refused("bad_request");
  try {
    const out = await pinSuggestion(session, { id, effectiveFrom: body.effectiveFrom });
    if (out.ok) return reply({ ok: true, id: out.id }, 200);
    if ("refused" in out) return refused(out.refused === "off" ? "disabled" : out.refused);
    return refused(out.failed);
  } catch (err) {
    return failed("rate pin", err);
  }
}
