import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { countApprovalBreaks } from "../invariants/approvals";
import { READ_ONLY_SQL, readOnly } from "../invariants/types";
import { serviceSub } from "../sweep/service-session";
import { assertMembership } from "../tenant/context";
import { isDeskSource, localMidnightOf, type DeskSource } from "./keys";
import { LINE_KINDS, readState, type LineKind } from "./log";
import { STATE_LIMIT } from "./loop";

// What the desk panel shows, every number read from our own tables (design 4, the panel is PR 2).
// A count that does not read back is null ("not read"), never 0.

export type DeskPanel = {
  runningSince: string | null;
  eventsHandled: number;
  toolCalls: number;
  problemsFound: number;
  proposalsWaiting: number;
  // Null: the count did not read back, and the panel says "not read".
  moneyMovedWithoutApproval: number | null;
  lastWake: { at: string; handled: number; skipped: number } | null;
  // Open events for the next wake.
  left: number;
};

export type DeskLogLine = {
  at: string;
  kind: LineKind;
  source: DeskSource | null;
  found: number | null;
  category: string | null;
};

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function wholeOrThrow(n: unknown): number {
  if (!whole(n)) throw new DbError("unknown");
  return n;
}

const PANEL_SQL = `SELECT ${ts("l.running_since")} AS running_since FROM desk_loops l WHERE l.tenant_id = current_tenant_id()`;

const ZONE_SQL = `SELECT t.timezone AS zone FROM tenants t WHERE t.id = current_tenant_id()`;

// Done lines since the loop started, and what they found.
const HANDLED_SQL = `SELECT CAST(count(*) AS integer) AS handled,
       CAST(COALESCE(SUM(CASE WHEN detail->>'found' ~ '^[0-9]{1,9}$' THEN CAST(detail->>'found' AS integer) END), 0) AS integer) AS found
  FROM desk_log WHERE tenant_id = current_tenant_id() AND kind = 'done' AND at >= CAST($1 AS timestamptz)`;

// The tool steps of every turn the loop's service login opened since the loop started.
const TOOL_CALLS_SQL = `SELECT CAST(count(*) AS integer) AS n
  FROM turn_steps s
  JOIN turns t ON t.tenant_id = s.tenant_id AND t.id = s.turn_id
  JOIN conversations c ON c.tenant_id = t.tenant_id AND c.id = t.conversation_id
 WHERE s.tenant_id = current_tenant_id() AND s.kind = 'tool' AND c.created_by = $1
   AND t.started_at >= CAST($2 AS timestamptz)`;

const WAITING_SQL = `SELECT CAST(count(*) AS integer) AS n FROM proposals
  WHERE tenant_id = current_tenant_id() AND status = 'proposed'`;

const LAST_WAKE_SQL = `SELECT ${ts("w.at")} AS at,
       CAST((SELECT count(*) FROM desk_log d WHERE d.tenant_id = w.tenant_id AND d.wake_id = w.wake_id AND d.kind = 'done') AS integer) AS handled,
       CAST((SELECT count(*) FROM desk_log d WHERE d.tenant_id = w.tenant_id AND d.wake_id = w.wake_id AND d.kind = 'skipped') AS integer) AS skipped
  FROM desk_log w WHERE w.tenant_id = current_tenant_id() AND w.kind = 'wake'
 ORDER BY w.at DESC, w.id DESC LIMIT 1`;

// Lines at the same instant read in the order they are written: a wake's own lines first, its
// sleep line last.
const LOG_SQL = `SELECT ${ts("at")} AS at, kind, source,
       CASE WHEN detail->>'found' ~ '^[0-9]{1,9}$' THEN CAST(detail->>'found' AS integer) END AS found,
       detail->>'category' AS category
  FROM desk_log WHERE tenant_id = current_tenant_id()
 ORDER BY at DESC,
          CASE kind WHEN 'wake' THEN 0 WHEN 'seen' THEN 1 WHEN 'claimed' THEN 2 WHEN 'carried' THEN 3
                    WHEN 'sleep' THEN 5 ELSE 4 END DESC,
          id DESC
 LIMIT $1`;

export type ViewDeps = { db?: TenantDb };

// The panel's numbers, in one read transaction, and the money count in its own read-only one, so
// a count that fails cannot take the other numbers with it.
export async function readDeskPanel(session: Session, deps: ViewDeps = {}): Promise<DeskPanel> {
  const db = deps.db ?? getDb();
  const panel = await db.withTenant(session.tenantId, async (q: Queryable) => {
    await assertMembership(q, session);
    // The same start the loop reads from: the carrier's own midnight on the start date.
    const [tenant] = await q.query<{ zone: unknown }>(ZONE_SQL);
    if (!tenant || typeof tenant.zone !== "string" || tenant.zone.length === 0) throw new DbError("unknown");
    const startInstant = localMidnightOf(flags.deskLoop.startDate, tenant.zone);
    const [loop] = await q.query<{ running_since: string | null }>(PANEL_SQL);
    const runningSince = loop?.running_since ?? null;
    let eventsHandled = 0;
    let problemsFound = 0;
    let toolCalls = 0;
    if (runningSince !== null) {
      const [h] = await q.query<{ handled: unknown; found: unknown }>(HANDLED_SQL, [runningSince]);
      eventsHandled = wholeOrThrow(h?.handled);
      problemsFound = wholeOrThrow(h?.found);
      const [t] = await q.query<{ n: unknown }>(TOOL_CALLS_SQL, [serviceSub(session.tenantId), runningSince]);
      toolCalls = wholeOrThrow(t?.n);
    }
    const [w] = await q.query<{ n: unknown }>(WAITING_SQL);
    const [last] = await q.query<{ at: string; handled: unknown; skipped: unknown }>(LAST_WAKE_SQL);
    const lastWake = last
      ? { at: last.at, handled: wholeOrThrow(last.handled), skipped: wholeOrThrow(last.skipped) }
      : null;
    const open = await readState(q, { sinceStart: startInstant, limit: STATE_LIMIT });
    return {
      runningSince,
      eventsHandled,
      toolCalls,
      problemsFound,
      proposalsWaiting: wholeOrThrow(w?.n),
      lastWake,
      left: open.length,
    };
  });
  return { ...panel, moneyMovedWithoutApproval: await readMoneyCount(db, session) };
}

// I3's payment rows and proposal links for this carrier, or null when the read fails in any way.
export async function readMoneyCount(db: TenantDb, session: Session): Promise<number | null> {
  try {
    return await db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      await q.execute(READ_ONLY_SQL);
      return countApprovalBreaks(readOnly(q));
    });
  } catch {
    return null;
  }
}

// The latest lines, newest first.
export async function readDeskLog(session: Session, limit = 50, deps: ViewDeps = {}): Promise<DeskLogLine[]> {
  const db = deps.db ?? getDb();
  const n = Number.isSafeInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
  const rows = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return q.query<{ at: string; kind: string; source: string | null; found: unknown; category: string | null }>(LOG_SQL, [n]);
  });
  return rows.map((r) => {
    if (!(LINE_KINDS as readonly string[]).includes(r.kind) || (r.source !== null && !isDeskSource(r.source))) {
      throw new DbError("unknown");
    }
    return {
      at: r.at,
      kind: r.kind as LineKind,
      source: r.source as DeskSource | null,
      found: whole(r.found) ? r.found : null,
      category: typeof r.category === "string" ? r.category : null,
    };
  });
}
