import { z } from "zod";
import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import { readReceivablesInput, readTenant } from "../data/read";
import { paymentPostedOutside } from "./posted-outside";
import type { Executor, ProposalResult, ProposalRow } from "../proposals/execute";
import { findPaymentOnWrongInvoice } from "../rules-engine";
import { localDateOf } from "../time/local-date";
import { refreshInvoiceStatus } from "./apply";
import { matchWrongInvoiceFinding, type ReapplyIds } from "./match";

// The payment_reapply executor: a person approved moving one payment application from the invoice
// it sits on to the open invoice the rules engine says it was meant for. Everything happens in one
// tenant transaction with the proposal, the payment, the application and both invoices locked: the
// engine's finding is re-run on the rows as they are now and must still name exactly these four
// records, or nothing moves (stale). A payment already posted to QuickBooks, or with a post
// reserved, sent or not yet known (a customer_payment ledger row that is not failed), is refused
// (posted_outside): moving it here alone would leave the two books disagreeing, so a person moves
// it there by hand. No money moves and nothing outside is called, so there is no ledger row. With
// the customer payments switch off nothing runs and the proposal stays approved.
//
// The same approval twice changes one application: the second run finds the proposal done.

const Args = z.strictObject({
  paymentId: z.uuid(),
  applicationId: z.uuid(),
  fromInvoiceId: z.uuid(),
  toInvoiceId: z.uuid(),
  amountCents: z.int().positive(),
});

type ProposalState = { status: string; decision_note: string | null };

const failed = (category: string): ProposalResult => ({ ok: false, category, retryable: false });

async function failApproved(q: Queryable, proposalId: string, note: string): Promise<ProposalResult> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
    [proposalId, note],
  );
  return failed(note);
}

async function lockRows(q: Queryable, ids: ReapplyIds) {
  const [payment] = await q.query<{ id: string; customer_id: string; qbo_id: string | null }>(
    `SELECT id, customer_id, qbo_id FROM customer_payments
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [ids.paymentId],
  );
  const [application] = await q.query<{
    id: string;
    payment_id: string;
    invoice_id: string;
    amount_cents: number | string;
  }>(
    `SELECT id, payment_id, invoice_id, amount_cents FROM payment_applications
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [ids.applicationId],
  );
  // Both invoices in one statement, in id order, so two moves never lock them crosswise.
  const invoices = await q.query<{ id: string; customer_id: string; status: string }>(
    `SELECT id, customer_id, status FROM invoices
      WHERE tenant_id = current_tenant_id() AND id IN (CAST($1 AS uuid), CAST($2 AS uuid))
      ORDER BY id FOR UPDATE`,
    [ids.fromInvoiceId, ids.toInvoiceId],
  );
  return { payment, application, invoices };
}

async function move(
  q: Queryable,
  proposal: ProposalRow,
  ids: ReapplyIds & { amountCents: number },
  now: Date,
): Promise<ProposalResult> {
  const { payment, application, invoices } = await lockRows(q, ids);
  if (!payment || !application || invoices.length !== 2 || ids.fromInvoiceId === ids.toInvoiceId) {
    return failApproved(q, proposal.id, "stale");
  }
  if (await paymentPostedOutside(q, payment)) return failApproved(q, proposal.id, "posted_outside");
  const amountCents = Number(application.amount_cents);
  if (
    application.payment_id !== ids.paymentId ||
    application.invoice_id !== ids.fromInvoiceId ||
    amountCents !== proposal.amountCents ||
    amountCents !== ids.amountCents ||
    invoices.some((i) => i.customer_id !== payment.customer_id || i.status === "void")
  ) {
    return failApproved(q, proposal.id, "stale");
  }
  const tenant = await readTenant(q);
  if (!tenant) return failApproved(q, proposal.id, "stale");
  const input = await readReceivablesInput(q, localDateOf(now.toISOString(), tenant.timezone));
  const finding = matchWrongInvoiceFinding(findPaymentOnWrongInvoice(input), ids);
  if (!finding || finding.amountCents !== amountCents) return failApproved(q, proposal.id, "stale");

  // The payment may already sit on the target invoice: fold this application into that one.
  const [onTarget] = await q.query<{ id: string }>(
    `SELECT id FROM payment_applications
      WHERE tenant_id = current_tenant_id() AND payment_id = CAST($1 AS uuid)
        AND invoice_id = CAST($2 AS uuid) FOR UPDATE`,
    [ids.paymentId, ids.toInvoiceId],
  );
  if (onTarget) {
    const merged = await q.execute(
      `UPDATE payment_applications SET amount_cents = amount_cents + $2
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [onTarget.id, amountCents],
    );
    const removed = await q.execute(
      `DELETE FROM payment_applications WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [ids.applicationId],
    );
    if (merged !== 1 || removed !== 1) throw new Error("payment move lost its lock");
  } else {
    const moved = await q.execute(
      `UPDATE payment_applications SET invoice_id = CAST($2 AS uuid)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
          AND invoice_id = CAST($3 AS uuid)`,
      [ids.applicationId, ids.toInvoiceId, ids.fromInvoiceId],
    );
    if (moved !== 1) throw new Error("payment move lost its lock");
  }
  await refreshInvoiceStatus(q, ids.fromInvoiceId);
  await refreshInvoiceStatus(q, ids.toInvoiceId);

  // The guard allows approved to executing to done; both steps land with the move or not at all.
  const started = await q.execute(
    `UPDATE proposals SET status = 'executing', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
    [proposal.id],
  );
  const done = await q.execute(
    `UPDATE proposals SET status = 'done', updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
    [proposal.id],
  );
  if (started !== 1 || done !== 1) throw new Error("payment move lost its lock");
  return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: null };
}

export const executePaymentReapply: Executor = async (db, session, proposal, _opts, deps) => {
  if (!flags.customerPaymentsEnabled) return failed("disabled");
  const now = (deps.clock ?? (() => new Date()))();
  return db.withTenant(session.tenantId, async (q) => {
    const [p] = await q.query<ProposalState>(
      `SELECT status, decision_note FROM proposals
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
      [proposal.id],
    );
    if (!p) return failed("not_found");
    if (p.status === "done") {
      return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: null };
    }
    if (p.status === "failed") return failed(p.decision_note ?? "failed");
    // The move commits approved, executing and done together, so executing is never left behind
    // by this executor; anything but approved here is not ours to touch.
    if (p.status !== "approved") return failed("unknown");
    const parsed = Args.safeParse(proposal.args);
    if (
      !parsed.success ||
      proposal.subjectTable !== "payment_applications" ||
      proposal.subjectId !== parsed.data.applicationId
    ) {
      return failApproved(q, proposal.id, "validation");
    }
    return move(q, proposal, parsed.data, now);
  });
};
