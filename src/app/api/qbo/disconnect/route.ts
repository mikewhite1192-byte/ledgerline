import { NextResponse } from "next/server";
import { createQboConnect } from "@/lib/adapters/accounting/qbo/connect";
import { requireSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { DbError } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";
import { tenantRun, toSettings } from "../respond";

export const dynamic = "force-dynamic";

const qbo = createQboConnect();

// An admin disconnects. Only a post from this app's own page is handled: the browser sets
// Sec-Fetch-Site itself, and anything but "same-origin" (another site, a sibling subdomain, or
// no header at all, as an older browser sends) is refused before anything changes.
export async function POST(request: Request) {
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    return new NextResponse(null, { status: 403 });
  }
  const session = await requireSession();
  const notStaff = await staffGate(session);
  if (notStaff) return toSettings(notStaff.status === 403 ? "forbidden" : "failed");
  try {
    const result = await qbo.disconnect(tenantRun(session), session.sub);
    return toSettings(result.ok ? "disconnected" : result.reason);
  } catch (err) {
    if (err instanceof ForbiddenError) return toSettings("forbidden");
    if (err instanceof DbError) return toSettings("failed");
    throw err;
  }
}
