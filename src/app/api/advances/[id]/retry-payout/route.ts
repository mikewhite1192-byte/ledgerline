import { retryAdvancePayout } from "@/lib/advances/approve";
import { advanceAction } from "@/lib/advances/http";

// POST: a person retries a payout that definitely failed, as the next attempt
// (src/lib/advances/approve.ts). An unknown payout is never retried; Check pending reads it back.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return advanceAction(request, params, (session, id) => retryAdvancePayout(session, id));
}
