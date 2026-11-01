import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { markStubSent } from "@/lib/settlements/stub-sent";
import { isUuid } from "@/lib/uuid";

// POST, no body: a staff member records that they sent a driver's paid paystub to the driver
// (src/lib/settlements/stub-sent.ts). The app sends nothing; this only records a person's send. A
// second press finds the mark and writes nothing (already: true). The switch is asked here once
// the caller is known to be staff, so a signed-out caller learns nothing of it, and again by the
// service. Categories only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const STATUS: Readonly<Record<string, number>> = {
  disabled: 404,
  not_found: 404,
  bad_request: 400,
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
  if (!flags.stubSent.enabled) return reply({ error: "disabled" }, 404);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const result = await markStubSent(getDb(), session, id.toLowerCase(), new Date());
    if (result.ok) return reply({ ok: true, already: result.already, sentAt: result.sentAt }, 200);
    return reply({ error: result.category }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("stub sent mark failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
