import { NextResponse } from "next/server";
import { z } from "zod";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { writeQuarterReview } from "@/lib/briefs/write-quarter";
import { isCrossSite } from "@/lib/http/same-site";

// POST {}: "Write the quarter review". The engine computes the quarter so far, the long-context
// model words it in four lists, and every number is checked against the figures before anyone reads
// it. One review per quarter: a second press while one is being written, or once one passed, is
// refused. Off unless quarterReviewEnabled and aiEnabled are on; writeQuarterReview checks both
// again. Categories only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// The quarter is always the one holding the carrier's today: nothing to choose.
const Body = z.strictObject({});

const STATUS: Readonly<Record<string, number>> = {
  disabled: 409,
  ai_disabled: 409,
  not_found: 404,
  exists: 409,
  in_progress: 409,
  no_activity: 409,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The session first, so a caller with none learns nothing about the switches.
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  if (!flags.quarterReviewEnabled) return reply({ error: "review_off" }, 409);
  if (!flags.aiEnabled) return reply({ error: "ai_off" }, 409);
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return reply({ error: "bad_request" }, 400);
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  try {
    const result = await writeQuarterReview(session);
    if (!result.ok) return reply({ error: result.category }, STATUS[result.category] ?? 409);
    return reply(
      { briefId: result.briefId, status: result.status, ...(result.category ? { category: result.category } : {}) },
      200,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("quarter review failed:", err instanceof Error ? err.name : "unknown");
    // It may have failed after the model was asked or while the outcome was stored, so the outcome
    // is unknown, never "nothing was sent": the page reads the review back.
    return reply({ error: "unknown" }, 503);
  }
}
