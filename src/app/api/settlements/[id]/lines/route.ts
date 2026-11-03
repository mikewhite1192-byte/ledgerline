import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { addNamedLine } from "@/lib/settlements/named-line";
import { isUuid } from "@/lib/uuid";

// POST { kind, sourceRef, amountCents, label? }: a staff member names one reimbursement or deduction
// on a driver's open draft paystub, citing one fuel purchase or lumper of that driver
// (src/lib/settlements/named-line.ts). The amount must equal the record's; the rules engine then
// makes the line and the week is run again. The switch is asked here once the caller is known to be
// staff, so a signed-out caller learns nothing of it, and again by the service. Nothing is paid or
// sent. Categories only.
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

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  if (!flags.namedLines.enabled) return reply({ error: "disabled" }, 404);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  const body = await bodyOf(request);
  if (body === null) return reply({ error: "bad_request" }, 400);
  try {
    const result = await addNamedLine(getDb(), session, id.toLowerCase(), body, new Date());
    if (result.ok) return reply({ ok: true, settlementId: result.settlementId, payItemId: result.payItemId }, 200);
    return reply({ error: result.category }, STATUS[result.category] ?? 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("named line failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
