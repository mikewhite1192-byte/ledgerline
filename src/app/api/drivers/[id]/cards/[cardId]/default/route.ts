import { z } from "zod";
import { bodyAction } from "@/lib/advances/http";
import { setDefaultCard } from "@/lib/advances/identity";

// POST: an admin makes one of the driver's active cards the default, the one an advance pays when
// it names no card (src/lib/advances/identity.ts).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; cardId: string }> }) {
  return bodyAction(request, params, z.strictObject({}), (session, ids) =>
    setDefaultCard(session, ids.id, ids.cardId),
  );
}
