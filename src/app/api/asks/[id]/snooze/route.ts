import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { snoozeForSession } from "@/lib/asks/session";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: "Not now" on one of the agent's questions. It comes back at the carrier's next 09:00
// local time, or in 4 hours if that is sooner (src/lib/asks/snooze.ts). Staff only, under the
// caller's own tenant; row-level security holds the ask to it. Nothing is approved or moved.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (flags.agentAsks.enabled !== true) return reply({ error: "asks_off" }, 409);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const snoozed = await snoozeForSession(session, id);
    if (!snoozed) return reply({ error: "not_found" }, 404);
    return reply({ ok: true, snoozedUntil: snoozed.snoozedUntil }, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("ask snooze failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
