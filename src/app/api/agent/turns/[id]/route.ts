import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { readAgentTurn } from "@/lib/agent/gateway/store";
import { getSession } from "@/lib/agent/gateway/session";
import { isUuid } from "@/lib/uuid";

// GET: a turn as the chat shows it (steps, answer, cards, flags). The poll fallback while a turn
// runs, and the read after its stream ends. Only the person who started the conversation.
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
    const turn = await readAgentTurn(session, id);
    return turn ? reply({ turn }, 200) : reply({ error: "not_found" }, 404);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("agent turn read failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
