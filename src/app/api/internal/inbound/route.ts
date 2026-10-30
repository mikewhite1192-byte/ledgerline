import { z } from "zod";
import { flags } from "@/config/flags";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { failed, inboxRefuse, inboxReply, pasteBodyBytes, readCappedJson } from "@/lib/inbound/http";
import { inboundKey, keyMatches } from "@/lib/inbound/internal-key";
import { receiveMessage, sortMessage } from "@/lib/inbound/pipeline";
import { readInbound } from "@/lib/inbound/store";
import { serviceSession } from "@/lib/sweep/service-session";
import { withSessionTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";

// POST: the inbound mail poster (infra/lambda/inbound-mail). Header x-inbound-key; JSON body
// { tenantId, messageId, fromAddress, subject, text, receivedAt }. It never reads a person's
// session: the key is the only way in, and the message is stored and sorted as the carrier's
// service login (0018), which can draft but never approve. Off unless inboundEmailEnabled and
// inboxEnabled are both on; the switches are read before the key, so a switched-off mailbox never
// reads Secrets Manager. The SES message id is the dedupe key: the same message posted again (a
// retried invocation) is the row already there. Answers 202 with { id, status }; refusals carry a
// category only, and an error's name goes to the log, never its text.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const MailBody = z
  .object({
    tenantId: z.string().refine(isUuid),
    messageId: z.string().min(1).max(998),
    fromAddress: z.string().max(400).nullable(),
    subject: z.string().max(2_000).nullable(),
    text: z.string(),
    receivedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const notConfigured = () => inboxReply({ error: "not_configured", retryable: true }, 503);

export async function POST(request: Request) {
  // A browser page never calls this; the poster sends no Sec-Fetch-Site.
  if (isCrossSite(request)) return inboxRefuse("forbidden");
  if (flags.inboundEmailEnabled !== true || flags.inboxEnabled !== true) return inboxRefuse("disabled");
  let key: string | null;
  try {
    key = await inboundKey();
  } catch {
    key = null;
  }
  if (!key) return notConfigured();
  const given = request.headers.get("x-inbound-key");
  if (!keyMatches(given, key)) {
    // The key may have rotated since it was read: read it once more (at most once a minute)
    // before refusing. Anything short of a match is still a refusal.
    let fresh: string | null;
    try {
      fresh = await inboundKey({}, { fresh: true });
    } catch {
      fresh = null;
    }
    if (!fresh || !keyMatches(given, fresh)) return inboxRefuse("forbidden");
  }
  const read = await readCappedJson(request, pasteBodyBytes());
  if (!read.ok) return inboxRefuse(read.category);
  const parsed = MailBody.safeParse(read.body);
  if (!parsed.success) return inboxRefuse("bad_request");
  const body = parsed.data;
  try {
    // The service login is the allowlist: a carrier without one takes no mail.
    const session = await serviceSession(getDb(), body.tenantId);
    if (!session) return inboxRefuse("forbidden");
    const received = await receiveMessage(session, {
      id: crypto.randomUUID(),
      channel: "email",
      text: body.text,
      fromAddress: body.fromAddress,
      subject: body.subject,
      receivedAt: new Date(body.receivedAt),
      messageId: body.messageId,
    });
    if (!received.ok) return inboxRefuse(received.category, received.retryable);
    // A new message, or a repeat whose first post never sorted it. The row is kept whatever the
    // sort says (a failed sort waits for Sort again), so only the receive decides the answer.
    let status = received.message.status;
    if (status === "received") {
      try {
        const sort = await sortMessage(session, received.message.id);
        if (!sort.ok) console.info(`inbound email sort: ${sort.category}`);
      } catch (err) {
        console.error("inbox step failed:", "email sort", err instanceof Error ? err.name : "unknown");
      }
      try {
        const now = await withSessionTenant(session, (q) => readInbound(q, received.message.id));
        if (now) status = now.status;
      } catch (err) {
        // The row is stored either way; the answer then names the status it was stored with.
        console.error("inbox step failed:", "email reread", err instanceof Error ? err.name : "unknown");
      }
    }
    return inboxReply({ id: received.message.id, status }, 202);
  } catch (err) {
    return failed(err, "email receive");
  }
}
