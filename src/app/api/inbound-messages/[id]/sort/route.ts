import { inboxAction } from "@/lib/inbound/http";
import { sortMessage } from "@/lib/inbound/pipeline";

// POST: "Sort again" for a message whose sort failed (or never finished): one more try, up to the
// switch's limit. A held, sorted or handed-off message answers with where it is.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return inboxAction(request, params, "sort", (session, id) => sortMessage(session, id));
}
