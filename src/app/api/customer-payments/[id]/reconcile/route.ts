import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { reconcileCustomerPayment } from "@/lib/invoices/payments";
import { isUuid } from "@/lib/uuid";

// POST: "Check QuickBooks" on a payment's record page. Reads back this payment's unsettled posts
// only; never sends anything new. Counts and categories only in the reply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Readonly<Record<string, number>> = {
  validation: 400,
  disabled: 404,
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
  try {
    const result = await reconcileCustomerPayment(getDb(), session, id);
    if (result.ok) return reply({ ok: true, summary: result.summary }, 200);
    return reply({ error: result.category }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("customer payment read-back failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
