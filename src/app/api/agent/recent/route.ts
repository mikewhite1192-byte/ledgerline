import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { readRecentAgentTurns } from "@/lib/agent/gateway/store";
import { getSession } from "@/lib/agent/gateway/session";
import { isCrossSite } from "@/lib/http/same-site";

// GET: the caller's newest conversation (a demo visit's: its own newest), its last turns oldest
// first, so the agent panel resumes the thread after a navigation (design-ui-pass 2). Reads only,
// under the caller's own tenant: the store's tenant transaction checks the membership first, and
// row-level security holds the rows to that tenant. Off unless agentEnabled and agentFocusEnabled
// are both on.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.agentEnabled || !flags.agentFocusEnabled) return reply({ error: "agent_off" }, 409);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  try {
    const turns = await readRecentAgentTurns(session);
    return reply({ conversationId: turns.at(-1)?.conversationId ?? null, turns }, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("agent recent read failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
