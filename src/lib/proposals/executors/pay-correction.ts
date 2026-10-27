import { flags } from "../../../config/flags";
import type { Session } from "../../auth/claims";
import { readRowsWhereId, readTenant } from "../../data/read";
import type { Queryable, TenantDb } from "../../db";
import { reasonSentence } from "../../agent/reasons";
import { assertMembership } from "../../tenant/context";
import { isWithin, localDateOf, type LocalDate } from "../../time/local-date";
import { isUuid } from "../../uuid";
import type {
  ApproveOptions,
  ExecuteDeps,
  Executor,
  Precheck,
  ProposalRefused,
  ProposalResult,
  ProposalRow,
} from "../execute";

// The pay_correction executor (design 3.4). The gate in execute.ts checks the person, the age,
// the role, the auditor and the confirm, then asks precheckPayCorrection below while the proposal
// is still proposed and locked: when the facts in b. no longer hold, the approval is refused as
// "stale", the proposal stays waiting (a person may reject it) and nothing is written. Only then
// does the gate move it to approved. Here, in one transaction under the tenant's row-level
// security:
//   a. re-read the proposal FOR UPDATE: approved or executing (a resume), kind pay_correction,
//      and args that still say what the row says (driver, signed cents, direction);
//   b. re-check the facts the gateway checked, because time passed: the week is still open, the
//      driver's settlement in it is absent or a draft, the amount is inside the limit and the
//      corrected pay item (if any) is still unsettled. The precheck asked the same moments ago,
//      but the gate's transaction has committed since, so a week closed or a pay run approved in
//      between is caught here. Any failure marks the proposal failed with the note "stale" (the
//      status guard allows approved -> failed, never approved -> rejected) and nothing is
//      written. A correction never lands on a settled week;
//   c. approved -> executing;
//   d. one pay item, keyed item_ref = 'correction:<proposal id>' (ON CONFLICT DO NOTHING, read
//      back, so a resume finds the row and never writes a second): a reimbursement for a positive
//      delta, a deduction for a negative one, dated today in the tenant's zone clamped into the
//      week, subkind "correction" (the paystub line reads "Reimbursement (correction)");
//   e. executing -> done.
// Money never moves here: the next pay run picks the item up like any other.

export const CORRECTION_SUBKIND = "correction";

export const correctionItemRef = (proposalId: string) => `correction:${proposalId}`;

type Row = {
  id: string;
  kind: string;
  status: string;
  subject_id: string;
  amount_cents: number | string;
  direction: string;
  args: string;
};

type Args = {
  driverId: string;
  periodId: string;
  payItemId: string | null;
  deltaCents: number;
  reasonCategories: string[];
};

const refused = (category: string): ProposalRefused => ({ ok: false, category, retryable: false });

// The stored args, read whole. Anything off shape is a proposal the executor will not apply.
function argsOf(text: string): Args | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  return argsFrom(v);
}

function argsFrom(v: unknown): Args | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  const delta = a.deltaCents;
  if (typeof a.driverId !== "string" || !isUuid(a.driverId)) return null;
  if (typeof a.periodId !== "string" || !isUuid(a.periodId)) return null;
  if (a.payItemId !== undefined && (typeof a.payItemId !== "string" || !isUuid(a.payItemId))) return null;
  if (typeof delta !== "number" || !Number.isSafeInteger(delta) || delta === 0) return null;
  const reasons = Array.isArray(a.reasonCategories)
    ? a.reasonCategories.filter((c): c is string => typeof c === "string")
    : [];
  return {
    driverId: a.driverId.toLowerCase(),
    periodId: a.periodId.toLowerCase(),
    payItemId: typeof a.payItemId === "string" ? a.payItemId.toLowerCase() : null,
    deltaCents: delta,
    reasonCategories: reasons,
  };
}

// The args say what the row says: the same driver, the same whole cents, and the direction their
// sign gives.
function argsMatchRow(a: Args | null, subjectId: string, amountCents: number, direction: string): a is Args {
  return (
    a !== null &&
    a.driverId === subjectId.toLowerCase() &&
    Math.abs(a.deltaCents) === amountCents &&
    direction === (a.deltaCents < 0 ? "in" : "out")
  );
}

// True when every fact the gateway checked still holds.
async function factsHold(q: Queryable, a: Args): Promise<{ ok: true; start: LocalDate; end: LocalDate } | { ok: false }> {
  const max = flags.gatewayLimits.payCorrectionMaxCents;
  if (!Number.isSafeInteger(max) || max <= 0 || Math.abs(a.deltaCents) > max) return { ok: false };
  const [period] = await readRowsWhereId(q, "settlement_periods", "id", a.periodId);
  if (!period || period.status !== "open") return { ok: false };
  const settlements = await readRowsWhereId(q, "settlements", "period_id", a.periodId);
  if (settlements.some((s) => s.driver_id === a.driverId && s.status !== "draft")) return { ok: false };
  if (a.payItemId) {
    const [item] = await readRowsWhereId(q, "pay_items", "id", a.payItemId);
    const window = { start: period.period_start, end: period.period_end };
    if (!item || item.driver_id !== a.driverId || item.settlement_id !== null) return { ok: false };
    if (!isWithin(item.item_date, window)) return { ok: false };
  }
  return { ok: true, start: period.period_start, end: period.period_end };
}

const clampDate = (d: LocalDate, start: LocalDate, end: LocalDate): LocalDate =>
  d < start ? start : d > end ? end : d;

async function finish(q: Queryable, id: string, from: string, nowIso: string): Promise<void> {
  if (from === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status = 'approved'`,
      [id, nowIso],
    );
  }
  const n = await q.execute(
    `UPDATE proposals SET status = 'done', updated_at = CAST($2 AS timestamptz)
      WHERE id = CAST($1 AS uuid) AND status = 'executing'`,
    [id, nowIso],
  );
  if (n !== 1) throw new Error("the correction's proposal did not move to done");
}

async function apply(q: Queryable, session: Session, proposalId: string, now: Date): Promise<ProposalResult> {
  await assertMembership(q, session);
  const rows = await q.query<Row>(
    `SELECT id, kind, status, subject_id, amount_cents, direction, CAST(args AS text) AS args
       FROM proposals WHERE id = CAST($1 AS uuid) FOR UPDATE`,
    [proposalId],
  );
  if (rows.length !== 1) return refused("not_found");
  const p = rows[0];
  if (p.kind !== "pay_correction") return refused("not_executable");
  if (p.status === "done") return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
  if (p.status !== "approved" && p.status !== "executing") return refused("already_decided");
  const nowIso = now.toISOString();
  const a = argsOf(p.args);
  const whole = argsMatchRow(a, p.subject_id, Number(p.amount_cents), p.direction);
  const itemRef = correctionItemRef(p.id);

  // A resume after the item landed: finish the status and write nothing.
  const landed = await q.query<{ id: string }>(
    "SELECT id FROM pay_items WHERE tenant_id = current_tenant_id() AND item_ref = $1",
    [itemRef],
  );
  if (landed.length === 1) {
    await finish(q, p.id, p.status, nowIso);
    return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
  }

  const facts = whole && a ? await factsHold(q, a) : { ok: false as const };
  if (!whole || !a || !facts.ok) {
    await q.execute(
      `UPDATE proposals SET status = 'failed', decision_note = 'stale', updated_at = CAST($2 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status IN ('approved', 'executing')`,
      [p.id, nowIso],
    );
    console.info(`proposal ${p.id} pay_correction refused=stale`);
    return refused("stale");
  }

  if (p.status === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status = 'approved'`,
      [p.id, nowIso],
    );
  }
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant row");
  const itemDate = clampDate(localDateOf(nowIso, tenant.timezone), facts.start, facts.end);
  const reason = reasonSentence(a.reasonCategories[0] ?? "");
  const description = `Correction: ${reason} (proposal ${p.id.slice(0, 8)})`;
  await q.execute(
    `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date,
                           ref_table, ref_id, item_ref, description)
     VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), $2, $3, $4,
             CAST($5 AS date), 'proposals', CAST($6 AS uuid), $7, $8)
     ON CONFLICT (tenant_id, item_ref) DO NOTHING`,
    [
      a.driverId,
      a.deltaCents > 0 ? "reimbursement" : "other_deduction",
      CORRECTION_SUBKIND,
      Math.abs(a.deltaCents),
      itemDate,
      p.id,
      itemRef,
      description,
    ],
  );
  const back = await q.query<{ id: string }>(
    "SELECT id FROM pay_items WHERE tenant_id = current_tenant_id() AND item_ref = $1",
    [itemRef],
  );
  if (back.length !== 1) throw new Error("the correction's pay item did not read back");
  await finish(q, p.id, "executing", nowIso);
  console.info(`proposal ${p.id} pay_correction done item=${back[0].id}`);
  return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
}

// The gate's early refusal (see Precheck in execute.ts): inside the gate's transaction, with the
// proposal still proposed and locked. Reads only. A correction whose facts no longer hold is
// refused as stale and stays waiting, never approved and then failed.
export const precheckPayCorrection: Precheck = async (q, proposal: ProposalRow) => {
  if (proposal.kind !== "pay_correction") return refused("not_executable");
  const a = argsFrom(proposal.args);
  const facts = argsMatchRow(a, proposal.subjectId, proposal.amountCents, proposal.direction)
    ? await factsHold(q, a)
    : { ok: false as const };
  if (facts.ok) return null;
  console.info(`proposal ${proposal.id} pay_correction precheck=stale`);
  return refused("stale");
};

async function runPayCorrection(
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  _opts: ApproveOptions,
  deps: ExecuteDeps,
): Promise<ProposalResult> {
  const now = (deps.clock ?? (() => new Date()))();
  return db.withTenant(session.tenantId, (q) => apply(q, session, proposal.id, now));
}

export const payCorrectionExecutor: Executor = Object.assign(runPayCorrection, { precheck: precheckPayCorrection });
