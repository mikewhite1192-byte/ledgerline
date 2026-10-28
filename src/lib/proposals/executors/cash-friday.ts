import { flags } from "../../../config/flags";
import { billDeferArgsSchema, parseArgsText } from "../../cash/args";
import type { Param, Queryable } from "../../db";
import type { Executor, ProposalResult } from "../execute";

// A person approved a Cash Friday card (design 3).
//
// bill_defer moves one vendor bill's date: the proposal row is locked first, then the bill. The
// bill must still be open, flexible and carry exactly the reference, amount and due date the card
// showed; anything else fails the proposal as stale and writes nothing else. On a match one UPDATE
// sets the bill deferred to the card's date with the proposal's id, and the proposal moves to done
// in the same transaction. A second approval of the same card finds it done and writes nothing.
//
// factoring_request and collections_chase are test mode until FACTORING and COLLECTIONS ship: the
// approval is recorded (the proposal moves to done with the note test_mode) and nothing else is
// written, sent or paid.
//
// The switch: cashFridayEnabled off refuses as not_executable before anything is read or written.
// No money moves here and nothing leaves the system.

const done = (proposalId: string): ProposalResult => ({
  ok: true,
  proposalId,
  status: "done",
  moneyActionId: null,
});

const refusal = (category: string): ProposalResult => ({ ok: false, category, retryable: false });

type Locked = { status: string; amount_cents: number | string; args: string; subject_id: string };

type BillRow = {
  bill_ref: string;
  amount_cents: number | string;
  due_on: string;
  urgency: string;
  status: string;
};

async function fail(q: Queryable, proposalId: string, category: string, nowIso: string): Promise<ProposalResult> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status IN ('approved', 'executing')`,
    [proposalId, category, nowIso],
  );
  console.warn(`cash friday ${proposalId} refused: ${category}`);
  return refusal(category);
}

async function one(q: Queryable, sql: string, params: Param[]): Promise<void> {
  const n = await q.execute(sql, params);
  if (n !== 1) throw new Error("a cash friday write did not change exactly one row");
}

async function lockProposal(q: Queryable, id: string, kind: string): Promise<Locked | null> {
  const rows = await q.query<Locked>(
    `SELECT status, amount_cents, CAST(args AS text) AS args, CAST(subject_id AS text) AS subject_id
       FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = $2
      FOR UPDATE`,
    [id, kind],
  );
  return rows.length === 1 ? rows[0] : null;
}

// approved -> executing -> done (the 0009 guard's path), with an optional note.
async function finish(q: Queryable, proposalId: string, status: string, nowIso: string, note: string | null) {
  if (status === "approved") {
    await one(
      q,
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [proposalId, nowIso],
    );
  }
  await one(
    q,
    `UPDATE proposals SET status = 'done', decision_note = COALESCE(CAST($3 AS text), decision_note),
            updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
    [proposalId, nowIso, note],
  );
}

const nowOf = (deps: Parameters<Executor>[4]) => (deps.clock ?? (() => new Date()))().toISOString();

export const executeBillDefer: Executor = async (db, session, proposal, _opts, deps) => {
  if (!flags.cashFridayEnabled) return refusal("not_executable");
  if (proposal.kind !== "bill_defer") return refusal("not_executable");
  const nowIso = nowOf(deps);
  return db.withTenant(session.tenantId, async (q) => {
    const row = await lockProposal(q, proposal.id, "bill_defer");
    if (!row) return refusal("not_found");
    if (row.status === "done") return done(proposal.id);
    if (row.status !== "approved" && row.status !== "executing") return refusal("already_decided");

    const parsed = billDeferArgsSchema.safeParse(parseArgsText(row.args));
    if (!parsed.success || parsed.data.billId !== row.subject_id) return fail(q, proposal.id, "not_executable", nowIso);
    const args = parsed.data;

    const bills = await q.query<BillRow>(
      `SELECT bill_ref, amount_cents, to_char(due_on, 'YYYY-MM-DD') AS due_on, urgency, status
         FROM vendor_bills
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        FOR UPDATE`,
      [args.billId],
    );
    const bill = bills[0];
    if (
      !bill ||
      bill.status !== "open" ||
      bill.urgency !== "flexible" ||
      bill.bill_ref !== args.billRef ||
      Number(bill.amount_cents) !== args.amountCents ||
      Number(row.amount_cents) !== args.amountCents ||
      bill.due_on !== args.dueOn ||
      !(args.deferredTo > args.dueOn)
    ) {
      return fail(q, proposal.id, "stale", nowIso);
    }

    await one(
      q,
      `UPDATE vendor_bills
          SET status = 'deferred', deferred_to = CAST($2 AS date), proposal_id = CAST($3 AS uuid)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'open'
          AND urgency = 'flexible' AND amount_cents = $4 AND due_on = CAST($5 AS date)`,
      [args.billId, args.deferredTo, proposal.id, args.amountCents, args.dueOn],
    );
    await finish(q, proposal.id, row.status, nowIso, null);
    console.info(`cash friday ${proposal.id} bill deferred`);
    return done(proposal.id);
  });
};

// factoring_request and collections_chase: the decision is recorded, nothing else is written.
function testModeExecutor(kind: "factoring_request" | "collections_chase"): Executor {
  return async (db, session, proposal, _opts, deps) => {
    if (!flags.cashFridayEnabled) return refusal("not_executable");
    if (proposal.kind !== kind) return refusal("not_executable");
    const nowIso = nowOf(deps);
    return db.withTenant(session.tenantId, async (q) => {
      const row = await lockProposal(q, proposal.id, kind);
      if (!row) return refusal("not_found");
      if (row.status === "done") return done(proposal.id);
      if (row.status !== "approved" && row.status !== "executing") return refusal("already_decided");
      await finish(q, proposal.id, row.status, nowIso, "test_mode");
      console.info(`cash friday ${proposal.id} recorded in test mode`);
      return done(proposal.id);
    });
  };
}

export const executeFactoringTestMode: Executor = testModeExecutor("factoring_request");
export const executeChaseTestMode: Executor = testModeExecutor("collections_chase");
