import { z } from "zod";
import { flags } from "@/config/flags";
import { bodyAction, refuse } from "@/lib/advances/http";
import { TAKEBACK_REASONS, takeBackAdvance } from "@/lib/advances/takeback";

// POST: a person takes an advance back (src/lib/advances/takeback.ts): an unpaid one is cancelled,
// a paid one records the amount taken back. Nothing is pulled off the card. The switch is asked
// here and again by the service.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.strictObject({
  amountCents: z.int().min(0).max(100_000_000),
  reason: z.enum(TAKEBACK_REASONS),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (flags.advanceTakeback.enabled !== true) return refuse("disabled");
  return bodyAction(request, params, Body, (session, ids, body) => takeBackAdvance(session, ids.id, body));
}
