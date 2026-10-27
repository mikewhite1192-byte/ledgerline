import { randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import type { Queryable } from "../../db";
import {
  chargeArgsSchema,
  chargeMatches,
  detentionChargeOf,
  detentionDescription,
  readDetentionChargeRows,
  type DetentionChargeRefusal,
} from "../../data/detention-charge";
import { readRowsWhereId } from "../../data/read";
import { loadsOf } from "../../data/records";
import { invoiceAmount } from "../../rules-engine";
import type { Executor, ProposalResult } from "../execute";

// A person approved a detention_charge: add the detention to the load and to its open invoice,
// both in one tenant transaction, or neither.
//
// The proposal row is locked first, then the load and its invoice, so two approvals of the same
// proposal run one after the other: the second finds it done and writes nothing. Then the engine
// recomputes the charge from the rows as they are now and every stored figure must match it: the
// stop instants, minutes, quarters and cents, the customer's terms, the invoice and its amount
// before. Anything that moved since the proposal fails it as stale; an invoice that is no longer
// open or was posted to accounting fails it as invoice_posted. Both refusals write nothing but the
// proposal's own move to failed. On a match it inserts one detention accessorial carrying the
// proposal's id (a partial unique index allows one per proposal), raises the invoice by exactly
// the charge (guarded on its old amount, open status and no accounting id), checks the new amount
// against the engine's total read back from the rows, and moves the proposal to done. A mismatch
// at that point throws, so the transaction rolls back and nothing stays written.
//
// The switch: detentionEnabled off refuses as not_executable before anything is read or written.
// No money moves here and nothing leaves the system; the invoice reaches accounting only through
// its own later posting.

const done = (proposalId: string): ProposalResult => ({
  ok: true,
  proposalId,
  status: "done",
  moneyActionId: null,
});

const refusal = (category: string): ProposalResult => ({ ok: false, category, retryable: false });

const STALE: Readonly<Record<DetentionChargeRefusal, string>> = {
  no_detention: "stale",
  already_billed: "stale",
  no_invoice: "stale",
  invoice_mismatch: "stale",
  invoice_posted: "invoice_posted",
};

type Locked = { status: string; amount_cents: number | string; args: string };

// A permanent refusal: the proposal fails with the category as its note. Nothing else is written.
async function fail(q: Queryable, proposalId: string, category: string, nowIso: string): Promise<ProposalResult> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status IN ('approved', 'executing')`,
    [proposalId, category, nowIso],
  );
  console.warn(`detention charge ${proposalId} refused: ${category}`);
  return refusal(category);
}

async function one(q: Queryable, sql: string, params: (string | number)[]): Promise<void> {
  const n = await q.execute(sql, params);
  if (n !== 1) throw new Error("a detention charge write did not change exactly one row");
}

export const executeDetentionCharge: Executor = async (db, session, proposal, _opts, deps) => {
  if (!flags.detentionEnabled) return refusal("not_executable");
  if (proposal.kind !== "detention_charge") return refusal("not_executable");
  const nowIso = (deps.clock ?? (() => new Date()))().toISOString();
  return db.withTenant(session.tenantId, async (q) => {
    const locked = await q.query<Locked>(
      `SELECT status, amount_cents, CAST(args AS text) AS args FROM proposals
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'detention_charge'
        FOR UPDATE`,
      [proposal.id],
    );
    if (locked.length !== 1) return refusal("not_found");
    const row = locked[0];
    // Already written by an earlier run of this same approval: nothing to do again.
    if (row.status === "done") return done(proposal.id);
    if (row.status !== "approved" && row.status !== "executing") return refusal("already_decided");

    let raw: unknown;
    try {
      raw = JSON.parse(row.args);
    } catch {
      raw = null;
    }
    const parsed = chargeArgsSchema.safeParse(raw);
    if (!parsed.success || parsed.data.loadId !== proposal.subjectId) {
      return fail(q, proposal.id, "not_executable", nowIso);
    }
    const args = parsed.data;

    // Row locks on the load and its invoice before anything is read from them.
    await q.query(
      "SELECT id FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE",
      [args.loadId],
    );
    await q.query(
      "SELECT id FROM invoices WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid) FOR UPDATE",
      [args.loadId],
    );
    const rows = await readDetentionChargeRows(q, args.loadId);
    if (!rows) return fail(q, proposal.id, "stale", nowIso);
    const check = detentionChargeOf(rows);
    if (!check.ok) return fail(q, proposal.id, STALE[check.reason], nowIso);
    const charge = check.charge;
    if (!chargeMatches(args, charge) || Number(row.amount_cents) !== charge.amountCents) {
      return fail(q, proposal.id, "stale", nowIso);
    }

    const seqs = await q.query<{ next: number | string }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM load_accessorials
        WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid) AND kind = 'detention'`,
      [charge.loadId],
    );
    await one(
      q,
      `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, paid_by_driver,
         description, proposal_id)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'detention', $3, $4, false, $5,
         CAST($6 AS uuid))`,
      [
        randomUUID(),
        charge.loadId,
        Number(seqs[0]?.next ?? 1),
        charge.amountCents,
        detentionDescription(charge.stops),
        proposal.id,
      ],
    );
    const raised = await q.query<{ amount_cents: number | string }>(
      `UPDATE invoices SET amount_cents = amount_cents + $3
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND amount_cents = $2
          AND status = 'open' AND qbo_id IS NULL
        RETURNING amount_cents`,
      [charge.invoiceId, charge.invoiceAmountBeforeCents, charge.amountCents],
    );
    if (raised.length !== 1) throw new Error("the invoice changed under its lock");
    // The new invoice amount must be the engine's total for the load read back from the rows.
    const accessorials = await readRowsWhereId(q, "load_accessorials", "load_id", charge.loadId);
    const [record] = loadsOf([rows.load], rows.miles, accessorials);
    const engine = invoiceAmount(record);
    const after = Number(raised[0].amount_cents);
    if (!engine.ok || engine.amountCents !== after || after !== charge.invoiceAmountAfterCents) {
      throw new Error("the invoice total does not match the engine after the charge");
    }

    if (row.status === "approved") {
      await one(
        q,
        `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
        [proposal.id, nowIso],
      );
    }
    await one(
      q,
      `UPDATE proposals SET status = 'done', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
      [proposal.id, nowIso],
    );
    console.info(`detention charge ${proposal.id} done cents=${charge.amountCents}`);
    return done(proposal.id);
  });
};
