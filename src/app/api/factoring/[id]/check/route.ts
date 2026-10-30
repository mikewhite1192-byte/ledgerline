import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { checkPendingFactoring } from "@/lib/factoring/execute";
import { factoringOn } from "@/lib/factoring/switches";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: "Check pending" on a factoring request's page. Reads back from the factoring partner each
// invoice of this request that was sent but not confirmed yet; never sends anything new, but it
// settles the ledger rows it reads back, so it is staff only: a demo visitor (the judge role) is
// refused before any work. Counts and categories only in the reply. Switched off, the route is
// not there.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const STATUS: Readonly<Record<string, number>> = {
  factoring_off: 404,
  not_found: 404,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here and again inside checkPendingFactoring.
  if (!factoringOn()) return reply({ error: "not_found" }, 404);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "not_found" }, 404);
  try {
    const r = await checkPendingFactoring(session, id.toLowerCase());
    if (!r.ok) return reply({ error: r.category, retryable: r.retryable }, STATUS[r.category] ?? 409);
    return reply({ summary: r.summary, tooNew: r.tooNew, stillWaiting: r.stillWaiting, status: r.status }, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    // The error's name only; its text can echo a row.
    console.error(`factoring check failed: ${err instanceof Error ? err.name : "unknown"}`);
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
