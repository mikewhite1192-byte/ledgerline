import { refuse, reply } from "@/lib/advances/http";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { checkPendingPull } from "@/lib/pullbacks/execute";
import { pullbackOn } from "@/lib/pullbacks/switches";
import { isUuid } from "@/lib/uuid";

// POST: Check pending. Reads back this card pull-back's open ledger rows by their stored request
// ids and finishes a pull found made (once), or ends it failed when the pull was not made; never
// pulls again. The escrow release check's shape: same-site POST, the pull-back switch first, a
// signed-in member, the staff check (a demo visitor, the judge role, is refused before any work),
// a well-formed id, categories only in the reply (never outside text), never cached.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return refuse("forbidden");
  if (!pullbackOn()) return refuse("disabled");
  const session = await getSession();
  if (!session) return refuse("unauthenticated");
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return refuse("bad_request");
  try {
    const result = await checkPendingPull(session, id.toLowerCase());
    if (result.ok) return reply(result, 200);
    return refuse(result.category, result.retryable);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden");
    console.error("card pull-back check failed:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
