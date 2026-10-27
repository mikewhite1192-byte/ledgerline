import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { drainBatch } from "@/lib/settlements/drain";
import { isUuid } from "@/lib/uuid";

// POST: send what a confirmed batch reserved, within this request's budget. The page calls it
// again while the batch is still draining. Categories and counts only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const STATUS: Readonly<Record<string, number>> = {
  disabled: 404,
  not_found: 404,
  forbidden: 403,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedMs = Date.now();
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.settlementsEnabled || !flags.batchApproveEnabled) return reply({ error: "disabled" }, 404);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const result = await drainBatch(getDb(), session, id.toLowerCase(), startedMs + flags.batchLimits.drainBudgetMs);
    if (!result.ok) return reply({ error: result.category }, STATUS[result.category] ?? 409);
    const { ok: _ok, ...rest } = result;
    void _ok;
    return reply({ ok: true, ...rest }, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("batch drain failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
