import { NextResponse } from "next/server";
import { flags } from "../../config/flags";
import { ADVANCE_STATUS } from "../advances/http";
import type { Session } from "../auth/claims";
import { getSession } from "../auth/session";
import { isCrossSite } from "../http/same-site";
import { isUuid } from "../uuid";

// The voice note routes' shared shape: same-site POST, the voice switch first, a signed-in member,
// a well-formed id, categories only in the reply (never upstream text), never cached.

export const voiceOn = () => flags.voiceIntakeEnabled === true;

export const VOICE_STATUS: Readonly<Record<string, number>> = {
  ...ADVANCE_STATUS,
  too_large: 413,
  bad_wav: 400,
  bad_audio: 400,
  too_long: 400,
  limit: 429,
};

export function voiceReply(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function voiceRefuse(category: string, retryable = false, voiceNoteId?: string): NextResponse {
  const body = voiceNoteId ? { error: category, retryable, voiceNoteId } : { error: category, retryable };
  return voiceReply(body, VOICE_STATUS[category] ?? 409);
}

type Outcome = { ok: true } | { ok: false; category: string; retryable: boolean; voiceNoteId?: string };

export function answer(result: Outcome): NextResponse {
  if (result.ok) return voiceReply(result, 200);
  return voiceRefuse(result.category, result.retryable, result.voiceNoteId);
}

export function failed(err: unknown, what: string): NextResponse {
  if (err instanceof Error && err.name === "ForbiddenError") return voiceRefuse("forbidden");
  console.error("voice note step failed:", what, err instanceof Error ? err.name : "unknown");
  return voiceRefuse("unavailable", true);
}

// One button press on a voice note's page: run it and answer with its category.
export async function voiceAction<T extends Outcome>(
  request: Request,
  params: Promise<{ id: string }>,
  what: string,
  run: (session: Session, voiceNoteId: string) => Promise<T>,
): Promise<NextResponse> {
  if (isCrossSite(request)) return voiceRefuse("forbidden");
  if (!voiceOn()) return voiceRefuse("disabled");
  const session = await getSession();
  if (!session) return voiceRefuse("unauthenticated");
  const { id } = await params;
  if (!isUuid(id)) return voiceRefuse("bad_request");
  try {
    return answer(await run(session, id.toLowerCase()));
  } catch (err) {
    return failed(err, what);
  }
}
