import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/cookie";

// Clears the session cookie and sends the browser to the sign-in page. A relative Location, so
// the redirect never depends on how the host reports its own URL.
export function POST() {
  const response = new NextResponse(null, { status: 303, headers: { Location: "/sign-in" } });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}
