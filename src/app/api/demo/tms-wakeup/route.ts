import { randomUUID } from "node:crypto";
import { flags } from "@/config/flags";
import { readRole } from "@/lib/auth/role";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { assertMembership } from "@/lib/tenant/context";
import { acceptWakeUp, readWakeUp } from "@/lib/tms/wakeups";
import { failed, refused, reply } from "../../sweeps/reply";

// POST: Settings > Demo's "Fire a wake-up twice" (the duplicate_wakeups fault). A signed-in admin
// of the carrier (the only role the page shows the button to; staff and judges are refused) sends
// the same wake-up twice for the carrier's newest mirrored load, the way the dispatch webhook keeps
// one: two sends, one tms_wakeups row (tms_wakeups_one_waiting), so the next sync reads the load
// once. It answers 404 while the demo fault controls, the webhook's switch or the sync's switch is
// off, or the carrier has no synthetic dispatch feed. It writes only the caller's own tenant's
// wake-up row and the hook's minute count (RLS), and wakes nothing: no load moves, no money moves,
// nothing is sent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  if (flags.tmsSync.demoFaultsEnabled !== true || flags.tmsHook.enabled !== true || flags.tmsSync.enabled !== true) {
    return refused("not_found");
  }
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const perMinute = flags.tmsHook.hookPerMinute;
  if (!Number.isSafeInteger(perMinute) || perMinute < 1) return refused("not_configured");
  try {
    const db = getDb();
    const target = await db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      if ((await readRole(q, session)) !== "admin") return "role" as const;
      const rows = await q.query<{ external_id: string; reference: string }>(
        `SELECT l.external_id, l.reference FROM tms_loads l
          JOIN tms_connections c ON c.tenant_id = l.tenant_id AND c.system IN ('synthetic', 'mock')
          WHERE l.tenant_id = current_tenant_id() AND l.gone_at IS NULL
          ORDER BY l.source_updated_at DESC, l.external_id DESC LIMIT 1`,
      );
      return rows[0] ?? null;
    });
    if (target === "role") return refused("role");
    const wakeUp = target === null ? null : readWakeUp({ recordType: "load", externalId: target.external_id });
    if (target === null || wakeUp === null) return refused("not_found");
    // Two sends in two transactions, as two webhook calls would be: the second is the first's row.
    const send = () =>
      db.withTenant(session.tenantId, async (q) => {
        await assertMembership(q, session);
        return acceptWakeUp(q, wakeUp, { id: randomUUID(), nowIso: new Date().toISOString(), perMinute });
      });
    const first = await send();
    const second = await send();
    const waiting = await db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      const rows = await q.query<{ n: number }>(
        `SELECT CAST(count(*) AS integer) AS n FROM tms_wakeups
          WHERE tenant_id = current_tenant_id() AND record_type = 'load' AND external_id = $1 AND processed_at IS NULL`,
        [wakeUp.externalId],
      );
      return Number(rows[0]?.n ?? 0);
    });
    return reply({ reference: target.reference, first: first.queued, second: second.queued, waiting }, 200);
  } catch (err) {
    return failed("demo wake-up", err);
  }
}
