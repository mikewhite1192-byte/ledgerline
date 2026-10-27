import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { listDocuments, uploadDocument } from "@/lib/documents/service";
import { isCrossSite } from "@/lib/http/same-site";
import { failure, REFUSAL_STATUS, reply } from "./reply";

// POST: upload one document (multipart, one field named "file") and read it once with Muse
// Spark. GET: this carrier's latest 50 documents. Both behind flags.documentsEnabled. Replies
// carry categories only; never the bytes, never the uploader.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Room for the multipart framing around the largest file allowed.
const FORM_OVERHEAD_BYTES = 16 * 1024;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.documentsEnabled) return reply({ error: "disabled" }, 404);
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0) return reply({ error: "bad_request" }, 400);
  if (length > flags.documentLimits.maxBytes + FORM_OVERHEAD_BYTES) return reply({ error: "too_large" }, 413);
  let file: File;
  try {
    const form = await request.formData();
    const entries = form.getAll("file");
    if (entries.length !== 1 || typeof entries[0] === "string") return reply({ error: "bad_request" }, 400);
    file = entries[0];
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  if (file.size > flags.documentLimits.maxBytes) return reply({ error: "too_large" }, 413);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const outcome = await uploadDocument(session, { name: file.name, type: file.type, bytes });
    if (!outcome.ok) return reply({ error: outcome.error }, REFUSAL_STATUS[outcome.error] ?? 400);
    const v = outcome.view;
    return reply(
      {
        id: v.id,
        inputId: v.inputId,
        readStatus: v.readStatus,
        kind: v.kind,
        match: v.match,
        duplicate: outcome.duplicate,
      },
      outcome.duplicate ? 200 : 201,
    );
  } catch (err) {
    return failure("upload", err);
  }
}

export async function GET() {
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.documentsEnabled) return reply({ error: "disabled" }, 404);
  try {
    return reply({ documents: await listDocuments(session) }, 200);
  } catch (err) {
    return failure("list", err);
  }
}
