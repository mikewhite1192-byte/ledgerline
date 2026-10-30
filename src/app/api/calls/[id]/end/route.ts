import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { callAnswer, callFailed, callRefuse, phoneOn } from "@/lib/calls/http";
import { endCall } from "@/lib/calls/pipeline";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: end a call. A later segment is refused (not_open); a call already ended answers the same.
// Staff only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return callRefuse("forbidden");
  if (!phoneOn()) return callRefuse("disabled");
  const session = await getSession();
  if (!session) return callRefuse("unauthenticated");
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return callRefuse("bad_request");
  try {
    return callAnswer(await endCall(session, id));
  } catch (err) {
    return callFailed(err, "end");
  }
}
