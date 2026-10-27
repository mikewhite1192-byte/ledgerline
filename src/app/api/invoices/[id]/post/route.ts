import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { postInvoice } from "@/lib/invoices/post";
import { isUuid } from "@/lib/uuid";

// POST: "Post to QuickBooks" on an invoice's record page. The same money action and ledger key as
// the invoice_post executor, so a second click replays the first attempt. Categories only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Readonly<Record<string, number>> = {
  validation: 400,
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
    const result = await postInvoice(getDb(), session, id);
    if (result.ok) return reply({ ok: true, state: result.state, moneyActionId: result.moneyActionId }, 200);
    return reply({ error: result.category }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("invoice post failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
