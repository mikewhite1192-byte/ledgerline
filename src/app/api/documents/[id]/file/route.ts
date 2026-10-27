import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { readDocumentFile } from "@/lib/documents/service";
import { isUuid } from "@/lib/uuid";
import { failure, reply } from "../../reply";

// GET: the stored file itself, for the page's preview. Shown inline with the type stored at
// upload (from the allowlist, checked against the bytes), never cached, never sniffed.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.documentsEnabled) return reply({ error: "disabled" }, 404);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const file = await readDocumentFile(session, id);
    if (!file) return reply({ error: "not_found" }, 404);
    const body = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
    const headers: Record<string, string> = {
      "content-type": file.mime,
      "content-length": String(file.bytes.byteLength),
      "content-disposition": "inline",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    // An image opened on its own runs nothing. A PDF keeps the browser's own viewer, which a
    // sandboxing policy would turn off.
    if (file.mime !== "application/pdf") {
      headers["content-security-policy"] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
    }
    return new Response(body, { status: 200, headers });
  } catch (err) {
    return failure("file", err);
  }
}
