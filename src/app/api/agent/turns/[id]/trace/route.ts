import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { readAgentTurnTrace } from "@/lib/agent/gateway/store";
import { getSession } from "@/lib/auth/session";
import { isUuid } from "@/lib/uuid";

// GET: how a turn was worked out (the model calls, gateway decisions and proposal checks behind
// it), for the disclosure under an answer or a card. Read-only. Only the person who started the
// conversation, as with the turn itself.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!flags.agentEnabled) return reply({ error: "agent_off" }, 409);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const trace = await readAgentTurnTrace(session, id);
    return trace ? reply({ trace }, 200) : reply({ error: "not_found" }, 404);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("agent trace read failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
