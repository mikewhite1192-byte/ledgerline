import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { REJECT_CATEGORIES, rejectProposal } from "@/lib/proposals/reject";
import { isUuid } from "@/lib/uuid";

// POST: a person rejects a proposal. Never touches the ledger.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.strictObject({ category: z.enum(REJECT_CATEGORIES).optional() });

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
  let category: (typeof REJECT_CATEGORIES)[number] = "other";
  try {
    const text = await request.text();
    const parsed = Body.safeParse(text ? JSON.parse(text) : {});
    if (!parsed.success) return reply({ error: "bad_request" }, 400);
    category = parsed.data.category ?? "other";
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  try {
    const result = await rejectProposal(session, id, category);
    if (result.ok) return reply({ ok: true, status: "rejected" }, 200);
    return reply({ error: result.category }, result.category === "not_found" ? 404 : 409);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("proposal reject failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
