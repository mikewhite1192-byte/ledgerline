import { flags } from "../../config/flags";
import { CLEAN_SQL } from "../agent/proposals/clean";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { executeProposal, type ExecuteDeps, type ProposalResult } from "../proposals/execute";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";

// Approve all clean (design 3.5, Discord tip 4): one deliberate approval over the list the person
// saw. The server re-checks every proposal under lock: each must still be one of this run's
// fixes and clean, and the total must be the one the button showed. Any difference refuses the
// whole batch and answers with what is clean now, so the person confirms what they actually saw.
// Then each proposal goes through the same gate and executor as a single approve, one by one; a
// refusal on one (role, stale) never undoes the others. The batch id is the dedupe key: a replay
// answers with the stored result and never executes twice.

export type ApproveCleanInput = { batchId: string; proposalIds: string[]; totalCents: number };

export type BatchOutcome = { proposalId: string; ok: boolean; category: string | null };

export type ApproveCleanResult =
  | { ok: true; batchId: string; done: number; refused: BatchOutcome[]; replay: boolean }
  | { ok: false; category: "changed"; clean: string[]; totalCents: number }
  | { ok: false; category: "disabled" | "bad_request" | "not_found" | "role" | "batch_taken" };

export type ApproveCleanDeps = {
  db?: TenantDb;
  clock?: () => Date;
  execute?: (session: Session, proposalId: string, deps: ExecuteDeps) => Promise<ProposalResult>;
};

export function parseApproveClean(body: unknown): ApproveCleanInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const ids = b.proposalIds;
  const max = flags.approveAllLimits.maxItems;
  if (!isUuid(b.batchId)) return null;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > max || !ids.every(isUuid)) return null;
  const lower = ids.map((i) => (i as string).toLowerCase());
  if (new Set(lower).size !== lower.length) return null;
  const total = b.totalCents;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || total >= 1_000_000_000) return null;
  return { batchId: (b.batchId as string).toLowerCase(), proposalIds: [...lower].sort(), totalCents: total };
}

type Batch = { status: string; result: string | null; item_ids: string; requested_by: string };

type Clean = { id: string; amount_cents: number | string };

// This run's clean fixes right now, locked until the transaction ends.
async function cleanNow(q: Queryable, runId: string): Promise<Clean[]> {
  return q.query<Clean>(
    `SELECT p.id, p.amount_cents
       FROM proposals p
      WHERE p.kind = 'pay_correction'
        AND p.id IN (SELECT i.proposal_id FROM sweep_items i
                      WHERE i.seen_run_id = CAST($1 AS uuid) AND i.kind = 'fix' AND i.proposal_id IS NOT NULL)
        AND ${CLEAN_SQL}
      ORDER BY p.id
      FOR UPDATE OF p`,
    [runId],
  );
}

function parseResult(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function storedAnswer(batchId: string, b: Batch): ApproveCleanResult | null {
  const r = parseResult(b.result);
  if (!r) return null;
  if (b.status === "refused" && r.category === "role") return { ok: false, category: "role" };
  if (b.status === "refused") {
    return {
      ok: false,
      category: "changed",
      clean: Array.isArray(r.clean) ? (r.clean as string[]) : [],
      totalCents: typeof r.totalCents === "number" ? r.totalCents : 0,
    };
  }
  if (b.status === "done") {
    return {
      ok: true,
      batchId,
      done: typeof r.done === "number" ? r.done : 0,
      refused: Array.isArray(r.refused) ? (r.refused as BatchOutcome[]) : [],
      replay: true,
    };
  }
  return null;
}

export async function approveClean(
  session: Session,
  runId: string,
  input: ApproveCleanInput,
  deps: ApproveCleanDeps = {},
): Promise<ApproveCleanResult> {
  if (!flags.sweepEnabled) return { ok: false, category: "disabled" };
  if (!isUuid(runId)) return { ok: false, category: "bad_request" };
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? (() => new Date());
  const execute = deps.execute ?? ((s, id, d) => executeProposal(s, id, { confirmed: false }, d));
  const run = runId.toLowerCase();

  type Gate = { answer: ApproveCleanResult } | { ids: string[] };
  const gate = await db.withTenant(session.tenantId, async (q): Promise<Gate> => {
    await assertMembership(q, session);
    const runs = await q.query<{ period_id: string }>(
      "SELECT period_id FROM sweep_runs WHERE id = CAST($1 AS uuid)",
      [run],
    );
    if (runs.length !== 1) return { answer: { ok: false, category: "not_found" } };
    const nowIso = clock().toISOString();
    const inserted = await q.query<{ id: string }>(
      `INSERT INTO approval_batches (id, tenant_id, scope, period_id, item_ids, total_cents, status,
                                     requested_by, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'proposals', CAST($2 AS uuid), CAST($3 AS uuid[]),
               $4, 'reserved', $5, CAST($6 AS timestamptz))
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [input.batchId, runs[0].period_id, `{${input.proposalIds.join(",")}}`, input.totalCents, session.sub, nowIso],
    );
    if (inserted.length !== 1) {
      const rows = await q.query<Batch>(
        `SELECT status, CAST(result AS text) AS result, array_to_string(item_ids, ',') AS item_ids, requested_by
           FROM approval_batches WHERE id = CAST($1 AS uuid) AND scope = 'proposals' FOR UPDATE`,
        [input.batchId],
      );
      // Another carrier's batch (row security hides it), another scope or another person's:
      // never ours to replay.
      const batch = rows[0];
      if (!batch || batch.requested_by !== session.sub) return { answer: { ok: false, category: "batch_taken" } };
      const stored = storedAnswer(input.batchId, batch);
      if (stored) return { answer: stored };
      // A batch left reserved by a request that stopped part way: carry on with its own list,
      // which the person already confirmed.
      if (batch.status === "reserved") return { ids: batch.item_ids.split(",").map((i) => i.toLowerCase()).sort() };
      return { answer: { ok: false, category: "batch_taken" } };
    }

    const clean = await cleanNow(q, run);
    const cleanIds = new Set(clean.map((c) => c.id.toLowerCase()));
    const sum = clean
      .filter((c) => input.proposalIds.includes(c.id.toLowerCase()))
      .reduce((n, c) => n + Number(c.amount_cents), 0);
    const member = await q.query<{ role: string }>("SELECT role FROM memberships WHERE cognito_sub = $1", [session.sub]);
    const allClean = input.proposalIds.every((id) => cleanIds.has(id));
    const nowTotal = clean.reduce((n, c) => n + Number(c.amount_cents), 0);
    if (!allClean || sum !== input.totalCents) {
      const result = { category: "changed", clean: [...cleanIds].sort(), totalCents: nowTotal };
      await q.execute(
        `UPDATE approval_batches SET status = 'refused', result = CAST($2 AS jsonb), finished_at = CAST($3 AS timestamptz)
          WHERE id = CAST($1 AS uuid)`,
        [input.batchId, JSON.stringify(result), nowIso],
      );
      return { answer: { ok: false, category: "changed", clean: result.clean, totalCents: nowTotal } };
    }
    // Mike's rule (D-024): a batch whose total is above the admin line needs an admin, even when
    // each fix alone is under it.
    if (input.totalCents > flags.approverRole.adminAboveCents && member[0]?.role !== "admin") {
      const result = { category: "role" };
      await q.execute(
        `UPDATE approval_batches SET status = 'refused', result = CAST($2 AS jsonb), finished_at = CAST($3 AS timestamptz)
          WHERE id = CAST($1 AS uuid)`,
        [input.batchId, JSON.stringify(result), nowIso],
      );
      return { answer: { ok: false, category: "role" } };
    }
    await q.execute(
      `UPDATE proposals SET batch_id = CAST($1 AS uuid)
        WHERE id = ANY(CAST($2 AS uuid[])) AND status = 'proposed' AND batch_id IS NULL`,
      [input.batchId, `{${input.proposalIds.join(",")}}`],
    );
    return { ids: input.proposalIds };
  });
  if ("answer" in gate) {
    if (!gate.answer.ok && gate.answer.category === "role") console.info(`sweep batch ${input.batchId} refused=role`);
    return gate.answer;
  }

  // Each proposal through the one gate and its executor, in id order. One refusal never stops
  // or undoes the rest.
  const refused: BatchOutcome[] = [];
  let done = 0;
  for (const id of gate.ids) {
    const already = await db.withTenant(session.tenantId, (q) =>
      q.query<{ status: string }>(
        "SELECT status FROM proposals WHERE id = CAST($1 AS uuid) AND batch_id = CAST($2 AS uuid)",
        [id, input.batchId],
      ),
    );
    if (already[0]?.status === "done") {
      done += 1;
      continue;
    }
    const result = await execute(session, id, { db, clock });
    if (result.ok && result.status === "done") done += 1;
    else refused.push({ proposalId: id, ok: false, category: result.ok ? result.status : result.category });
  }
  const result = { done, refused };
  await db.withTenant(session.tenantId, (q) =>
    q.execute(
      `UPDATE approval_batches SET status = 'done', result = CAST($2 AS jsonb), finished_at = CAST($3 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status = 'reserved'`,
      [input.batchId, JSON.stringify(result), clock().toISOString()],
    ),
  );
  console.info(`sweep batch ${input.batchId} done=${done} refused=${refused.length}`);
  return { ok: true, batchId: input.batchId, done, refused, replay: false };
}
