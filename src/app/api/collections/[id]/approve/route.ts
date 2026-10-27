import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { approveReminder } from "@/lib/collections/decide";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: a person approves a drafted reminder. Approval records it (Test mode); then the email path
// runs, which with its switch off (or the address off the allowlist, a draft older than the start
// date, or no sender) logs "would send" and sends nothing. The email outcome never undoes the
// approval, and an email that may or may not have gone answers "unknown", never "would_send".
// With collectionsEnabled off the route answers 404 before reading anything.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

const STATUS = {
  disabled: 404,
  not_found: 404,
  not_approvable: 409,
  already_decided: 409,
  paid_since: 409,
  changed: 409,
  stage_passed: 409,
} as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.collectionsEnabled) return reply({ error: "not_found" }, 404);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const result = await approveReminder(session, id);
    if (!result.ok) return reply({ error: result.category === "disabled" ? "not_found" : result.category }, STATUS[result.category]);
    const email = result.email.sent ? "sent" : result.email.category === "unknown" ? "unknown" : "would_send";
    const category = result.email.sent ? null : result.email.category;
    return reply({ ok: true, status: "approved", channel: result.channel, email, category }, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("collections approve failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
