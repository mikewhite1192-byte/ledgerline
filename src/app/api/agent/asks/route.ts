import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { readAgentAsks } from "@/lib/agent/gateway/store";
import { getSession } from "@/lib/agent/gateway/session";
import { isCrossSite } from "@/lib/http/same-site";

// GET ?since=<iso>: the agent's questions and told lines showing now for the caller's carrier,
// newest first (at most flags.agentAsks.listLimit), with how many show in all and the server's
// clock for the next poll's since. Reads only, under the caller's own tenant: the store's tenant
// transaction checks the membership first, and row-level security holds the rows to that tenant.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.agentEnabled) return reply({ error: "agent_off" }, 409);
  if (flags.agentAsks.enabled !== true) return reply({ error: "asks_off" }, 409);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const since = new URL(request.url).searchParams.get("since");
  if (since !== null && (!ISO.test(since) || !Number.isFinite(Date.parse(since)))) {
    return reply({ error: "bad_request" }, 400);
  }
  try {
    const read = await readAgentAsks(session, { sinceIso: since === null ? null : new Date(since).toISOString() });
    return reply(read, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("agent asks read failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
