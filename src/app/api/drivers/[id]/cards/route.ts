import { z } from "zod";
import { bodyAction } from "@/lib/advances/http";
import { addCard } from "@/lib/advances/identity";

// POST: an admin adds a fuel card on file, in test mode (src/lib/advances/identity.ts). The card's
// provider reference is drawn at random by the server; nothing reaches the provider.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.strictObject({
  last4: z.string().regex(/^[0-9]{4}$/),
  holderKind: z.enum(["named", "generic"]),
  portalName: z.string().max(60).optional(),
  makeDefault: z.boolean(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return bodyAction(request, params, Body, (session, ids, body) =>
    addCard(session, ids.id, { ...body, portalName: body.portalName ?? null }),
  );
}
