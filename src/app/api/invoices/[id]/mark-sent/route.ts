import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { markSent } from "@/lib/invoices/review";
import { isUuid } from "@/lib/uuid";

// POST: "Mark as sent" on an invoice's record page. Records the date a person sent the invoice
// from the accounting system (or by hand), once. Nothing is sent from here. Body: { sentOn }.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Readonly<Record<string, number>> = {
  validation: 400,
  disabled: 404,
  not_found: 404,
  forbidden: 403,
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
  // A strict body: an object with no key but "sentOn".
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => k !== "sentOn")
  ) {
    return reply({ error: "validation" }, 400);
  }
  try {
    const result = await markSent(getDb(), session, id, (body as { sentOn?: unknown }).sentOn, new Date());
    if (result.ok) return reply({ ok: true, changed: result.changed }, 200);
    return reply({ error: result.category }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("invoice mark sent failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
