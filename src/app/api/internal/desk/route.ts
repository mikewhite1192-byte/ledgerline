import { randomUUID } from "node:crypto";
import { flags } from "@/config/flags";
import { getDb } from "@/lib/db";
import { wakeDesk } from "@/lib/desk/loop";
import { isCrossSite } from "@/lib/http/same-site";
import { internalKey, keyMatches } from "@/lib/sweep/internal-key";
import { serviceSession } from "@/lib/sweep/service-session";
import { isUuid } from "@/lib/uuid";
import { failed, objectBody, refused, reply } from "../../sweeps/reply";

// POST: the kicker's desk job (infra/lambda/sweep-kicker, event {"job":"desk"}). Header
// x-sweep-key (the sweep's own key: one Lambda, one key); body { action: 'wake', tenantId,
// wakeId? }. One call is one slice of the carrier's desk loop; the answer's status says "more"
// while work is left. It never reads a person's session: the key is the only way in, and every
// write runs as the carrier's sweep login (0018), which can draft but never approve. The switch is
// read before the key, so a switched-off loop never reads Secrets Manager.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  // A browser page never calls this; the kicker sends no Sec-Fetch-Site.
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (flags.deskLoop.enabled !== true) return refused("disabled");
  let key: string | null;
  try {
    key = await internalKey();
  } catch {
    key = null;
  }
  if (!key) return refused("not_configured");
  const given = request.headers.get("x-sweep-key");
  if (!keyMatches(given, key)) {
    // The key may have rotated since it was read: read it once more (at most once a minute)
    // before refusing. Anything short of a match is still a refusal.
    let fresh: string | null;
    try {
      fresh = await internalKey({}, { fresh: true });
    } catch {
      fresh = null;
    }
    if (!fresh || !keyMatches(given, fresh)) return reply({ error: "forbidden" }, 403);
  }
  const body = await objectBody(request);
  if (!body || body.action !== "wake" || !isUuid(body.tenantId)) return refused("bad_request");
  const wakeId = body.wakeId === undefined ? randomUUID() : body.wakeId;
  if (!isUuid(wakeId)) return refused("bad_request");
  try {
    const db = getDb();
    // The sweep login is the allowlist: a carrier without one has no desk loop.
    const session = await serviceSession(db, body.tenantId as string);
    if (!session) return refused("not_found");
    const result = await wakeDesk(
      session,
      { wakeId, by: "schedule", deadlineMs: Date.now() + flags.deskLoop.limits.sliceMs },
      { db },
    );
    if (!result.ok) {
      if (result.category === "unavailable") return reply({ error: "unavailable", retryable: true }, 503);
      return refused(result.category);
    }
    const c = result.counts;
    console.info(
      `desk wake ${result.wakeId} ${result.status} reason=${result.reason ?? "-"} seen=${c.seen} ` +
        `done=${c.done} carried=${c.carried} skipped=${c.skipped} failed=${c.failed} left=${c.left}`,
    );
    return reply({ wakeId: result.wakeId, status: result.status, reason: result.reason, counts: c }, 200);
  } catch (err) {
    return failed("desk internal", err);
  }
}
