import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isClean } from "../agent/proposals/clean";
import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { approvalFrom } from "../money/approval";
import { resolveDeps, systemFor } from "../money/execute";
import { reserve, switchOn } from "../money/ledger";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { SettlementArgs, sameAsStored } from "./approve";
import { readCleanSet, type CleanSet } from "./clean";
import { linesHash } from "./hash";
import { LEG_KINDS, legDraft, linkProposal, type LegKind, type SettlementMoneyDeps } from "./legs";
import type { ParkReason } from "./reconcile";
import { parkSettlement, readStoredLines, readStoredSettlement, recheckSettlement } from "./stored";

// "Approve all clean" for one pay week: one deliberate approval over the exact list the person saw.
// In one transaction, with the listed cards and their paystubs locked (ordered by id, so two
// confirms cannot deadlock), every item must still be clean, still a draft of this week, equal to
// its card, and pass the pre-pay recheck; the ids must be exactly the sent ones and the cents must
// add up to the sent total exactly, within the batch caps; the caller must be an admin when any
// paystub or the total is above the approver line. Any miss writes nothing: the drifted paystubs
// are parked in their own short transaction and the answer is 'stale' with the clean list as it
// stands now.
//
// Otherwise, in that same transaction: the batch row, every card approved (who, when, the batch)
// and then executing, every paystub approved, and the ledger rows reserved with the batch id in
// driver order (the payout when payouts are on; the bill and its payment only when both switches
// are on, since a bill never goes out before its payout). That commit is the approval. Nothing is
// sent here: the drain sends the reserved rows (drain.ts). With nothing reserved the batch is done
// at once, each card done 'not_paid', with one "would send" line per leg.

export type BatchRequest = { periodId: string; proposalIds: string[]; totalCents: number };

export type ConfirmResult =
  | { ok: true; batchId: string; itemCount: number; totalCents: number; legsReserved: number; status: "confirmed" | "done" }
  | { ok: false; category: "disabled" | "validation" | "role" }
  | { ok: false; category: "stale"; current: CleanSet };

const Request = z.strictObject({
  periodId: z.uuid(),
  proposalIds: z.array(z.uuid()).min(1),
  totalCents: z.int().nonnegative(),
});

export function parseBatchRequest(body: unknown): BatchRequest | null {
  const parsed = Request.safeParse(body);
  if (!parsed.success) return null;
  return { ...parsed.data, proposalIds: parsed.data.proposalIds.map((id) => id.toLowerCase()) };
}

export type BatchItem = { proposalId: string; netCents: number };

// The pure part of the confirm: the locked items are exactly the sent ids (each once, 1 to the cap)
// and their cents add up to the sent total exactly, within the batch's total cap.
export function checkBatch(
  items: readonly BatchItem[],
  sentIds: readonly string[],
  sentTotal: number,
  limits: { maxItems: number; maxTotalCents: number } = flags.batchLimits,
): boolean {
  if (sentIds.length < 1 || sentIds.length > limits.maxItems) return false;
  const sent = new Set(sentIds);
  if (sent.size !== sentIds.length || items.length !== sentIds.length) return false;
  let total = 0;
  for (const i of items) {
    if (!sent.has(i.proposalId) || !Number.isSafeInteger(i.netCents) || i.netCents <= 0) return false;
    total += i.netCents;
  }
  return Number.isSafeInteger(sentTotal) && total === sentTotal && sentTotal <= limits.maxTotalCents;
}

type ProposalLock = {
  id: string;
  kind: string;
  subject_table: string;
  subject_id: string;
  amount_cents: number | string;
  args: string;
  status: string;
  exceptions: string;
  flagged_input_id: string | null;
  auditor_verdict: string | null;
  auditor_agrees: boolean | null;
};

type Item = { proposalId: string; settlementId: string; driverId: string; driverCode: string; netCents: number };
type Park = { settlementId: string; reason: ParkReason };

type Checked =
  | { ok: true; items: Item[] }
  | { ok: false; category: "role" }
  | { ok: false; category: "stale"; parks: Park[] };

const uuidList = (ids: readonly string[]): string => {
  for (const id of ids) if (!isUuid(id)) throw new Error("not a record id");
  return `{${ids.join(",")}}`;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Every check, inside the confirm transaction, after the locks. Writes nothing.
async function checkItems(q: Queryable, session: Session, req: BatchRequest): Promise<Checked> {
  const ids = uuidList(req.proposalIds);
  const stale: Checked = { ok: false, category: "stale", parks: [] };
  // Locks go paystubs first, then their cards, each in id order: the order the run, the single
  // approve and the payout's booking use too. A card's subject never changes, so the unlocked
  // read that finds the paystubs still names them once the cards are locked.
  const named = await q.query<{ subject_id: string | null }>(
    `SELECT subject_id FROM proposals WHERE tenant_id = current_tenant_id() AND id = ANY(CAST($1 AS uuid[]))`,
    [ids],
  );
  const namedSubjects = named.map((p) => p.subject_id).filter((id): id is string => isUuid(id));
  if (named.length !== req.proposalIds.length || namedSubjects.length !== named.length) return stale;
  await q.query(
    `SELECT id FROM settlements WHERE tenant_id = current_tenant_id() AND id = ANY(CAST($1 AS uuid[]))
      ORDER BY id FOR UPDATE`,
    [uuidList(namedSubjects)],
  );
  const locked = await q.query<ProposalLock>(
    `SELECT id, kind, subject_table, subject_id, amount_cents, CAST(args AS text) AS args, status,
            CAST(exceptions AS text) AS exceptions, flagged_input_id, auditor_verdict, auditor_agrees
       FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = ANY(CAST($1 AS uuid[]))
      ORDER BY id FOR UPDATE`,
    [ids],
  );
  if (locked.length !== req.proposalIds.length) return stale;
  const subjects = locked.map((p) => p.subject_id).filter(isUuid);
  if (subjects.length !== locked.length) return stale;
  const items: Item[] = [];
  const parks: Park[] = [];
  let miss = false;
  for (const p of locked) {
    const exceptions = parseJson(p.exceptions);
    const clean =
      p.kind === "settlement_approve" &&
      p.subject_table === "settlements" &&
      Array.isArray(exceptions) &&
      isClean({
        status: p.status,
        exceptions,
        flaggedInputId: p.flagged_input_id,
        auditorVerdict: p.auditor_verdict,
        auditorAgrees: p.auditor_agrees,
      });
    const args = SettlementArgs.safeParse(parseJson(p.args));
    const stored = await readStoredSettlement(q, p.subject_id, false);
    if (
      !clean ||
      !args.success ||
      args.data.settlementId !== p.subject_id ||
      !stored ||
      stored.periodId !== req.periodId ||
      stored.status !== "draft" ||
      stored.parkedReason !== null ||
      stored.netCents <= 0
    ) {
      miss = true;
      continue;
    }
    const lines = await readStoredLines(q, stored.id);
    if (!sameAsStored(args.data, { amountCents: Number(p.amount_cents) }, stored, linesHash(lines))) {
      miss = true;
      continue;
    }
    const check = await recheckSettlement(q, stored, lines);
    if (check.park !== null) {
      parks.push({ settlementId: stored.id, reason: check.park });
      continue;
    }
    const [driver] = await q.query<{ code: string }>(
      "SELECT code FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [stored.driverId],
    );
    items.push({
      proposalId: p.id,
      settlementId: stored.id,
      driverId: stored.driverId,
      driverCode: driver?.code ?? "",
      netCents: stored.netCents,
    });
  }
  if (miss || parks.length > 0) return { ok: false, category: "stale", parks };
  if (!checkBatch(items, req.proposalIds, req.totalCents)) return stale;
  // The approver line, on each paystub and on the total.
  const [member] = await q.query<{ role: string }>(
    "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  const line = flags.approverRole.adminAboveCents;
  if ((req.totalCents > line || items.some((i) => i.netCents > line)) && member?.role !== "admin") {
    return { ok: false, category: "role" };
  }
  items.sort((a, b) => (a.driverCode < b.driverCode ? -1 : a.driverCode > b.driverCode ? 1 : a.settlementId < b.settlementId ? -1 : 1));
  return { ok: true, items };
}

// The legs a confirm reserves now: the payout when payouts are on, and the bill legs only when
// accounting is on as well.
export function legsToReserve(): LegKind[] {
  if (!switchOn("payment")) return [];
  return switchOn("accounting") ? [...LEG_KINDS] : ["settlement_payout"];
}

export async function confirmBatch(
  db: TenantDb,
  session: Session,
  request: BatchRequest,
  now: Date,
  money: SettlementMoneyDeps = {},
): Promise<ConfirmResult> {
  if (!flags.settlementsEnabled || !flags.batchApproveEnabled) return { ok: false, category: "disabled" };
  const req = parseBatchRequest(request);
  if (!req || req.proposalIds.length > flags.batchLimits.maxItems) return { ok: false, category: "validation" };
  const tenantId = session.tenantId;
  const d = resolveDeps(money);
  const nowIso = now.toISOString();
  const batchId = randomUUID();

  const out = await db.withTenant(tenantId, async (q) => {
    await assertMembership(q, session);
    const checked = await checkItems(q, session, req);
    if (!checked.ok) return checked;
    const items = checked.items;
    const ids = uuidList(items.map((i) => i.proposalId));
    const settlementIds = uuidList(items.map((i) => i.settlementId));
    await q.execute(
      `INSERT INTO approval_batches (id, tenant_id, scope, period_id, item_ids, total_cents, legs_reserved,
                                     status, requested_by)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'settlements', CAST($2 AS uuid), CAST($3 AS uuid[]),
               $4, 0, 'confirmed', $5)`,
      [batchId, req.periodId, settlementIds, req.totalCents, session.sub],
    );
    const approved = await q.execute(
      `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
              batch_id = CAST($4 AS uuid), updated_at = CAST($3 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = ANY(CAST($1 AS uuid[])) AND status = 'proposed'`,
      [ids, session.sub, nowIso, batchId],
    );
    const executing = await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND batch_id = CAST($1 AS uuid) AND status = 'approved'`,
      [batchId, nowIso],
    );
    const paystubs = await q.execute(
      `UPDATE settlements SET status = 'approved'
        WHERE tenant_id = current_tenant_id() AND id = ANY(CAST($1 AS uuid[])) AND status = 'draft'
          AND parked_reason IS NULL`,
      [settlementIds],
    );
    // Every row is locked above, so anything but one row each means the database moved under us.
    if (approved !== items.length || executing !== items.length || paystubs !== items.length) {
      throw new Error("batch confirm lost its lock");
    }

    const legs = legsToReserve();
    let reserved = 0;
    if (legs.length > 0) {
      const approval = await approvalFrom(q, session);
      for (const item of items) {
        const party = { settlementId: item.settlementId, driverId: item.driverId, netCents: item.netCents };
        for (const kind of legs) {
          const r = await reserve(
            q,
            approval,
            legDraft(kind, party, { attempt: 1, proposalId: item.proposalId, batchId }),
            d.newActionId(),
          );
          if (r.created) reserved += 1;
          if (r.created && kind === "settlement_payout") await linkProposal(q, item.settlementId, r.action.id, now);
        }
      }
    }
    // One "would send" line for every leg not reserved, naming the switch that held it.
    for (const item of items) {
      for (const kind of LEG_KINDS) {
        if (legs.includes(kind)) continue;
        const flag = !switchOn("payment") ? "payoutsEnabled" : "accountingEnabled";
        d.log(
          `money: would send ${kind} ${item.netCents}c for settlements ${item.settlementId} via ` +
            `${systemFor(kind, d)} (${flag} off)`,
        );
      }
    }
    if (reserved === 0) {
      await q.execute(
        `UPDATE approval_batches SET status = 'done', legs_reserved = 0, finished_at = CAST($2 AS timestamptz),
                result = CAST($3 AS jsonb)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'confirmed'`,
        [batchId, nowIso, JSON.stringify({ sent: 0, confirmed: 0, failed: 0, unknown: 0, remaining: 0, notPaid: items.length })],
      );
      await q.execute(
        `UPDATE proposals SET status = 'done', decision_note = 'not_paid', updated_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND batch_id = CAST($1 AS uuid) AND status = 'executing'`,
        [batchId, nowIso],
      );
    } else {
      await q.execute(
        `UPDATE approval_batches SET legs_reserved = $2
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [batchId, reserved],
      );
    }
    return {
      ok: true as const,
      batchId,
      itemCount: items.length,
      totalCents: req.totalCents,
      legsReserved: reserved,
      status: reserved === 0 ? ("done" as const) : ("confirmed" as const),
    };
  });
  if (out.ok) return out;
  if (out.category === "role") return { ok: false, category: "role" };

  // Nothing was written. Park the drifted paystubs, then answer with the list as it stands now.
  return db.withTenant(tenantId, async (q) => {
    await assertMembership(q, session);
    for (const park of out.parks) {
      if ((await parkSettlement(q, park.settlementId, park.reason, now)) === 1) {
        // The waiting card for a parked paystub is retired; "Run the week" makes a new one.
        await q.execute(
          `UPDATE proposals SET status = 'expired', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                  decision_note = 'parked', updated_at = CAST($3 AS timestamptz)
            WHERE tenant_id = current_tenant_id() AND kind = 'settlement_approve'
              AND subject_id = CAST($1 AS uuid) AND status = 'proposed'`,
          [park.settlementId, session.sub, nowIso],
        );
      }
    }
    return { ok: false as const, category: "stale" as const, current: await readCleanSet(q, req.periodId) };
  });
}
