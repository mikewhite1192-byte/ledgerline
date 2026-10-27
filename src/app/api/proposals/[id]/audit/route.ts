import { NextResponse } from "next/server";
import { runAudit } from "@/lib/agent/auditor/run";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: the card asks the auditor to check a proposal (design 4.2). One Muse Wonder call per
// proposal at most; a stored verdict is read back. Categories only in the reply; the raw error
// goes to the server log as its name only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Readonly<Record<string, number>> = {
  done: 200,
  in_progress: 202,
  disabled: 404,
  not_found: 404,
  not_auditable: 409,
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
    const result = await runAudit(session, id);
    if (result.state === "done") return reply(result, 200);
    const status = STATUS[result.state] ?? 409;
    return status >= 400 ? reply({ error: result.state }, status) : reply(result, status);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("proposal audit failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
