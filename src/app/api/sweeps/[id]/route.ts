import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { readSweepPage } from "@/lib/sweep/view";
import { isUuid } from "@/lib/uuid";
import { failed, refused, reply } from "../reply";

// GET: a sweep run as its page shows it (counts, items, the drafted cards, the clean list and
// total the "Approve all clean" button would send). Read-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!flags.sweepEnabled) return refused("disabled");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return refused("bad_request");
  try {
    const page = await readSweepPage(session, id);
    return page ? reply(page, 200) : refused("not_found");
  } catch (err) {
    return failed("sweep read", err);
  }
}
