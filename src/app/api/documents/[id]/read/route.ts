import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { readAgain } from "@/lib/documents/service";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";
import { failure, REFUSAL_STATUS, reply } from "../../reply";

// POST: read a document again whose first read never finished (the request that started it went
// away). Only a read pending for more than two minutes is taken, and only by one request.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.documentsEnabled) return reply({ error: "disabled" }, 404);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const outcome = await readAgain(session, id);
    if (!outcome.ok) return reply({ error: outcome.error }, REFUSAL_STATUS[outcome.error] ?? 409);
    return reply({ document: outcome.view }, 200);
  } catch (err) {
    return failure("read again", err);
  }
}
