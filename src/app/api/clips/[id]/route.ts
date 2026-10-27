import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { getClip } from "@/lib/clips/service";
import { isUuid } from "@/lib/uuid";
import { failed, isForeignRead, refuse, reply } from "../reply";

// GET: one clip and, once both segmentation answers are kept, its redaction plan (boxes only).
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
    const result = await getClip(session, id);
    return result.ok ? reply(result, 200) : refuse(result);
  } catch (err) {
    return failed("get", err);
  }
}
