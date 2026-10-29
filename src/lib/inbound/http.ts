import { NextResponse } from "next/server";
import { z } from "zod";
import { flags } from "../../config/flags";
import { ADVANCE_STATUS } from "../advances/http";
import type { Session } from "../auth/claims";
import { getSession } from "../auth/session";
import { staffGate } from "../auth/staff-gate";
import { isCrossSite } from "../http/same-site";
import { isUuid } from "../uuid";

// The Inbox routes' shared shape: same-site POST, the Inbox switch first, a signed-in member, a
// well-formed id, a body read with a cap and parsed strictly, categories only in the reply (never
// upstream text or the message), never cached.

export const inboxOn = () => flags.inboxEnabled === true;

export const INBOX_STATUS: Readonly<Record<string, number>> = {
  ...ADVANCE_STATUS,
  empty: 400,
  too_long: 413,
  daily_cap: 429,
};

export function inboxReply(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function inboxRefuse(category: string, retryable = false): NextResponse {
  return inboxReply({ error: category, retryable }, INBOX_STATUS[category] ?? 409);
}

type Outcome = { ok: true } | { ok: false; category: string; retryable: boolean };

export function answer(result: Outcome): NextResponse {
  if (result.ok) return inboxReply(result, 200);
  return inboxRefuse(result.category, result.retryable);
}

export function failed(err: unknown, what: string): NextResponse {
  if (err instanceof Error && err.name === "ForbiddenError") return inboxRefuse("forbidden");
  console.error("inbox step failed:", what, err instanceof Error ? err.name : "unknown");
  return inboxRefuse("unavailable", true);
}

// A pasted message. The id is made by the page, so a second press of the same paste is the same
// row. Sender and subject are optional display fields; the text is checked for size by the
// pipeline, after trimming.
export const PasteBody = z
  .object({
    id: z.string().refine(isUuid),
    text: z.string(),
    fromAddress: z.string().max(400).nullable().optional(),
    subject: z.string().max(2_000).nullable().optional(),
  })
  .strict();
export type PasteBody = z.infer<typeof PasteBody>;

// Room for the longest message the switch allows, written as JSON escapes at worst, and the rest
// of the body.
export function pasteBodyBytes(): number {
  return flags.inboxLimits.maxChars * 6 + 16 * 1024;
}

export type JsonRead = { ok: true; body: unknown } | { ok: false; category: "too_long" | "bad_request" };

// A JSON body read with a size cap: the declared length first, then counted as it arrives and
// dropped the moment it passes the cap.
export async function readCappedJson(request: Request, maxBytes: number): Promise<JsonRead> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) return { ok: false, category: "bad_request" };
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, category: "too_long" };
  }
  if (!request.body) return { ok: false, category: "bad_request" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, category: "too_long" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, category: "bad_request" };
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all)) };
  } catch {
    return { ok: false, category: "bad_request" };
  }
}

// The checks every Inbox route makes before its own work: same site (a read too: another site may
// not pull a carrier's messages), the switch, then a signed-in member.
export async function inboxSession(
  request: Request,
): Promise<{ ok: true; session: Session } | { ok: false; response: NextResponse }> {
  if (isCrossSite(request)) return { ok: false, response: inboxRefuse("forbidden") };
  if (!inboxOn()) return { ok: false, response: inboxRefuse("disabled") };
  const session = await getSession();
  if (!session) return { ok: false, response: inboxRefuse("unauthenticated") };
  return { ok: true, session };
}

// One button press on a message's page: run it and answer with its category. The checks are
// inboxSession's, written out so the staff check comes after guards only: a demo visitor (the judge
// role) is refused before any work (src/lib/auth/judge-allowlist.test.ts follows this helper).
export async function inboxAction<T extends Outcome>(
  request: Request,
  params: Promise<{ id: string }>,
  what: string,
  run: (session: Session, inboundId: string) => Promise<T>,
): Promise<NextResponse> {
  if (isCrossSite(request)) return inboxRefuse("forbidden");
  if (!inboxOn()) return inboxRefuse("disabled");
  const session = await getSession();
  if (!session) return inboxRefuse("unauthenticated");
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return inboxRefuse("bad_request");
  try {
    return answer(await run(session, id.toLowerCase()));
  } catch (err) {
    return failed(err, what);
  }
}
