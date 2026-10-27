import { randomUUID } from "node:crypto";
import { z } from "zod";
import { accountingAdapter } from "../adapters";
import type {
  AccountingAdapter,
  InvoiceEmailStatus,
  InvoiceLine as AdapterInvoiceLine,
} from "../adapters/types";
import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { loadsOf } from "../data/records";
import { readRowsWhereId, readTenant } from "../data/read";
import { executeMoneyAction, type ExecuteResult, type MoneyDeps } from "../money/execute";
import type { ReconcileHooks } from "../money/reconcile";
import { MoneyError, type MoneyAction } from "../money/types";
import type { ExecuteDeps, Executor, ProposalResult, ProposalRow } from "../proposals/execute";
import { invoiceAmount, type InvoiceLine } from "../rules-engine";
import { addDays, localDateOf, type LocalDate } from "../time/local-date";
import { invoiceNumberOf, invoicePrefixOf, nextInvoiceNumber } from "./number";
import { lineSummary, sameLines, type LineSummary } from "./queue";

// The invoice_post executor: a person approved the engine's invoice for one delivered load. In one
// tenant transaction, with the proposal and the load locked, it re-runs the rules engine, refuses a
// total that moved since the card was made (stale), and otherwise writes the invoice (numbered,
// issued today in the carrier's zone, due at the customer's terms), marks the load invoiced and
// moves the proposal to executing. The invoice row and the executing status land together, so a
// second approval that races this one finds the proposal executing and only resumes the post.
//
// Then the post to the accounting system goes through the money executor with the invoice's
// ledger key (invoice:<invoice id>:<attempt>), so the same invoice is posted at most once per
// attempt. accountingEnabled off: nothing is reserved, the executor logs what it would send, and
// the proposal ends done with decision_note 'not_posted' (the invoice exists here; posting is a
// button once the switch is on). An outcome nobody confirmed leaves the proposal executing and the
// ledger row unknown until a read-back settles it.

export const LINE_WORDS: Readonly<Record<InvoiceLine["kind"], string>> = {
  linehaul: "Linehaul",
  fuel_surcharge: "Fuel surcharge",
  detention: "Detention",
  layover: "Layover",
  stop: "Extra stop",
  lumper: "Lumper",
};

// Taken from LINE_WORDS, so a kind added there is accepted here and the two never drift apart.
const LINE_KINDS = Object.keys(LINE_WORDS) as [InvoiceLine["kind"], ...InvoiceLine["kind"][]];

const Args = z.object({
  loadId: z.uuid(),
  loadNumber: z.string().min(1).max(40),
  amountCents: z.int().positive(),
  lines: z
    .array(z.strictObject({ kind: z.enum(LINE_KINDS), amountCents: z.int().nonnegative() }))
    .min(1)
    .max(40),
});

// What one post sends: everything is read from the invoice and its load inside a transaction.
// billingEmail is the customer's synthetic billing address; without one nothing is posted.
export type PostableInvoice = {
  id: string;
  loadId: string | null;
  customer: { id: string; code: string; name: string; billingEmail: string | null };
  invoiceNumber: string;
  amountCents: number;
  issuedOn: LocalDate;
  dueOn: LocalDate;
  lines: AdapterInvoiceLine[];
};

export type InvoiceMoneyDeps = Partial<MoneyDeps>;

function adapterLines(lines: readonly LineSummary[], loadNumber: string): AdapterInvoiceLine[] {
  return lines.map((l) => ({
    kind: l.kind,
    description: `${LINE_WORDS[l.kind]}, load ${loadNumber}`,
    amountCents: l.amountCents,
  }));
}

type InvoiceRow = {
  id: string;
  source: string;
  load_id: string | null;
  customer_id: string;
  invoice_number: string;
  amount_cents: number | string;
  issued_on: string;
  due_on: string;
  status: string;
  qbo_id: string | null;
};

const INVOICE_COLUMNS =
  "id, source, load_id, customer_id, invoice_number, amount_cents, CAST(issued_on AS text) AS issued_on," +
  " CAST(due_on AS text) AS due_on, status, qbo_id";

// The invoice as the accounting system should see it, or a category. A load invoice's lines are
// the engine's lines for that load now, and must add up to the invoice's amount exactly; an
// opening balance is one line.
export async function readPostableInvoice(
  q: Queryable,
  invoiceId: string,
): Promise<{ ok: true; invoice: PostableInvoice; row: InvoiceRow } | { ok: false; category: string }> {
  const [row] = await q.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS} FROM invoices
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [invoiceId],
  );
  if (!row) return { ok: false, category: "not_found" };
  const amountCents = Number(row.amount_cents);
  const [customer] = await readRowsWhereId(q, "customers", "id", row.customer_id);
  if (!customer) return { ok: false, category: "not_found" };
  let lines: AdapterInvoiceLine[];
  if (row.load_id) {
    const loads = await readRowsWhereId(q, "loads", "id", row.load_id);
    if (loads.length !== 1) return { ok: false, category: "not_found" };
    const miles = await readRowsWhereId(q, "load_state_miles", "load_id", row.load_id);
    const extras = await readRowsWhereId(q, "load_accessorials", "load_id", row.load_id);
    const [load] = loadsOf(loads, miles, extras);
    const engine = invoiceAmount(load);
    if (!engine.ok || engine.amountCents !== amountCents) return { ok: false, category: "stale" };
    lines = adapterLines(lineSummary(engine.lines), load.loadNumber);
  } else {
    lines = [
      { kind: "linehaul", description: `Opening balance, ${row.invoice_number}`, amountCents },
    ];
  }
  return {
    ok: true,
    row,
    invoice: {
      id: row.id,
      loadId: row.load_id,
      customer: {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        billingEmail: customer.billing_email,
      },
      invoiceNumber: row.invoice_number,
      amountCents,
      issuedOn: row.issued_on,
      dueOn: row.due_on,
      lines,
    },
  };
}

// The waiting invoice_post proposal for a load, moved on by the ledger's outcome. Conditional on
// its status, so a second caller changes nothing.
async function linkProposal(q: Queryable, loadId: string | null, actionId: string): Promise<void> {
  if (!loadId) return;
  await q.execute(
    `UPDATE proposals SET money_action_id = CAST($2 AS uuid), updated_at = now()
      WHERE tenant_id = current_tenant_id() AND kind = 'invoice_post'
        AND subject_id = CAST($1 AS uuid) AND status IN ('approved', 'executing')
        AND money_action_id IS NULL`,
    [loadId, actionId],
  );
}

async function finishProposal(
  q: Queryable,
  loadId: string | null,
  to: "done" | "failed",
  note: string | null,
): Promise<void> {
  if (!loadId) return;
  await q.execute(
    `UPDATE proposals SET status = $2, decision_note = $3, updated_at = now()
      WHERE tenant_id = current_tenant_id() AND kind = 'invoice_post'
        AND subject_id = CAST($1 AS uuid) AND status = 'executing'`,
    [loadId, to, note],
  );
}

// The accounting system's email states, in the words invoices.qbo_email_status stores.
const EMAIL_STATUS_WORDS: Readonly<Record<InvoiceEmailStatus, string>> = {
  NotSet: "not_set",
  NeedToSend: "need_to_send",
  EmailSent: "email_sent",
};

// The stored word for a reported email state; null when none was reported or it is not one we
// know (unknown is stored as unknown, never guessed).
export function emailStatusWord(status: unknown): string | null {
  return typeof status === "string" && Object.hasOwn(EMAIL_STATUS_WORDS, status)
    ? EMAIL_STATUS_WORDS[status as InvoiceEmailStatus]
    : null;
}

// The outside id, the amount the accounting system confirmed and its email state, all at once and
// only the first time: a later call (a replay, or the executor after its hook) changes nothing.
async function recordQboId(
  q: Queryable,
  invoiceId: string,
  action: MoneyAction,
  emailStatus: InvoiceEmailStatus | null,
): Promise<void> {
  if (!action.outsideId || action.outsideAmountCents === null) throw new MoneyError("unknown");
  await q.execute(
    `UPDATE invoices SET qbo_id = $2, qbo_amount_cents = $3, qbo_email_status = $4
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND qbo_id IS NULL`,
    [invoiceId, action.outsideId, action.outsideAmountCents, emailStatusWord(emailStatus)],
  );
}

// The one money action that posts an invoice, shared by the executor and the "Post to QuickBooks"
// button. Throws MoneyError before any write when the switch is off or the adapter is not ready.
export async function postInvoiceAction(
  db: TenantDb,
  session: Session,
  invoice: PostableInvoice,
  opts: { attempt: number; proposalId: string | null },
  deps: InvoiceMoneyDeps = {},
): Promise<ExecuteResult> {
  const accounting = deps.accounting ?? accountingAdapter();
  const tenantId = session.tenantId;
  // A customer with no billing address is refused before anything is reserved: the invoice would
  // have nowhere to wait in the accounting system's send queue.
  if (!invoice.customer.billingEmail) throw new MoneyError("validation");
  const billingEmail = invoice.customer.billingEmail;
  // The email state the create reported, kept for the settle that follows it in this same call.
  let emailStatus: InvoiceEmailStatus | null = null;
  return executeMoneyAction(
    db,
    session,
    {
      kind: "invoice",
      subjectId: invoice.id,
      counterpartyId: invoice.customer.id,
      amountCents: invoice.amountCents,
      attempt: opts.attempt,
      proposedBy: "person",
      proposalId: opts.proposalId,
      // A payment recorded here before the post does not stop the post; a void invoice does.
      subjectStatuses: ["open", "partially_paid", "paid"],
    },
    {
      onReserved: (q, action) => linkProposal(q, invoice.loadId, action.id),
      onConfirmed: async (q, action) => {
        await recordQboId(q, invoice.id, action, emailStatus);
        await finishProposal(q, invoice.loadId, "done", null);
      },
      onFailed: (q, action) =>
        finishProposal(q, invoice.loadId, "failed", action.failureCategory ?? "unknown"),
      send: async (action, ctx) => {
        let customerOutsideId: string;
        try {
          customerOutsideId = (
            await db.withTenant(tenantId, (q) => accounting.ensureCustomer(q, invoice.customer, ctx))
          ).outsideId;
        } catch (err) {
          // No invoice was sent. The executor settles only a definite category as failed.
          return { kind: "failed", category: err instanceof MoneyError ? err.category : "unknown" };
        }
        const out = await db.withTenant(tenantId, (q) =>
          accounting.createInvoice(
            q,
            {
              actionId: action.id,
              invoiceNumber: invoice.invoiceNumber,
              customerOutsideId,
              issuedOn: invoice.issuedOn,
              dueOn: invoice.dueOn,
              lines: invoice.lines,
              billingEmail,
            },
            ctx,
          ),
        );
        emailStatus = out.kind === "confirmed" ? (out.emailStatus ?? null) : null;
        return out;
      },
    },
    { ...deps, accounting },
  );
}

// The reconcile hooks for an invoice's ledger row (kind 'invoice'): the follow-up writes the post
// makes (the outside id on the invoice, the waiting card moved on), and a read-back by our own
// invoice number, keyed by the adapter as its create keyed it, for the customer it was sent for.
// The invoice is read in its own short transaction and the adapter is called in another.
export function invoiceReconcileHooks(
  db: TenantDb,
  tenantId: string,
  accounting: AccountingAdapter,
): ReconcileHooks {
  // The email state each read-back reported, by ledger row, for the settle that follows it in the
  // same pass.
  const emailStatusOf = new Map<string, InvoiceEmailStatus | null>();
  const loadOf = async (q: Queryable, invoiceId: string): Promise<string | null> => {
    const [row] = await q.query<{ load_id: string | null }>(
      "SELECT load_id FROM invoices WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [invoiceId],
    );
    return row?.load_id ?? null;
  };
  return {
    onConfirmed: async (q, action) => {
      await recordQboId(q, action.subjectId, action, emailStatusOf.get(action.id) ?? null);
      emailStatusOf.delete(action.id);
      await finishProposal(q, await loadOf(q, action.subjectId), "done", null);
    },
    onFailed: async (q, action) =>
      finishProposal(q, await loadOf(q, action.subjectId), "failed", action.failureCategory ?? "unknown"),
    readBack: async (action, ctx) => {
      const [invoice] = await db.withTenant(tenantId, (q) =>
        q.query<{ invoice_number: string }>(
          "SELECT invoice_number FROM invoices WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
          [action.subjectId],
        ),
      );
      if (!invoice) return { found: false };
      const rb = await db.withTenant(tenantId, (q) =>
        accounting.readBack(
          q,
          {
            type: "Invoice",
            requestId: action.requestId,
            outsideId: action.outsideId,
            outsideRef: action.outsideRef,
            localRef: invoice.invoice_number,
            partyLocalId: action.counterpartyId,
          },
          ctx,
        ),
      );
      emailStatusOf.set(action.id, rb.found ? (rb.emailStatus ?? null) : null);
      return rb;
    },
  };
}

type Phase =
  | { kind: "result"; result: ProposalResult }
  | { kind: "post"; invoice: PostableInvoice; posted: boolean };

const failed = (category: string): ProposalResult => ({ ok: false, category, retryable: false });

type ProposalState = { status: string; money_action_id: string | null; decision_note: string | null };

function resultOf(proposalId: string, p: ProposalState): ProposalResult {
  if (p.status === "failed") return failed(p.decision_note ?? "failed");
  return { ok: true, proposalId, status: p.status, moneyActionId: p.money_action_id };
}

async function failStale(q: Queryable, proposalId: string, note: string): Promise<ProposalResult> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
    [proposalId, note],
  );
  return failed(note);
}

// Phase one, in one locked transaction: write the invoice, or find the one an earlier run wrote.
async function writeInvoice(
  q: Queryable,
  proposal: ProposalRow,
  now: Date,
): Promise<Phase> {
  // Switch off: nothing is written and the proposal stays approved, so it resumes once it is on.
  if (!flags.invoicesEnabled) return { kind: "result", result: failed("disabled") };
  const [p] = await q.query<ProposalState>(
    `SELECT status, money_action_id, decision_note FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [proposal.id],
  );
  if (!p) return { kind: "result", result: failed("not_found") };
  if (p.status !== "approved" && p.status !== "executing") {
    return { kind: "result", result: resultOf(proposal.id, p) };
  }
  const parsed = Args.safeParse(proposal.args);
  if (!parsed.success || proposal.subjectTable !== "loads" || parsed.data.loadId !== proposal.subjectId) {
    if (p.status === "approved") return { kind: "result", result: await failStale(q, proposal.id, "validation") };
    return { kind: "result", result: failed("validation") };
  }
  const args = parsed.data;

  if (p.status === "executing") {
    const [existing] = await q.query<{ id: string }>(
      `SELECT id FROM invoices WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)`,
      [args.loadId],
    );
    if (!existing) return { kind: "result", result: failed("unknown") };
    const read = await readPostableInvoice(q, existing.id);
    if (!read.ok) {
      // The load moved after the invoice was written: the card ends failed, never left executing.
      if (read.category === "stale") await finishProposal(q, args.loadId, "failed", "stale");
      return { kind: "result", result: failed(read.category) };
    }
    return { kind: "post", invoice: read.invoice, posted: read.row.qbo_id !== null };
  }

  // approved: the load must still be delivered, not invoiced, and total what the card said.
  const [locked] = await q.query<{ status: string }>(
    `SELECT status FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [args.loadId],
  );
  const [already] = await q.query<{ id: string }>(
    `SELECT id FROM invoices WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)`,
    [args.loadId],
  );
  if (!locked || locked.status !== "delivered" || already) {
    return { kind: "result", result: await failStale(q, proposal.id, "stale") };
  }
  const loads = await readRowsWhereId(q, "loads", "id", args.loadId);
  const miles = await readRowsWhereId(q, "load_state_miles", "load_id", args.loadId);
  const extras = await readRowsWhereId(q, "load_accessorials", "load_id", args.loadId);
  const [load] = loadsOf(loads, miles, extras);
  const engine = invoiceAmount(load);
  const customerId = load.customerId;
  if (
    !engine.ok ||
    !customerId ||
    engine.amountCents !== args.amountCents ||
    engine.amountCents !== proposal.amountCents ||
    !sameLines(lineSummary(engine.lines), args.lines)
  ) {
    return { kind: "result", result: await failStale(q, proposal.id, "stale") };
  }
  const [customer] = await readRowsWhereId(q, "customers", "id", customerId);
  const tenant = await readTenant(q);
  if (!customer || !tenant) return { kind: "result", result: await failStale(q, proposal.id, "stale") };

  const issuedOn = localDateOf(now.toISOString(), tenant.timezone);
  const dueOn = addDays(issuedOn, customer.terms_days);
  // A number past what the accounting system can hold with the tenant's key is refused, never cut.
  let invoiceNumber: string;
  try {
    invoiceNumber = await nextInvoiceNumber(q, invoicePrefixOf(tenant.slug));
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return { kind: "result", result: await failStale(q, proposal.id, "validation") };
  }
  const invoiceId = randomUUID();
  await q.execute(
    `INSERT INTO invoices (id, tenant_id, source, load_id, customer_id, invoice_number, amount_cents,
                           issued_on, due_on, status)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'load', CAST($2 AS uuid), CAST($3 AS uuid), $4,
             $5, CAST($6 AS date), CAST($7 AS date), 'open')`,
    [invoiceId, args.loadId, customerId, invoiceNumber, engine.amountCents, issuedOn, dueOn],
  );
  const moved = await q.execute(
    `UPDATE loads SET status = 'invoiced'
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'delivered'`,
    [args.loadId],
  );
  const started = await q.execute(
    `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
    [proposal.id, now.toISOString()],
  );
  // Both rows are locked above, so anything but one row each means the database moved under us.
  if (moved !== 1 || started !== 1) throw new Error("invoice write lost its lock");
  return {
    kind: "post",
    posted: false,
    invoice: {
      id: invoiceId,
      loadId: args.loadId,
      customer: {
        id: customer.id,
        code: customer.code,
        name: customer.name,
        billingEmail: customer.billing_email,
      },
      invoiceNumber,
      amountCents: engine.amountCents,
      issuedOn,
      dueOn,
      lines: adapterLines(args.lines, load.loadNumber),
    },
  };
}

// Phase two: the post, then the proposal's last move from what the ledger row says.
async function postAndFinish(
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  invoice: PostableInvoice,
  money: InvoiceMoneyDeps,
): Promise<ProposalResult> {
  const tenantId = session.tenantId;
  const finish = async (to: "done" | "failed", note: string | null): Promise<ProposalResult> => {
    const state = await db.withTenant(tenantId, async (q) => {
      await finishProposal(q, invoice.loadId, to, note);
      const [p] = await q.query<ProposalState>(
        `SELECT status, money_action_id, decision_note FROM proposals
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [proposal.id],
      );
      return p;
    });
    return state ? resultOf(proposal.id, state) : failed("not_found");
  };

  // The invoice is written; with no billing address it is kept here, unposted, like a closed
  // connection: nothing is reserved and the proposal is done.
  if (!invoice.customer.billingEmail) return finish("done", "no_billing_address");
  let out: ExecuteResult;
  try {
    out = await postInvoiceAction(db, session, invoice, { attempt: 1, proposalId: proposal.id }, money);
  } catch (err) {
    if (!(err instanceof MoneyError)) throw err;
    if (err.category === "disabled") return finish("done", "not_posted");
    if (err.category === "not_connected" || err.category === "not_configured") {
      return finish("done", err.category);
    }
    // Nobody knows whether anything was sent: the proposal stays executing for a resume.
    if (err.category === "unknown") throw err;
    return finish("failed", err.category);
  }
  const action = out.action;
  if (action.state === "confirmed") {
    // The settle's own hook stored the email state; this only covers a replay, and is a no-op
    // once the id is stored.
    await db.withTenant(tenantId, (q) => recordQboId(q, invoice.id, action, null));
    return finish("done", null);
  }
  if (action.state === "failed") return finish("failed", action.failureCategory ?? "unknown");
  // reserved, sent or unknown: not settled. The card reads the ledger row's state.
  return { ok: true, proposalId: proposal.id, status: "executing", moneyActionId: action.id };
}

export function invoicePostExecutor(money: InvoiceMoneyDeps = {}): Executor {
  return async (db, session, proposal, _opts, deps: ExecuteDeps) => {
    const now = (deps.clock ?? (() => new Date()))();
    const phase = await db.withTenant(session.tenantId, (q) => writeInvoice(q, proposal, now));
    if (phase.kind === "result") return phase.result;
    if (phase.posted) {
      return db.withTenant(session.tenantId, async (q) => {
        await finishProposal(q, phase.invoice.loadId, "done", null);
        return { ok: true, proposalId: proposal.id, status: "done", moneyActionId: proposal.moneyActionId };
      });
    }
    return postAndFinish(db, session, proposal, phase.invoice, money);
  };
}

export const executeInvoicePost: Executor = invoicePostExecutor();

// For tests and the record page: the number an invoice would get, without writing anything.
export { invoiceNumberOf };
