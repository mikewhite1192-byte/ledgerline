import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { PORTAL_COOKIE } from "@/lib/portal/runner/driver";
import { cookieValue, portalCookieOptions, signIn } from "@/lib/portal/session";
import { isUuid } from "@/lib/uuid";

// POST: the portal's sign-in form. Every miss sends the browser back to the form with one
// message. Relative redirects, so nothing depends on how the host reports its own URL.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function back(tenantId: string | null) {
  const to = tenantId ? `/portal?t=${tenantId}&e=1` : "/portal?e=1";
  return new NextResponse(null, { status: 303, headers: { Location: to, "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!flags.portalRunnerEnabled) return new NextResponse(null, { status: 404 });
  if (isCrossSite(request)) return new NextResponse(null, { status: 403 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back(null);
  }
  const t = form.get("t");
  const tenantId = typeof t === "string" && isUuid(t) ? t : null;
  if (!tenantId) return back(null);
  try {
    const sessionId = await getDb().withTenant(tenantId, (q) =>
      signIn(q, { carrierNumber: String(form.get("carrierNumber") ?? ""), code: String(form.get("code") ?? ""), now: new Date() }),
    );
    if (!sessionId) return back(tenantId);
    const response = new NextResponse(null, { status: 303, headers: { Location: "/portal/loads", "cache-control": "no-store" } });
    response.cookies.set(PORTAL_COOKIE, cookieValue(tenantId, sessionId), portalCookieOptions());
    return response;
  } catch (err) {
    console.error("portal sign-in failed:", err instanceof Error ? err.name : "unknown");
    return back(tenantId);
  }
}
