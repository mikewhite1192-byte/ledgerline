import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { draftCollections } from "@/lib/collections/draft";
import { isCrossSite } from "@/lib/http/same-site";

// POST: draft payment reminders for invoices 30 or more days past due. One request is one run: it
// starts reminders for up to 20 seconds, at most maxDraftsPerRun of them inside the run's spending
// cap, and replies with what it did. A second press drafts only invoices with no reminder at their
// stage yet (UNIQUE per invoice and stage). Nothing is sent: a reminder waits for a person.
// With collectionsEnabled off the route answers 404 before reading anything; the drafting code
// checks collectionsEnabled and aiEnabled again.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const RUN_MS = 20_000;

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.collectionsEnabled) return reply({ error: "not_found" }, 404);
  if (!flags.aiEnabled) return reply({ error: "ai_off" }, 409);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  try {
    const result = await draftCollections(session, new Date(Date.now() + RUN_MS));
    if (!result.ok) {
      return result.category === "disabled" ? reply({ error: "not_found" }, 404) : reply({ error: "ai_off" }, 409);
    }
    // The run's trace id stays in the server log line; the page never shows one.
    return reply(
      {
        ok: true,
        drafted: result.drafted,
        refused: result.refused,
        overCap: result.overCap,
        skipped: result.skipped,
        remaining: result.remaining,
        stoppedBy: result.stoppedBy,
        more: result.more,
      },
      200,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("collections draft failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
