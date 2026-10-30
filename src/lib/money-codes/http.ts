import { NextResponse } from "next/server";
import type { Session } from "../auth/claims";
import { getSession } from "../auth/session";
import { refuse, reply } from "../advances/http";
import { isCrossSite } from "../http/same-site";
import { isUuid } from "../uuid";
import { moneyCodesOn } from "./switches";

// The money-code buttons' shared shape, the advance routes' own: same-site POST, the money codes
// switch first, a signed-in member, a well-formed id, categories only in the reply (never outside
// text), never cached.

type Outcome = { ok: true } | { ok: false; category: string; retryable: boolean };

export async function codeAction<T extends Outcome>(
  request: Request,
  params: Promise<{ id: string }>,
  run: (session: Session, codeId: string) => Promise<T>,
): Promise<NextResponse> {
  if (isCrossSite(request)) return refuse("forbidden");
  if (!moneyCodesOn()) return refuse("disabled");
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
    console.error("money code action failed:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
