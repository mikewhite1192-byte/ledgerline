import { NextResponse } from "next/server";
import { z } from "zod";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { writeBrief } from "@/lib/briefs/write";
import { isCrossSite } from "@/lib/http/same-site";
import { isLocalDate } from "@/lib/time/local-date";

// POST { periodStart }: "Write this week's brief". The engine computes the week's figures, the
// model words them, and the words are checked against them before anyone reads them. One brief
// per week: a second press while one is being written, or once one passed, is refused. Off unless
// profitBriefEnabled and aiEnabled are on; writeBrief checks both again. Categories only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.strictObject({ periodStart: z.string().refine(isLocalDate) });

const STATUS: Readonly<Record<string, number>> = {
  disabled: 409,
  ai_disabled: 409,
  not_found: 404,
  open_period: 409,
  exists: 409,
  in_progress: 409,
  no_loads: 409,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The session first, so a caller with none learns nothing about the switches.
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.profitBriefEnabled) return reply({ error: "brief_off" }, 409);
  if (!flags.aiEnabled) return reply({ error: "ai_off" }, 409);
  let periodStart: string;
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return reply({ error: "bad_request" }, 400);
    periodStart = parsed.data.periodStart;
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  try {
    const result = await writeBrief(session, { kind: "profit_week", periodStart });
    if (!result.ok) return reply({ error: result.category }, STATUS[result.category] ?? 409);
    return reply(
      { briefId: result.briefId, status: result.status, ...(result.category ? { category: result.category } : {}) },
      200,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("profit brief failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
