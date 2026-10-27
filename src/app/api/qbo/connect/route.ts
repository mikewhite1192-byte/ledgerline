import { NextResponse } from "next/server";
import { createQboConnect } from "@/lib/adapters/accounting/qbo/connect";
import { requireSession } from "@/lib/auth/session";
import { DbError } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";
import { tenantRun, toSettings } from "../respond";

export const dynamic = "force-dynamic";

const qbo = createQboConnect();

// An admin starts connecting this carrier to the QuickBooks sandbox company: a single-use state,
// then Intuit's consent page. A link from another site is refused (the browser sets
// Sec-Fetch-Site itself); a typed or bookmarked address sends "none" and is allowed.
export async function GET(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return new NextResponse(null, { status: 403 });
  const session = await requireSession();
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
