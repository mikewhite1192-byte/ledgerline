import {
  answer,
  failed,
  inboxReply,
  inboxRefuse,
  inboxSession,
  PasteBody,
  pasteBodyBytes,
  readCappedJson,
} from "@/lib/inbound/http";
import { receiveMessage, sortMessage, type StepResult } from "@/lib/inbound/pipeline";
import { listInbound, readInbound } from "@/lib/inbound/store";
import { withSessionTenant } from "@/lib/tenant/context";

// POST: a driver's message pasted by the office, as JSON { id, text, fromAddress?, subject? } (the
// id made by the page). Stores it as an untrusted input with its Inbox row, then sorts it in the
// same request: the safety screen, then the triage model. Answers with the row as it stands, and
// the sort's category when it did not finish (the row is kept either way; Sort again retries).
// GET: the carrier's newest 50 messages, without their text.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const checked = await inboxSession(request);
  if (!checked.ok) return checked.response;
  const session = checked.session;
  const read = await readCappedJson(request, pasteBodyBytes());
  if (!read.ok) return inboxRefuse(read.category);
  const parsed = PasteBody.safeParse(read.body);
  if (!parsed.success) return inboxRefuse("bad_request");
  const body = parsed.data;
  try {
    const received = await receiveMessage(session, {
      id: body.id,
      channel: "paste",
      text: body.text,
      fromAddress: body.fromAddress ?? null,
      subject: body.subject ?? null,
      receivedAt: new Date(),
      messageId: null,
    });
    if (!received.ok) return answer(received);
    // A new message, or a repeated press whose first request never sorted it. A failed one waits
    // for Sort again, so a repeated press never spends a try by itself.
    let sort: StepResult | null = null;
    if (received.message.status === "received") {
      try {
        sort = await sortMessage(session, received.message.id);
      } catch (err) {
        console.error("inbox step failed:", "sort", err instanceof Error ? err.name : "unknown");
        sort = { ok: false, category: "unavailable", retryable: true };
      }
    }
    const message =
      sort === null ? received.message : ((await withSessionTenant(session, (q) => readInbound(q, received.message.id))) ?? received.message);
    return inboxReply({ ok: true, duplicate: received.duplicate, message, sort }, 200);
  } catch (err) {
    return failed(err, "receive");
  }
}

export async function GET(request: Request) {
  const checked = await inboxSession(request);
  if (!checked.ok) return checked.response;
  try {
    const messages = await withSessionTenant(checked.session, (q) => listInbound(q));
    return inboxReply({ ok: true, messages }, 200);
  } catch (err) {
    return failed(err, "list");
  }
}
