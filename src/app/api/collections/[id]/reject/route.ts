import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { rejectReminder } from "@/lib/collections/decide";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: a person rejects a drafted reminder. It is kept as rejected and never sent. With
// collectionsEnabled off the route answers 404 before reading anything.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

const STATUS = {
  disabled: 404,
  not_found: 404,
  not_approvable: 409,
  already_decided: 409,
  paid_since: 409,
  changed: 409,
} as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.collectionsEnabled) return reply({ error: "not_found" }, 404);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const result = await rejectReminder(session, id);
    if (!result.ok) return reply({ error: result.category === "disabled" ? "not_found" : result.category }, STATUS[result.category]);
    return reply(result, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("collections reject failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
