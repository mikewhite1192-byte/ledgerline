import { inboxAction } from "@/lib/inbound/http";
import { handOffMessage } from "@/lib/inbound/pipeline";

// POST: hand a sorted message to the agent as one turn ("Handle inbound message <input id>"). The
// agent reads it through the gateway (screened again, from the cache) and proposes; a person
// approves on the card. A held message is never handed on.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return inboxAction(request, params, "hand-off", (session, id) => handOffMessage(session, id));
}
