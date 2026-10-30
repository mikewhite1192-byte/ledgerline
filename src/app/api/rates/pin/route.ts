import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { pinTyped } from "@/lib/rates/pin";
import { failed, objectBody, refused, reply } from "../reply";

// POST: "Type the rate from the page". Body { kind, state?, rate, sourceUrl, effectiveFrom }, the
// rate in dollars per gallon as typed ("3.657"). An admin only, with the https page it came from.
// The typed rate becomes the carrier's rate from that day and the one it replaces is retired.
// Nothing is recalculated, billed or sent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.groundedRatesEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const body = await objectBody(request);
  if (!body) return refused("bad_request");
  try {
    const out = await pinTyped(session, {
      kind: body.kind,
      state: body.state,
      rate: body.rate,
      sourceUrl: body.sourceUrl,
      effectiveFrom: body.effectiveFrom,
    });
    if (out.ok) return reply({ ok: true, id: out.id, already: out.already }, 200);
    if ("refused" in out) return refused(out.refused === "off" ? "disabled" : out.refused);
    return refused(out.failed);
  } catch (err) {
    return failed("typed rate pin", err);
  }
}
