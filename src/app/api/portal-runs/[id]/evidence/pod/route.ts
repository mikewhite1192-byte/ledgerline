import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { asMember, failure, reply } from "@/lib/portal/http";
import { evidencePod } from "@/lib/portal/views";
import { isUuid } from "@/lib/uuid";

// GET: the POD a run downloaded, as a file.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!flags.portalRunnerEnabled) return reply({ error: "not_found" }, 404);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const bytes = await asMember(session, (q) => evidencePod(q, id));
    if (!bytes) return reply({ error: "not_found" }, 404);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="pod-${id}.pdf"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    return failure(err, "portal pod read");
  }
}
