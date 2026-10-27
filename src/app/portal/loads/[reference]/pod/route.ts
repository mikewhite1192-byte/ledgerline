import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { portalPod, REFERENCE } from "@/lib/portal/read";
import { PORTAL_COOKIE } from "@/lib/portal/runner/driver";
import { withPortalTenant } from "@/lib/portal/tenant";

// GET: the signed POD as a file download, for the session's own tenant only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ reference: string }> }) {
  if (!flags.portalRunnerEnabled) return new NextResponse(null, { status: 404 });
  const { reference } = await params;
  if (!REFERENCE.test(reference)) return new NextResponse("No load found", { status: 404 });
  const cookie = (await cookies()).get(PORTAL_COOKIE)?.value;
  try {
    const bytes = await withPortalTenant(cookie, new Date(), (q) => portalPod(q, reference));
    if (!bytes) return new NextResponse("No load found", { status: 404 });
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="pod-${reference}.pdf"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    console.error("portal pod read failed:", err instanceof Error ? err.name : "unknown");
    return new NextResponse(null, { status: 503 });
  }
}
