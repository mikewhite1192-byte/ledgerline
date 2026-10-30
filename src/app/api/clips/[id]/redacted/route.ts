import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { storeRedacted } from "@/lib/clips/service";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";
import { failed, readCapped, refuse, reply } from "../../reply";

// PUT: the redacted file from the uploader's browser (body video/mp4). The server checks its size,
// its header against the raw clip's and that its hash differs from the raw file's, then keeps it.
// Staff only: a demo visitor (the judge role) is refused before any work.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  if (!flags.clipsEnabled) return refuse({ ok: false, category: "disabled", retryable: false });
  if ((request.headers.get("content-type") ?? "") !== "video/mp4") return reply({ error: "bad_request" }, 400);
  const bytes = await readCapped(request, flags.clipLimits.bytes);
  if (!bytes) return refuse({ ok: false, category: "too_large", retryable: false });
  try {
    const result = await storeRedacted(session, id, bytes);
    return result.ok ? reply(result, 200) : refuse(result);
  } catch (err) {
    return failed("store", err);
  }
}
