import { NextResponse } from "next/server";
import { ForbiddenError, withSessionTenant } from "../tenant/context";
import type { Session } from "./claims";
import { requireStaff } from "./role";

// The route form of requireStaff: one short tenant transaction before the route does any work.
// null means go on; otherwise the answer to send. A judge gets 403 "judge" (the page shows "Approving
// is for the carrier's staff"); no membership gets 403 "forbidden"; anything else is unknown, so the
// route refuses (503, retryable) rather than guessing. Only the error's name reaches the log.
export async function staffGate(session: Session): Promise<NextResponse | null> {
  try {
    await withSessionTenant(session, (q) => requireStaff(q, session));
    return null;
  } catch (err) {
    if (err instanceof ForbiddenError) {
      const error = err.reason === "judge" ? "judge" : "forbidden";
      return refusal({ error, retryable: false }, 403);
    }
    console.error("staff check failed:", err instanceof Error ? err.name : "unknown");
    return refusal({ error: "unavailable", retryable: true }, 503);
  }
}

function refusal(body: { error: string; retryable: boolean }, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
