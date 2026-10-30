import { NextResponse } from "next/server";
import { z } from "zod";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { checkPayCard, type CheckRefusal } from "@/lib/pay-cards/check";

// POST { settlementId, traceId, image }: check one pay card picture the cards page drew. image is
// the PNG as base64; traceId is the page's run, for the run's spending limit. The server works the
// card's figures out again from the settlement and keeps the picture only when a read-back matches
// every one; nothing is sent anywhere. Staff only: a demo visitor (the judge role) is refused before
// the body is read, since a check spends model cents and keeps a row. Off unless payCardsEnabled
// and aiEnabled are on; the check re-checks both.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// The largest picture as base64, plus room for the rest of the JSON.
const MAX_IMAGE_CHARS = Math.ceil(flags.payCardLimits.maxPngBytes / 3) * 4;
const MAX_BODY_BYTES = MAX_IMAGE_CHARS + 1_024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const Body = z.strictObject({
  settlementId: z.uuid(),
  traceId: z.uuid(),
  image: z.string().min(4).max(MAX_IMAGE_CHARS).regex(BASE64),
});

const STATUS: Readonly<Record<CheckRefusal, number>> = {
  cards_off: 409,
  ai_off: 409,
  not_found: 404,
  not_approved: 409,
  bad_image: 422,
  attempts: 409,
  day_cap: 429,
  batch_cap: 429,
  budget: 409,
  busy: 409,
  already_checked: 409,
  unknown: 503,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

// The body as text, read up to max bytes and no further; null when it is longer or unreadable.
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > max)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.payCardsEnabled) return reply({ error: "cards_off" }, 409);
  if (!flags.aiEnabled) return reply({ error: "ai_off" }, 409);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;

  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply({ error: "bad_image" }, 413);
  let input: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(JSON.parse(text));
    if (!parsed.success) return reply({ error: "bad_request" }, 400);
    input = parsed.data;
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  const png = Uint8Array.from(Buffer.from(input.image, "base64"));
  // Strict base64 only: what decodes must encode back to exactly what was sent.
  if (Buffer.from(png).toString("base64") !== input.image) return reply({ error: "bad_image" }, 422);

  try {
    const result = await checkPayCard(session, { settlementId: input.settlementId, traceId: input.traceId, png });
    if (!result.ok) return reply({ error: result.category }, STATUS[result.category] ?? 409);
    return reply(
      { cardId: result.cardId, attempt: result.attempt, status: result.status, category: result.category },
      200,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("pay card check failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unknown" }, 503);
  }
}
