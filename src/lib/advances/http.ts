import { NextResponse } from "next/server";
import type { Session } from "../auth/claims";
import { getSession } from "../auth/session";
import { isCrossSite } from "../http/same-site";
import { isUuid } from "../uuid";
import { advancesOn } from "./switches";

// The advance routes' shared shape: same-site POST, a signed-in member, a well-formed id, the
// advances switch first, categories only in the reply (never upstream text), never cached.

export const ADVANCE_STATUS: Readonly<Record<string, number>> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  disabled: 403,
  role: 403,
  not_found: 404,
  unavailable: 503,
};

export function reply(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function refuse(category: string, retryable = false): NextResponse {
  return reply({ error: category, retryable }, ADVANCE_STATUS[category] ?? 409);
}

type Outcome = { ok: true } | { ok: false; category: string; retryable: boolean };

// One button press on an advance's page: run it and answer with its category.
export async function advanceAction<T extends Outcome>(
  request: Request,
  params: Promise<{ id: string }>,
  run: (session: Session, advanceId: string) => Promise<T>,
): Promise<NextResponse> {
  if (isCrossSite(request)) return refuse("forbidden");
  if (!advancesOn()) return refuse("disabled");
  const session = await getSession();
  if (!session) return refuse("unauthenticated");
  const { id } = await params;
  if (!isUuid(id)) return refuse("bad_request");
  try {
    const result = await run(session, id.toLowerCase());
    if (result.ok) return reply(result, 200);
    return refuse(result.category, result.retryable);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden");
    console.error("advance action failed:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
