import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { executeProposal } from "@/lib/proposals/execute";
import { isUuid } from "@/lib/uuid";

// POST: a person approves a proposal from its card. The gate and the per-kind executor live in
// src/lib/proposals/execute.ts, outside the agent tree. Categories only in the reply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.strictObject({ confirmed: z.boolean().optional() });

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
  let confirmed = false;
  try {
    const text = await request.text();
    const parsed = Body.safeParse(text ? JSON.parse(text) : {});
    if (!parsed.success) return reply({ error: "bad_request" }, 400);
    confirmed = parsed.data.confirmed === true;
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  try {
    const result = await executeProposal(session, id, { confirmed });
    if (result.ok) return reply(result, 200);
    return reply({ error: result.category, retryable: result.retryable }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("proposal approve failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
