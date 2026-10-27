import { flags } from "@/config/flags";
import { readSweepTurnTrace } from "@/lib/agent/gateway/store";
import { getSession } from "@/lib/auth/session";
import { isUuid } from "@/lib/uuid";
import { failed, refused, reply } from "../../../reply";

// GET: how one turn of a sweep run's second opinion was worked out (the ordering, one driver's
// check or the comparison), for the run page's "How the week was checked". Read-only, read when a
// disclosure is first opened. Only a turn the run names; any member of the carrier, as with the
// run page.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; turnId: string }> }) {
  if (!flags.sweepEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id, turnId } = await params;
  if (!isUuid(id) || !isUuid(turnId)) return refused("bad_request");
  try {
    const trace = await readSweepTurnTrace(session, id.toLowerCase(), turnId.toLowerCase());
    return trace ? reply({ trace }, 200) : refused("not_found");
  } catch (err) {
    return failed("sweep trace read", err);
  }
}
