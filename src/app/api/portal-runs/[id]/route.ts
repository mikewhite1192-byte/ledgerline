import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { asMember, failure, reply } from "@/lib/portal/http";
import { runView } from "@/lib/portal/views";
import { isUuid } from "@/lib/uuid";

// GET: one run as its page shows it: steps without images, checks as categories, evidence
// without the POD bytes, and the model calls on its trace.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!flags.portalRunnerEnabled) return reply({ error: "not_found" }, 404);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const view = await asMember(session, (q) => runView(q, id, new Date()));
    return view ? reply({ run: view }, 200) : reply({ error: "not_found" }, 404);
  } catch (err) {
    return failure(err, "portal run read");
  }
}
