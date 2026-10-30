import { NextResponse } from "next/server";
import type { z } from "zod";
import type { Session } from "../auth/claims";
import { getSession } from "../auth/session";
import { staffGate } from "../auth/staff-gate";
import { isCrossSite } from "../http/same-site";
import { isUuid } from "../uuid";
import { advancesOn } from "./switches";

// The advance routes' shared shape: same-site POST, a signed-in member, a well-formed id, the
// advances switch first, categories only in the reply (never upstream text), never cached.
// advanceAction and bodyAction are staff-only presses: a judge is refused before anything runs
// (the request desk and its suggestion are their own routes, on the judge allowlist).

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
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
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

// The same shape for a press that sends a small JSON body (the driver's money panel, Take back):
// every id in the path well formed, the body parsed strictly, then run with lower-case ids.
export async function bodyAction<P extends Record<string, string>, B, T extends Outcome>(
  request: Request,
  params: Promise<P>,
  schema: z.ZodType<B>,
  run: (session: Session, ids: P, body: B) => Promise<T>,
): Promise<NextResponse> {
  if (isCrossSite(request)) return refuse("forbidden");
  if (!advancesOn()) return refuse("disabled");
  const session = await getSession();
  if (!session) return refuse("unauthenticated");
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const raw = await params;
  const ids = {} as Record<string, string>;
  for (const [key, value] of Object.entries(raw)) {
    if (!isUuid(value)) return refuse("bad_request");
    ids[key] = value.toLowerCase();
  }
  let body: B;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return refuse("bad_request");
    body = parsed.data;
  } catch {
    return refuse("bad_request");
  }
  try {
    const result = await run(session, ids as P, body);
    if (result.ok) return reply(result, 200);
    return refuse(result.category, result.retryable);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden");
    console.error("advance action failed:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
