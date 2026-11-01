import { randomUUID } from "node:crypto";
import { flags } from "@/config/flags";
import { getDb } from "@/lib/db";
import { wakeDesk } from "@/lib/desk/loop";
import { isCrossSite } from "@/lib/http/same-site";
import { readCappedJson } from "@/lib/inbound/http";
import { serviceSession } from "@/lib/sweep/service-session";
import { withSessionTenant } from "@/lib/tenant/context";
import { keyMatches, tmsHookKey } from "@/lib/tms/hook-key";
import { acceptWakeUp, readWakeUp } from "@/lib/tms/wakeups";
import { isUuid } from "@/lib/uuid";
import { failed, refused, reply } from "../../../sweeps/reply";

// POST /api/internal/tms-hook/<tenant>?token=<key>: the dispatch system's webhook, a wake-up only
// (TMS-MIRROR T4). Body { recordType, externalId }, at most 4 KB; nothing else in it is read, and
// nothing in it is trusted for content: the sync reads the record again in full. It never reads
// a person's session: the token is the only way in, and the wake runs as the carrier's sweep login
// (0018), which can draft but never approve. Off unless tmsHook.enabled and tmsSync.enabled are
// both on; the switches are read before the key, so a switched-off hook never reads Secrets
// Manager. The token is checked before the tenant is read, so a wrong one never tells whether
// the carrier exists. The same wake-up sent again while it waits is the row already there
// (tms_wakeups_one_waiting). Past flags.tmsHook.hookPerMinute calls a minute it answers 429, with
// the wake-up still kept. Refusals carry a category only; an error's name goes to the log, never
// its text, the URL or the token.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const HOOK_BODY_BYTES = 4_096;

const HOOK_STATUS: Readonly<Record<string, number>> = { too_long: 413, rate_limited: 429 };

function refuse(category: string) {
  if (category in HOOK_STATUS) return reply({ error: category, retryable: category === "rate_limited" }, HOOK_STATUS[category]);
  return refused(category);
}

export async function POST(request: Request, { params }: { params: Promise<{ tenant: string }> }) {
  // A browser page never calls this; the dispatch system sends no Sec-Fetch-Site.
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (flags.tmsHook.enabled !== true || flags.tmsSync.enabled !== true) return refused("disabled");
  let key: string | null;
  try {
    key = await tmsHookKey();
  } catch {
    key = null;
  }
  if (!key) return refused("not_configured");
  let given: string | null;
  try {
    given = new URL(request.url).searchParams.get("token");
  } catch {
    given = null;
  }
  if (!keyMatches(given, key)) {
    // The key may have rotated since it was read: read it once more (at most once a minute)
    // before refusing. Anything short of a match is still a refusal.
    let fresh: string | null;
    try {
      fresh = await tmsHookKey({}, { fresh: true });
    } catch {
      fresh = null;
    }
    if (!fresh || !keyMatches(given, fresh)) return reply({ error: "forbidden" }, 403);
  }
  const { tenant } = await params;
  if (!isUuid(tenant)) return refused("not_found");
  const read = await readCappedJson(request, HOOK_BODY_BYTES);
  if (!read.ok) return refuse(read.category);
  // An unknown record type, or an id out of bounds, is refused whole.
  const wakeUp = readWakeUp(read.body);
  if (!wakeUp) return refused("bad_request");
  const perMinute = flags.tmsHook.hookPerMinute;
  if (!Number.isSafeInteger(perMinute) || perMinute < 1) return refused("not_configured");
  try {
    const db = getDb();
    // The sweep login is the allowlist: a carrier without one takes no wake-ups.
    const session = await serviceSession(db, tenant);
    if (!session) return refused("not_found");
    const nowIso = new Date().toISOString();
    const accepted = await withSessionTenant(session, (q) =>
      acceptWakeUp(q, wakeUp, { id: randomUUID(), nowIso, perMinute }),
    );
    // Over the minute's bound, or no room left to keep it: the caller may send it again later, and
    // the sync's list walk finds the change either way.
    if (!accepted.withinRate || accepted.queued === "full") return refuse("rate_limited");
    // The wake takes the desk's lease; a wake already running answers busy and is not doubled.
    // Its pass takes this wake-up first. The row is kept whatever the wake says.
    const wake = await wakeDesk(
      session,
      { wakeId: randomUUID(), by: "webhook", deadlineMs: Date.now() + flags.deskLoop.limits.sliceMs },
      { db },
    );
    const status = wake.ok ? wake.status : wake.category;
    console.info(`tms hook ${wakeUp.recordType} ${accepted.queued} wake=${status}`);
    return reply({ queued: accepted.queued, wake: status }, 202);
  } catch (err) {
    return failed("tms hook", err);
  }
}
