import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { readClip } from "@/lib/clips/service";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";
import { failed, refuse, reply } from "../../reply";

// POST: read the redacted clip's printed values and compare its clocks with the stored stop times.
// A clip already read answers with what was kept; no second model call is made. Staff only: a demo
// visitor (the judge role) is refused before any work.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  if (!flags.clipsEnabled) return refuse({ ok: false, category: "disabled", retryable: false });
  try {
    const result = await readClip(session, id);
    return result.ok ? reply(result, 200) : refuse(result);
  } catch (err) {
    return failed("read", err);
  }
}
