import { z } from "zod";
import { requestFromDesk } from "@/lib/advances/desk";
import { refuse, reply } from "@/lib/advances/http";
import { ADVANCE_REQUEST_CATEGORIES, DESK_MAX_CENTS, DESK_MIN_CENTS } from "@/lib/advances/request";
import { advancesOn } from "@/lib/advances/switches";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";

// POST: the request desk. Validates the driver, the amount in integer cents, the reason and an
// optional load of the driver's, then runs one agent turn with the desk's fixed sentence
// (src/lib/advances/desk.ts) and answers with the conversation and turn, which the chat on the
// home page shows. The agent proposes; nothing is paid until a person approves its card.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z.strictObject({
  driverId: z.uuid(),
  amountCents: z.int().min(DESK_MIN_CENTS).max(DESK_MAX_CENTS),
  category: z.enum(ADVANCE_REQUEST_CATEGORIES),
  loadId: z.uuid().optional(),
});

const STATUS: Readonly<Record<string, number>> = { agent_off: 409, ai_off: 409, busy: 409 };

export async function POST(request: Request) {
  if (isCrossSite(request)) return refuse("forbidden");
  if (!advancesOn()) return refuse("disabled");
  const session = await getSession();
  if (!session) return refuse("unauthenticated");
  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return refuse("bad_request");
    body = parsed.data;
  } catch {
    return refuse("bad_request");
  }
  try {
    const result = await requestFromDesk(session, {
      ...body,
      driverId: body.driverId.toLowerCase(),
      loadId: body.loadId === undefined ? null : body.loadId.toLowerCase(),
    });
    if (result.ok) return reply(result, 200);
    return STATUS[result.category] ? reply({ error: result.category }, STATUS[result.category]) : refuse(result.category);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden");
    console.error("advance request failed:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
