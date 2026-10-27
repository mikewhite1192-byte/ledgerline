import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { readRedactedFile } from "@/lib/clips/service";
import { isUuid } from "@/lib/uuid";
import { failed, isForeignRead, refuse, reply } from "../../reply";

// GET: the redacted file, the only video kept. There is no route for the raw file: it was never
// stored.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isForeignRead(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  if (!flags.clipsEnabled) return refuse({ ok: false, category: "disabled", retryable: false });
  try {
    const result = await readRedactedFile(session, id);
    if (!result.ok) return refuse(result);
    return new Response(new Blob([result.bytes.slice().buffer], { type: "video/mp4" }), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(result.bytes.byteLength),
        "content-disposition": "inline",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    return failed("file", err);
  }
}
