import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { callAnswer, callFailed, callRefuse, phoneOn } from "@/lib/calls/http";
import { finishHandOff } from "@/lib/calls/pipeline";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: finish the hand-off a segment left waiting (its request had no time left for the agent's
// turn). The same hand-off as the voice note page's, with the same claim, so a second press answers
// with the first turn's conversation. Staff only, like the segment it follows.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const PLACE = /^(0|[1-9][0-9]{0,6})$/;

export async function POST(request: Request, { params }: { params: Promise<{ id: string; seq: string }> }) {
  if (isCrossSite(request)) return callRefuse("forbidden");
  if (!phoneOn()) return callRefuse("disabled");
  const session = await getSession();
  if (!session) return callRefuse("unauthenticated");
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id, seq } = await params;
  if (!isUuid(id) || !PLACE.test(seq)) return callRefuse("bad_request");
  try {
    return callAnswer(await finishHandOff(session, id, Number(seq)));
  } catch (err) {
    return callFailed(err, "hand-off");
  }
}
