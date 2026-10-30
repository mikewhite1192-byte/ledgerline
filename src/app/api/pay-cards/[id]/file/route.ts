import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { readCardFile } from "@/lib/pay-cards/read";
import { withSessionTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";

// GET: one checked pay card's picture, as a file to save (the clerk sends it from their own
// phone). Only a card whose read-back matched the paystub has a picture at all; any other card,
// or another carrier's, is not found.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

// A plain file name: letters, digits and dashes only.
function fileName(firstName: string, periodStart: string): string {
  const name = firstName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40);
  const week = /^\d{4}-\d{2}-\d{2}$/.test(periodStart) ? periodStart : "week";
  return `pay-card-${name || "driver"}-${week}.png`;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "not_found" }, 404);
  if (!flags.payCardsEnabled) return reply({ error: "not_found" }, 404);
  try {
    const file = await withSessionTenant(session, (q) => readCardFile(q, id));
    if (!file) return reply({ error: "not_found" }, 404);
    return new Response(new Blob([file.bytes.slice().buffer], { type: "image/png" }), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(file.bytes.byteLength),
        "content-disposition": `attachment; filename="${fileName(file.firstName, file.periodStart)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        etag: `"${file.contentHash}"`,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("pay card file failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unknown" }, 503);
  }
}
