import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { runPayPeriod } from "@/lib/settlements/run";
import { isUuid } from "@/lib/uuid";

// POST { periodId }: "Run the week". Writes or refreshes each driver's draft paystub and its card;
// nothing is sent. Categories only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const STATUS: Readonly<Record<string, number>> = {
  disabled: 404,
  not_found: 404,
  not_open: 409,
  before_start: 409,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function periodIdOf(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const keys = Object.keys(body);
    const id = (body as Record<string, unknown>).periodId;
    return keys.length === 1 && typeof id === "string" && isUuid(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const periodId = await periodIdOf(request);
  if (!periodId) return reply({ error: "bad_request" }, 400);
  try {
    const result = await runPayPeriod(getDb(), session, periodId, new Date());
    if (result.ok) return reply({ ok: true, periodId: result.periodId, counts: result.counts }, 200);
    return reply({ error: result.category }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("settlements run failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
