import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/cookie";

// Clears the session cookie and sends the browser to the sign-in page. A relative Location, so
// the redirect never depends on how the host reports its own URL.
//
// A cross-site POST is refused with no cookie change: the response clears the cookie even when
// the browser did not send it, so any other site could sign a user out with a form. The browser
// sets Sec-Fetch-Site itself, so the check holds behind CloudFront, where Origin may not match the
// URL the app sees. A request without the header is handled as before.
export function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return new NextResponse(null, { status: 403 });
  const response = new NextResponse(null, { status: 303, headers: { Location: "/sign-in" } });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}
