import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { asMember, failure, reply } from "@/lib/portal/http";
import { stepScreenshot } from "@/lib/portal/views";
import { isUuid } from "@/lib/uuid";

// GET: one step's screenshot, the only image in the response.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; seq: string }> }) {
  if (!flags.portalRunnerEnabled) return reply({ error: "not_found" }, 404);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id, seq } = await params;
  if (!isUuid(id) || !/^[0-9]{1,3}$/.test(seq)) return reply({ error: "bad_request" }, 400);
  try {
    const shot = await asMember(session, (q) => stepScreenshot(q, id, Number(seq)));
    if (!shot) return reply({ error: "not_found" }, 404);
    return new NextResponse(Buffer.from(shot.bytes), {
      status: 200,
      headers: { "content-type": shot.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  } catch (err) {
    return failure(err, "portal screenshot read");
  }
}
