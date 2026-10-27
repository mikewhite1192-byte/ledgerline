import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { parseApproveBody } from "@/lib/proposals/approve-body";
import { executeProposal, type ApproveOptions } from "@/lib/proposals/execute";
import { isUuid } from "@/lib/uuid";

// POST: a person approves a proposal from its card. The gate and the per-kind executor live in
// src/lib/proposals/execute.ts, outside the agent tree. The body is { confirmed?, overrideReason?,
// auditedAt? } (./approve-body.ts); the reason is never logged. Categories only in the reply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  role: 403,
  forbidden: 403,
  disabled: 403,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  let opts: ApproveOptions | null;
  try {
    opts = parseApproveBody(await request.text());
  } catch {
    opts = null;
  }
  if (!opts) return reply({ error: "bad_request" }, 400);
  try {
    const result = await executeProposal(session, id, opts);
    if (result.ok) return reply(result, 200);
    return reply({ error: result.category, retryable: result.retryable }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("proposal approve failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
