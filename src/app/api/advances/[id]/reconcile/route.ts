import { checkAdvancePayouts } from "@/lib/advances/approve";
import { advanceAction } from "@/lib/advances/http";

// POST: Check pending. Reads back this carrier's open advance payouts and posts by their
// request ids; never sends anything new.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return advanceAction(request, params, (session, id) => checkAdvancePayouts(session, id));
}
