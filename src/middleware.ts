import { NextResponse, type NextRequest } from "next/server";

// The fictional portal is read only (design 3.1): any method but GET or HEAD is refused, except
// the sign-in form's POST. Only portal paths reach this function.
export function middleware(request: NextRequest) {
  const method = request.method;
  if (method === "GET" || method === "HEAD") return NextResponse.next();
  if (method === "POST" && request.nextUrl.pathname === "/portal/sign-in") return NextResponse.next();
  return new NextResponse(null, { status: 405, headers: { allow: "GET, HEAD" } });
}

export const config = { matcher: ["/portal", "/portal/:path*"] };
