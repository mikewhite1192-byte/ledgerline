import { failed, inboxReply, inboxRefuse, inboxSession } from "@/lib/inbound/http";
import { readInboundDetail } from "@/lib/inbound/store";
import { withSessionTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";

// GET: one message for its page: the row, the text (a person must be able to read a held one;
// the page shows it as text, never as markup), the trace id and the model calls made for it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const checked = await inboxSession(request);
  if (!checked.ok) return checked.response;
  const { id } = await params;
  if (!isUuid(id)) return inboxRefuse("bad_request");
  try {
    const message = await withSessionTenant(checked.session, (q) => readInboundDetail(q, id.toLowerCase()));
    if (!message) return inboxRefuse("not_found");
    return inboxReply({ ok: true, message }, 200);
  } catch (err) {
    return failed(err, "read");
  }
}
