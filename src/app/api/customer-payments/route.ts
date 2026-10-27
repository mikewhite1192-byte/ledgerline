import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { recordCustomerPayment } from "@/lib/invoices/payments";

// POST: record one customer payment and its applications from the form. The reference is unique
// per carrier, so the same form sent twice is one payment. Categories only in the reply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A payment with twenty applications is well under this; anything bigger is not a form.
const MAX_BODY = 16_384;

const STATUS: Readonly<Record<string, number>> = {
  disabled: 404,
  not_found: 404,
  forbidden: 403,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length === 0 || text.length > MAX_BODY) return reply({ error: "bad_request" }, 400);
    body = JSON.parse(text);
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  try {
    const result = await recordCustomerPayment(getDb(), session, body, new Date());
    if (!result.ok) return reply({ error: result.category }, STATUS[result.category] ?? 409);
    return reply(
      { ok: true, created: result.created, paymentId: result.paymentId, posting: result.posting },
      result.created ? 201 : 200,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("customer payment failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
