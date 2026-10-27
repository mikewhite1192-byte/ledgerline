import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { TenantDb } from "../db";
import { resolveDeps } from "../money/execute";
import { settle, switchOn } from "../money/ledger";
import { readAction, readByBatch } from "../money/read";
import { KIND_SHAPES, MoneyError, type MoneyAction, type MoneyFailure } from "../money/types";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { LEG_KINDS, payoutHooks, sendLeg, type LegKind, type SettlementMoneyDeps } from "./legs";

// Sends what a confirmed settlements batch reserved, inside one request's time budget: paystubs in
// driver order, and for each the payout, then the bill, then its payment, each only once the leg
// before it is confirmed. Every send replays the row the confirm reserved (same key, same attempt)
// through the money executor, which re-checks the switch and the adapter and claims the row before
// it calls out, so two drains at once send each leg once. A leg whose switch went off, or whose
// adapter is not ready, is refused in place; a reserved leg whose earlier leg failed is refused
// too, so the batch can finish. An unknown outcome stays unknown for the reconcile pass. The page
// calls the drain again while anything is left.

export type DrainCounts = { sent: number; confirmed: number; failed: number; unknown: number; remaining: number };

export type DrainResult =
  | ({ ok: true; status: "draining" | "done" | "partial" } & DrainCounts)
  | { ok: false; category: "disabled" | "not_found" };

export type DrainDeps = SettlementMoneyDeps & { clock?: () => Date };

// Each send needs this much of the budget left to start: the call's own limit plus the settle.
const START_MARGIN_MS = 4_000;

type BatchRow = { status: string; scope: string; item_ids: string; result: string | null };

type Subject = { settlementId: string; code: string };

const COUNT_KEYS = ["sent", "confirmed", "failed", "unknown", "remaining"] as const;

// The counts from the ledger rows as they stand.
export function countLegs(rows: readonly MoneyAction[], sent: number): DrainCounts {
  const out: DrainCounts = { sent, confirmed: 0, failed: 0, unknown: 0, remaining: 0 };
  for (const r of rows) {
    if (r.state === "confirmed") out.confirmed += 1;
    else if (r.state === "failed") out.failed += 1;
    else if (r.state === "unknown") out.unknown += 1;
    else out.remaining += 1;
  }
  return out;
}

// draining while any leg is reserved or sent; done when every leg is confirmed; partial otherwise.
export function batchStatusOf(c: DrainCounts): "draining" | "done" | "partial" {
  if (c.remaining > 0) return "draining";
  return c.failed === 0 && c.unknown === 0 ? "done" : "partial";
}

function storedCounts(text: string | null): DrainCounts {
  const out: DrainCounts = { sent: 0, confirmed: 0, failed: 0, unknown: 0, remaining: 0 };
  try {
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    for (const k of COUNT_KEYS) if (Number.isSafeInteger(parsed[k])) out[k] = parsed[k] as number;
  } catch {
    // A stored result is always an object the drain wrote; anything else reads as zeros.
  }
  return out;
}

// The batch's paystubs in driver order (then id, so the order is total).
async function readSubjects(db: TenantDb, tenantId: string, itemIds: string): Promise<Subject[]> {
  return db.withTenant(tenantId, async (q) => {
    const rows = await q.query<{ id: string; code: string }>(
      `SELECT s.id, d.code
         FROM settlements s
         JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
        WHERE s.tenant_id = current_tenant_id() AND s.id = ANY(CAST($1 AS uuid[]))
        ORDER BY d.code, s.id`,
      [itemIds],
    );
    return rows.map((r) => ({ settlementId: r.id, code: r.code }));
  });
}

// A reserved leg settled as refused before any call, with the payout's failure hook. false when it
// had already moved (another drain got there first).
async function refuse(
  db: TenantDb,
  tenantId: string,
  row: MoneyAction,
  category: MoneyFailure,
  clock: () => Date,
): Promise<boolean> {
  return db.withTenant(tenantId, async (q) => {
    if (!(await settle(q, row.id, { to: "failed", via: "refused", category }))) return false;
    const after = await readAction(q, row.id);
    if (after && row.kind === "settlement_payout") await payoutHooks(row.subjectId, clock).onFailed(q, after);
    return true;
  });
}

const latest = (rows: readonly MoneyAction[], subjectId: string, kind: LegKind): MoneyAction | null =>
  rows
    .filter((r) => r.subjectId === subjectId && r.kind === kind)
    .reduce<MoneyAction | null>((top, r) => (top === null || r.attempt > top.attempt ? r : top), null);

export async function drainBatch(
  db: TenantDb,
  session: Session,
  batchId: string,
  deadlineMs: number,
  deps: DrainDeps = {},
): Promise<DrainResult> {
  if (!flags.settlementsEnabled || !flags.batchApproveEnabled) return { ok: false, category: "disabled" };
  if (!isUuid(batchId)) return { ok: false, category: "not_found" };
  const id = batchId.toLowerCase();
  const tenantId = session.tenantId;
  const nowMs = deps.nowMs ?? Date.now;
  const clock = deps.clock ?? (() => new Date());
  const { nowMs: _n, clock: _c, ...money } = deps;
  void _n;
  void _c;
  const base = resolveDeps(money);

  const batch = await db.withTenant(tenantId, async (q) => {
    await assertMembership(q, session);
    const [row] = await q.query<BatchRow>(
      `SELECT status, scope, CAST(item_ids AS text) AS item_ids, CAST(result AS text) AS result
         FROM approval_batches WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
         FOR UPDATE`,
      [id],
    );
    if (!row || row.scope !== "settlements") return null;
    if (row.status === "confirmed") {
      await q.execute(
        `UPDATE approval_batches SET status = 'draining'
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'confirmed'`,
        [id],
      );
      return { ...row, status: "draining" };
    }
    return row;
  });
  if (!batch) return { ok: false, category: "not_found" };
  if (batch.status === "done" || batch.status === "partial") {
    return { ok: true, status: batch.status, ...storedCounts(batch.result) };
  }
  if (batch.status !== "draining") return { ok: false, category: "not_found" };

  const subjects = await readSubjects(db, tenantId, batch.item_ids);
  let sent = 0;
  let outOfTime = false;
  for (const subject of subjects) {
    for (let i = 0; i < LEG_KINDS.length; i += 1) {
      const kind = LEG_KINDS[i];
      const rows = await db.withTenant(tenantId, (q) => readByBatch(q, id));
      const row = latest(rows, subject.settlementId, kind);
      // Not reserved for this batch (its switch was off at the confirm), or waiting on the
      // reconcile pass.
      if (row === null || row.state === "unknown") break;
      // Finished: a failed leg still lets the legs after it be refused below.
      if (row.state === "confirmed" || row.state === "failed") continue;
      if (i > 0) {
        const before = latest(rows, subject.settlementId, LEG_KINDS[i - 1]);
        if (before === null || before.state === "failed") {
          // Nothing can send this leg now; refuse it (and so each leg after it) so the batch can
          // finish.
          if (row.state === "reserved") await refuse(db, tenantId, row, "not_configured", clock);
          continue;
        }
        // The leg before is still in flight or unknown: this paystub waits for it.
        if (before.state !== "confirmed") break;
      }
      const left = deadlineMs - nowMs();
      if (left <= START_MARGIN_MS) {
        outOfTime = true;
        break;
      }
      if (row.state === "reserved" && !switchOn(KIND_SHAPES[kind].channel)) {
        if (await refuse(db, tenantId, row, "disabled", clock)) continue;
        break;
      }
      let state: string;
      try {
        const result = await sendLeg(
          db,
          session,
          kind,
          { settlementId: subject.settlementId, driverId: row.counterpartyId, netCents: row.amountCents },
          { attempt: row.attempt, proposalId: row.proposalId, batchId: id },
          {
            ...money,
            timeoutMs: Math.max(1_000, Math.min(base.timeoutMs, left - 2_000)),
            waitMs: Math.max(0, Math.min(base.waitMs, left - 3_000)),
          },
          clock,
        );
        if (result.sent) sent += 1;
        state = result.action.state;
      } catch (err) {
        if (!(err instanceof MoneyError)) throw err;
        // Thrown before the row was touched (the switch, the adapter, or a check): refuse it in
        // place. An unknown outcome is left for the reconcile pass.
        const refused =
          err.category !== "unknown" && row.state === "reserved" && (await refuse(db, tenantId, row, err.category, clock));
        state = refused ? "failed" : "stopped";
      }
      // A failed leg refuses the legs after it in this same call; anything else not confirmed waits.
      if (state === "failed") continue;
      if (state !== "confirmed") break;
    }
    if (outOfTime) break;
  }

  const rows = await db.withTenant(tenantId, (q) => readByBatch(q, id));
  const counts = countLegs(rows, sent);
  const status = batchStatusOf(counts);
  await db.withTenant(tenantId, (q) =>
    q.execute(
      `UPDATE approval_batches SET status = $2, result = CAST($3 AS jsonb),
              finished_at = CASE WHEN $2 = 'draining' THEN NULL ELSE CAST($4 AS timestamptz) END
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'draining'`,
      [id, status, JSON.stringify(counts), clock().toISOString()],
    ),
  );
  return { ok: true, status, ...counts };
}
