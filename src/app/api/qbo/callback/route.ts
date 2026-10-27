import { createQboConnect } from "@/lib/adapters/accounting/qbo/connect";
import { requireSession } from "@/lib/auth/session";
import { DbError } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";
import { tenantRun, toSettings } from "../respond";

export const dynamic = "force-dynamic";

const qbo = createQboConnect();

// Intuit sends the person back here (a cross-site navigation, so no Sec-Fetch-Site check; the
// single-use state tied to their membership is the check). Signed out: to /sign-in.
export async function GET(request: Request) {
  const session = await requireSession();
  const params = new URL(request.url).searchParams;
  try {
    const result = await qbo.finish(tenantRun(session), session.sub, {
      code: params.get("code"),
      state: params.get("state"),
      realmId: params.get("realmId"),
      error: params.get("error"),
    });
    return toSettings(result.ok ? "connected" : result.reason);
  } catch (err) {
    if (err instanceof ForbiddenError) return toSettings("forbidden");
    if (err instanceof DbError) return toSettings("failed");
    throw err;
  }
}
