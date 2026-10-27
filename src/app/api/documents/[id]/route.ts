import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { getDocument } from "@/lib/documents/service";
import { isUuid } from "@/lib/uuid";
import { failure, reply } from "../reply";

// GET: one document's reading and its comparison with the records. Never the bytes.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.documentsEnabled) return reply({ error: "disabled" }, 404);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const document = await getDocument(session, id);
    return document ? reply({ document }, 200) : reply({ error: "not_found" }, 404);
  } catch (err) {
    return failure("view", err);
  }
}
