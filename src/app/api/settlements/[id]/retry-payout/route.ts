import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { retryPayout } from "@/lib/settlements/post";
import { isUuid } from "@/lib/uuid";

// POST: "Retry payout" on an approved paystub whose payout failed or never went out. A new attempt
// (at most three in all), refused when the paystub no longer matches its records; a payout in
// flight or unknown is left alone. "Retry booking" (the payout confirmed, the paystub not booked)
// books it and sends nothing. Categories only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const STATUS: Readonly<Record<string, number>> = {
  disabled: 404,
  not_found: 404,
  role: 403,
  forbidden: 403,
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
  try {
    const result = await retryPayout(getDb(), session, id);
    if (result.ok) return reply({ ok: true, state: result.state, moneyActionId: result.moneyActionId }, 200);
    return reply({ error: result.category }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("settlement retry payout failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
