import { NextResponse } from "next/server";
import { z } from "zod";
import { flags } from "@/config/flags";
import { openAgentTurn, dbTurnStore } from "@/lib/agent/gateway/store";
import { LOOP_TEXT } from "@/lib/agent/policy";
import { encodeEvent } from "@/lib/agent/operator/stream";
import { defaultTurnDeps, runTurn } from "@/lib/agent/operator/turn";
import type { TurnEvent, TurnStatus } from "@/lib/agent/view";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";

// POST: one operator turn (design 2.2). The turn row is written, running, before any model call;
// the steps stream back as server-sent events; the chat then reads the finished turn from
// /api/agent/turns/:id, which is also the poll fallback. The client makes the turn id, so it can
// poll even when the stream is buffered. Off unless both agentEnabled and aiEnabled are on.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.strictObject({
  conversationId: z.uuid().optional(),
  turnId: z.uuid(),
  text: z.string().trim().min(1).max(2000),
});

const REFUSED = { not_found: 404, busy: 409, duplicate: 409 } as const;

function refuse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return refuse("forbidden", 403);
  if (!flags.agentEnabled) return refuse("agent_off", 409);
  if (!flags.aiEnabled) return refuse("ai_off", 409);
  const session = await getSession();
  if (!session) return refuse("unauthenticated", 401);

  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return refuse("bad_request", 400);
    body = parsed.data;
  } catch {
    return refuse("bad_request", 400);
  }

  const startedAt = Date.now();
  let opened;
  try {
    opened = await openAgentTurn(session, {
      conversationId: body.conversationId ?? null,
      turnId: body.turnId,
      text: body.text,
      now: new Date(startedAt),
      summaryChars: flags.agentTurnLimits.summaryChars,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden", 403);
    console.error("agent turn could not start:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", 503);
  }
  if ("refused" in opened) return refuse(opened.refused, REFUSED[opened.refused]);
  const turn = opened;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The turn carries on when the browser goes away; the poll route reads it back.
      const send = (e: TurnEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeEvent(e)));
        } catch {
          // the client is gone
        }
      };
      send({ event: "start", data: { turnId: turn.turnId, conversationId: turn.conversationId } });
      let status: TurnStatus = "failed";
      try {
        const outcome = await runTurn(
          { session, turn, text: body.text, startedAt },
          defaultTurnDeps(session, send),
        );
        status = outcome.status;
      } catch (err) {
        console.error("agent turn failed:", err instanceof Error ? err.name : "unknown");
        try {
          await dbTurnStore(session).finishTurn(turn.turnId, {
            status: "failed",
            endedReason: "store",
            text: LOOP_TEXT.failed,
            summary: "",
            stepCount: 0,
            modelCallCount: 0,
            costNanocents: 0,
          });
        } catch {
          console.error("agent turn could not be closed");
        }
      }
      send({ event: "done", data: { turnId: turn.turnId, status } });
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
