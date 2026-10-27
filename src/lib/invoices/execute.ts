import { randomUUID } from "node:crypto";
import { z } from "zod";
import { accountingAdapter } from "../adapters";
import type { InvoiceLine as AdapterInvoiceLine } from "../adapters/types";
import type { Session } from "../auth/claims";
import type { Queryable, TenantDb } from "../db";
import { loadsOf } from "../data/records";
import { readRowsWhereId, readTenant } from "../data/read";
import { executeMoneyAction, type ExecuteResult, type MoneyDeps } from "../money/execute";
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

const LINE_KINDS = ["linehaul", "fuel_surcharge", "detention", "layover", "stop", "lumper"] as const;

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
export type PostableInvoice = {
  id: string;
  loadId: string | null;
  customer: { id: string; code: string; name: string };
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
      customer: { id: customer.id, code: customer.code, name: customer.name },
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

async function recordQboId(q: Queryable, invoiceId: string, action: MoneyAction): Promise<void> {
  if (!action.outsideId) throw new MoneyError("unknown");
  await q.execute(
    `UPDATE invoices SET qbo_id = $2
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND qbo_id IS NULL`,
    [invoiceId, action.outsideId],
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
        await recordQboId(q, invoice.id, action);
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
        return db.withTenant(tenantId, (q) =>
          accounting.createInvoice(
            q,
            {
              actionId: action.id,
              invoiceNumber: invoice.invoiceNumber,
              customerOutsideId,
              issuedOn: invoice.issuedOn,
              dueOn: invoice.dueOn,
              lines: invoice.lines,
            },
            ctx,
          ),
        );
      },
    },
    { ...deps, accounting },
  );
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
    if (!read.ok) return { kind: "result", result: failed(read.category) };
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
  const invoiceNumber = await nextInvoiceNumber(q, invoicePrefixOf(tenant.slug));
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
      customer: { id: customer.id, code: customer.code, name: customer.name },
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
    await db.withTenant(tenantId, (q) => recordQboId(q, invoice.id, action));
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
