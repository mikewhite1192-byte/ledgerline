import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { asMember, failure, reply } from "@/lib/portal/http";
import { mintSession } from "@/lib/portal/session";

// POST: a person asks to browse the portal themselves. One access code, shown once in this
// response and never stored in clear, plus the sign-in link for the carrier's own tenant.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!flags.portalRunnerEnabled) return reply({ error: "not_found" }, 404);
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  try {
    const out = await asMember(session, async (q) => {
      const accounts = await q.query<{ carrier_number: string }>(
        "SELECT carrier_number FROM portal_accounts WHERE tenant_id = current_tenant_id()",
      );
      if (accounts.length !== 1) return null;
      const minted = await mintSession(q, { runId: null, createdBy: session.sub, now: new Date() });
      return { carrierNumber: accounts[0].carrier_number, code: minted.code, expiresAt: minted.expiresAt };
    });
    if (!out) return reply({ error: "no_portal_account" }, 404);
    return reply({ ...out, signInPath: `/portal?t=${session.tenantId}` }, 200);
  } catch (err) {
    return failure(err, "portal access");
  }
}
