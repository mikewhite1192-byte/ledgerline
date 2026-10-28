import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { lookupRate } from "@/lib/rates/lookup";
import { failed, objectBody, refused, reply } from "../reply";

// POST: "Look up this week's diesel price" or a state's "Look up". Body { kind, state? }. Any
// staff member of the carrier may start one. One model call with web search; what it finds is kept
// as a suggestion for an admin to read and pin. Nothing is pinned, recalculated, billed or sent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 40;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here and twice more inside lookupRate.
  if (!flags.groundedRatesEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const body = await objectBody(request);
  if (!body) return refused("bad_request");
  try {
    const out = await lookupRate(session, { kind: body.kind, state: body.state });
    if (out.ok) return reply({ ok: true, status: out.status, id: out.id }, 200);
    if ("refused" in out) return refused(out.refused === "off" ? "disabled" : out.refused);
    return refused(out.failed);
  } catch (err) {
    return failed("rate lookup", err);
  }
}
