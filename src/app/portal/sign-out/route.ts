import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { PORTAL_COOKIE } from "@/lib/portal/runner/driver";
import { portalCookieOptions } from "@/lib/portal/session";

// GET: leaves the portal. The portal takes no other method but sign-in, and signing out of a
// made-up portal is harmless, so a plain link does it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  if (!flags.portalRunnerEnabled) return new NextResponse(null, { status: 404 });
  const response = new NextResponse(null, { status: 303, headers: { Location: "/portal", "cache-control": "no-store" } });
  response.cookies.set(PORTAL_COOKIE, "", { ...portalCookieOptions(), maxAge: 0 });
  return response;
}
