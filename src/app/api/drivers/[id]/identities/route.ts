import { z } from "zod";
import { bodyAction } from "@/lib/advances/http";
import { addIdentity } from "@/lib/advances/identity";

// POST: an id the dispatch system knows this driver by (src/lib/advances/identity.ts). Our own
// row only; nothing syncs.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.strictObject({
  system: z.literal("tms"),
  externalId: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return bodyAction(request, params, Body, (session, ids, body) => addIdentity(session, ids.id, body));
}
