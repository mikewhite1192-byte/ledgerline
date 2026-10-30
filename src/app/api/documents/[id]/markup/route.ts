import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { markDocument } from "@/lib/documents/markup";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";
import { failure, REFUSAL_STATUS, reply } from "../../reply";

// POST: make one marked copy of a read photo (the image model circles the line in question and
// writes what the records say beside it; a second read checks the copy). Staff only: the service
// opens its transaction with the carrier membership check, the same check every documents route
// makes. Both switches are checked here and again at the model calls.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One edit (up to 60 seconds) and one check (up to 25) run inside the request.
export const maxDuration = 120;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.documentsEnabled || !flags.documentMarkupEnabled) return reply({ error: "disabled" }, 404);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const outcome = await markDocument(session, id);
    if (!outcome.ok) return reply({ error: outcome.error }, REFUSAL_STATUS[outcome.error] ?? 409);
    return reply({ document: outcome.view }, 200);
  } catch (err) {
    return failure("markup", err);
  }
}
