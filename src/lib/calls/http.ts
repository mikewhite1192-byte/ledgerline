import { NextResponse } from "next/server";
import { flags } from "../../config/flags";
import { ADVANCE_STATUS } from "../advances/http";

// The phone line routes' shared shape, as the voice note routes have it: same-site POST, the
// phone line switch first, a signed-in staff member, a well-formed id, categories only in the
// reply (never upstream text), never cached.

export const phoneOn = () => flags.phoneLineEnabled === true;

export const CALL_STATUS: Readonly<Record<string, number>> = {
  ...ADVANCE_STATUS,
  too_large: 413,
  ai_off: 403,
  agent_off: 403,
  limit: 429,
  rate_limited: 429,
  not_open: 409,
  conflict: 409,
  busy: 409,
  not_ready: 409,
  timeout: 503,
  out_of_time: 503,
};

export function callReply(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function callRefuse(category: string, retryable = false): NextResponse {
  return callReply({ error: category, retryable }, CALL_STATUS[category] ?? 409);
}

type Outcome = { ok: true } | { ok: false; category: string; retryable: boolean };

export function callAnswer(result: Outcome): NextResponse {
  if (result.ok) return callReply(result, 200);
  return callRefuse(result.category, result.retryable);
}

export function callFailed(err: unknown, what: string): NextResponse {
  if (err instanceof Error && err.name === "ForbiddenError") return callRefuse("forbidden");
  console.error("phone line step failed:", what, err instanceof Error ? err.name : "unknown");
  return callRefuse("unavailable", true);
}
