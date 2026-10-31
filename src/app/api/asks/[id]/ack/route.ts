import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { ackForSession } from "@/lib/asks/session";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: "Got it" on one of the agent's told lines (the autopilot did something inside the owner's
// limits). The line is done and shows no more. Staff only, under the caller's own tenant;
// row-level security holds the line to it. The body is empty, or an empty JSON object. Nothing is
// approved, undone or moved.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_MAX = 16;

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function emptyBody(request: Request): Promise<boolean> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) >= 0 && Number(declared) <= BODY_MAX)) return false;
  try {
    const text = await request.text();
    if (text.length > BODY_MAX) return false;
    if (text.trim() === "") return true;
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
  } catch {
    return false;
  }
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
  if (!(await emptyBody(request))) return reply({ error: "bad_request" }, 400);
  try {
    if (!(await ackForSession(session, id))) return reply({ error: "not_found" }, 404);
    return reply({ ok: true }, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("told line ack failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
