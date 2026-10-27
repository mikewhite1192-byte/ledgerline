import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { confirmBatch, parseBatchRequest } from "@/lib/settlements/batch";

// POST { periodId, proposalIds, totalCents }: "Approve all clean" for one pay week, over the exact
// list and total the person confirmed. 409 'stale' carries the clean list as it stands now, so the
// sheet can show it again. Nothing is sent here: the page then calls the drain. Categories only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const STATUS: Readonly<Record<string, number>> = {
  disabled: 404,
  validation: 400,
  role: 403,
  forbidden: 403,
  stale: 409,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.settlementsEnabled || !flags.batchApproveEnabled) return reply({ error: "disabled" }, 404);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  const req = parseBatchRequest(body);
  if (!req) return reply({ error: "bad_request" }, 400);
  try {
    const result = await confirmBatch(getDb(), session, req, new Date());
    if (result.ok) {
      return reply(
        {
          ok: true,
          batchId: result.batchId,
          itemCount: result.itemCount,
          totalCents: result.totalCents,
          legsReserved: result.legsReserved,
          status: result.status,
        },
        200,
      );
    }
    if (result.category === "stale") return reply({ error: "stale", current: result.current }, 409);
    return reply({ error: result.category }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("batch confirm failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
