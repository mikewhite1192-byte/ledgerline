import { NextResponse } from "next/server";
import { z } from "zod";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { draftDriverNotes } from "@/lib/driver-notes/draft";
import { isCrossSite } from "@/lib/http/same-site";

// POST { periodId }: draft the period's driver notes, one slice at a time. A slice starts notes
// for up to 20 seconds and replies with the period's counts; the page calls again while more is
// true. A second click drafts only the settlements with no note yet (UNIQUE per settlement).
// Off unless both driverNotesEnabled and aiEnabled are on; the drafting code checks both again.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const SLICE_MS = 20_000;
const Body = z.strictObject({ periodId: z.uuid() });

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.driverNotesEnabled) return reply({ error: "notes_off" }, 409);
  if (!flags.aiEnabled) return reply({ error: "ai_off" }, 409);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  let periodId: string;
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return reply({ error: "bad_request" }, 400);
    periodId = parsed.data.periodId;
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  try {
    const result = await draftDriverNotes(session, periodId, new Date(Date.now() + SLICE_MS));
    if (!result.ok) {
      const status = result.category === "not_found" ? 404 : 409;
      return reply({ error: result.category }, status);
    }
    return reply(result, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("driver notes draft failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
