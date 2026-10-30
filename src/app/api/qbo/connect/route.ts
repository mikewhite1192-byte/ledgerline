import { NextResponse } from "next/server";
import { createQboConnect } from "@/lib/adapters/accounting/qbo/connect";
import { requireSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { DbError } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";
import { tenantRun, toSettings } from "../respond";

export const dynamic = "force-dynamic";

const qbo = createQboConnect();

// An admin starts connecting this carrier to the QuickBooks sandbox company: a single-use state,
// then Intuit's consent page. The browser sets Sec-Fetch-Site itself: the settings page's link
// sends "same-origin" and a typed or bookmarked address sends "none", and only those two are
// handled. A link from another site or a sibling subdomain, or a request with no header at all
// (an older browser), is refused before a state is written.
export async function GET(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site !== "same-origin" && site !== "none") return new NextResponse(null, { status: 403 });
  const session = await requireSession();
  const notStaff = await staffGate(session);
  if (notStaff) return toSettings(notStaff.status === 403 ? "forbidden" : "failed");
  try {
    const result = await qbo.start(tenantRun(session), session.sub);
    if (!result.ok) return toSettings(result.reason);
    return new NextResponse(null, { status: 302, headers: { Location: result.url } });
  } catch (err) {
    if (err instanceof ForbiddenError) return toSettings("forbidden");
    if (err instanceof DbError) return toSettings("failed");
    throw err;
  }
}
