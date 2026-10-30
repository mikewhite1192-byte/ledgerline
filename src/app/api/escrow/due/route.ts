import { refuse, reply } from "@/lib/advances/http";
import { getSession } from "@/lib/auth/session";
import { listReleasesDue } from "@/lib/escrow/due";
import { escrowReleaseOn } from "@/lib/escrow/switches";
import { isCrossSite } from "@/lib/http/same-site";
import { readTenantZone } from "@/lib/money/read";
import { withSessionTenant } from "@/lib/tenant/context";
import { localDateOf } from "@/lib/time/local-date";

// GET: the drivers due for an escrow release (terminated at least ninety days ago on the
// carrier's local dates, a balance above zero, no release started), oldest first, at most 50. A
// read only: nothing is emailed, texted or sent, and nothing is proposed. Behind the escrow
// release switch, checked before the login; categories only in a refusal, never cached.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(request: Request) {
  if (isCrossSite(request)) return refuse("forbidden");
  if (!escrowReleaseOn()) return refuse("disabled");
  const session = await getSession();
  if (!session) return refuse("unauthenticated");
  const nowIso = new Date().toISOString();
  try {
    const due = await withSessionTenant(session, async (q) =>
      listReleasesDue(q, localDateOf(nowIso, await readTenantZone(q))),
    );
    return reply({ ok: true, ...due }, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden");
    console.error("escrow releases due could not be read:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
