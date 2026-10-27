import { NextResponse } from "next/server";
import { createQboConnect } from "@/lib/adapters/accounting/qbo/connect";
import { requireSession } from "@/lib/auth/session";
import { DbError } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";
import { tenantRun, toSettings } from "../respond";

export const dynamic = "force-dynamic";

const qbo = createQboConnect();

// An admin disconnects. A cross-site or same-site post is refused before anything changes (the
// browser sets Sec-Fetch-Site itself); a request without the header is handled.
export async function POST(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return new NextResponse(null, { status: 403 });
  const session = await requireSession();
  try {
    const result = await qbo.disconnect(tenantRun(session), session.sub);
    return toSettings(result.ok ? "disconnected" : result.reason);
  } catch (err) {
    if (err instanceof ForbiddenError) return toSettings("forbidden");
    if (err instanceof DbError) return toSettings("failed");
    throw err;
  }
}
