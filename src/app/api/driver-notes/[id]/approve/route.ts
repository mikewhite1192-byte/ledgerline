import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { approveNote } from "@/lib/driver-notes/decide";
import { deliverNoteEmail } from "@/lib/driver-notes/deliver";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";

// POST: a person approves a drafted note. Approval delivers it to the driver view in the same
// statement; then the email path runs, which with its switch off (or an address off the
// allowlist, or no sender) logs "would send" and sends nothing. The email outcome never undoes
// the approval.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

const STATUS = { disabled: 409, not_found: 404, not_approvable: 409, already_decided: 409 } as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (!flags.driverNotesEnabled) return reply({ error: "notes_off" }, 409);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "bad_request" }, 400);
  try {
    const result = await approveNote(session, id);
    if (!result.ok) return reply({ error: result.category }, STATUS[result.category]);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("driver note approve failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
  let email: string;
  try {
    const sent = await deliverNoteEmail(session, id);
    email = sent.sent ? "sent" : sent.category;
  } catch (err) {
    console.error("driver note email step failed:", err instanceof Error ? err.name : "unknown");
    email = "unknown";
  }
  return reply({ ok: true, status: "approved", channel: "driver_view", email }, 200);
}
