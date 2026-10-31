import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { staffMove } from "@/lib/loads/movement";
import { isUuid } from "@/lib/uuid";

// POST: "Mark picked up" and "Mark delivered" on a load's record page. A person's press moves the
// load one step (planned to in transit, in transit to delivered) and records one load_events row
// with source staff, under the same status guard and CHECKs as any move. No money moves and
// nothing is sent. Body: { to: "in_transit" | "delivered" }.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Readonly<Record<string, number>> = {
  validation: 400,
  not_found: 404,
  wrong_status: 409,
  date_out_of_window: 409,
  no_driver: 409,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ error: "validation" }, 400);
  }
  // A strict body: an object with no key but "to".
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => k !== "to")
  ) {
    return reply({ error: "validation" }, 400);
  }
  try {
    const result = await staffMove(getDb(), session, id, (body as { to?: unknown }).to, new Date());
    if (result.ok) return reply({ ok: true, changed: result.changed, to: result.to }, 200);
    return reply({ error: result.category }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("load move failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
