import { refuse, reply } from "@/lib/advances/http";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { checkPendingEscrowRelease } from "@/lib/escrow/reconcile";
import { escrowReleaseOn } from "@/lib/escrow/switches";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: Check pending. Reads back this escrow release's open payout rows by their stored request
// ids and finishes a release found paid (once), or ends it failed when the payout was not paid;
// never sends a new payout. The money code check's shape: same-site POST, the escrow release
// switch first, a signed-in member, the staff check (a demo visitor, the judge role, is refused
// before any work), a well-formed id, categories only in the reply (never outside text), never
// cached.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return refuse("forbidden");
  if (!escrowReleaseOn()) return refuse("disabled");
  const session = await getSession();
  if (!session) return refuse("unauthenticated");
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return refuse("bad_request");
  try {
    const result = await checkPendingEscrowRelease(session, id.toLowerCase());
    if (result.ok) return reply(result, 200);
    return refuse(result.category, result.retryable);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden");
    console.error("escrow release check failed:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
