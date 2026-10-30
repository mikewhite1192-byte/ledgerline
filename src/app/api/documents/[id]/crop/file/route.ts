import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { readCropFile } from "@/lib/documents/service";
import { isUuid } from "@/lib/uuid";
import { failure, reply } from "../../../reply";

// GET: the kept crop to the paper, for a later page. Only a cropped photo holds one, so any other
// document answers not found. The same headers as the file route: inline, never cached, never
// sniffed, and a sandbox so the picture opened on its own runs nothing.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.documentsEnabled || !flags.documentCrop) return reply({ error: "disabled" }, 404);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const file = await readCropFile(session, id);
    if (!file) return reply({ error: "not_found" }, 404);
    const body = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": file.mime,
        "content-length": String(file.bytes.byteLength),
        "content-disposition": "inline",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (err) {
    return failure("crop file", err);
  }
}
