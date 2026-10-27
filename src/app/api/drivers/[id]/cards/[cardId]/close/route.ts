import { z } from "zod";
import { bodyAction } from "@/lib/advances/http";
import { closeCard } from "@/lib/advances/identity";

// POST: an admin closes one of the driver's cards (src/lib/advances/identity.ts). A closed card is
// never paid and never the default.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; cardId: string }> }) {
  return bodyAction(request, params, z.strictObject({}), (session, ids) => closeCard(session, ids.id, ids.cardId));
}
