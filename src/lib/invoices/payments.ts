import { randomUUID } from "node:crypto";
import { accountingAdapter } from "../adapters";
import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { readTenant } from "../data/read";
import { executeMoneyAction, type MoneyDeps } from "../money/execute";
import { isCanonicalUuid } from "../money/keys";
import { readBySubject } from "../money/read";
import { MoneyError, type MoneyAction, type MoneyActionState } from "../money/types";
import { assertMembership } from "../tenant/context";
import { localDateOf } from "../time/local-date";
import { refreshInvoiceStatus } from "./apply";
import { tenantLock } from "./number";
import { checkApplications, checkPaymentInput, type OpenInvoice } from "./payment-input";

// A customer payment a person records by hand, then its post to the accounting system. The record
// and its applications land in one tenant transaction (the customer and every invoice locked,
// balances re-checked whole, the day's cap counted under a per-tenant lock), so two submits of the
// same form make one payment: the reference is unique per carrier, and a repeat with the same
// customer and amount returns the payment already recorded.
//
// The post goes through the money executor with the payment's ledger key
// (customer_payment:<payment id>:<attempt>). It waits until every invoice the payment applies to
// is in the accounting system (posting is then a button on the payment's page), and with
// accountingEnabled off nothing is reserved: the executor logs what it would send.

export type PostingState =
  | MoneyActionState
  | "not_posted"
  | "not_configured"
  | "not_connected"
  | (string & {});

export type RecordResult =
  | { ok: true; created: boolean; paymentId: string; posting: PostingState | null }
  | {
      ok: false;
      category: "disabled" | "validation" | "not_found" | "duplicate_ref" | "over_applied" | "limit";
    };

type PostablePayment = {
  id: string;
  customer: { id: string; code: string; name: string };
  paymentRef: string;
  receivedOn: string;
  amountCents: number;
  qboId: string | null;
  applications: { invoiceOutsideId: string | null; amountCents: number }[];
};

// The payment with its customer and applications, the payment row locked.
async function readPostablePayment(q: Queryable, paymentId: string): Promise<PostablePayment | null> {
  const [p] = await q.query<{
    id: string;
    customer_id: string;
    payment_ref: string;
    received_on: string;
    amount_cents: number | string;
    qbo_id: string | null;
  }>(
    `SELECT id, customer_id, payment_ref, CAST(received_on AS text) AS received_on, amount_cents, qbo_id
       FROM customer_payments
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [paymentId],
  );
  if (!p) return null;
  const [c] = await q.query<{ id: string; code: string; name: string }>(
    "SELECT id, code, name FROM customers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [p.customer_id],
  );
  if (!c) return null;
  const apps = await q.query<{ qbo_id: string | null; amount_cents: number | string }>(
    `SELECT i.qbo_id, a.amount_cents FROM payment_applications a
       JOIN invoices i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
      WHERE a.tenant_id = current_tenant_id() AND a.payment_id = CAST($1 AS uuid)
      ORDER BY i.invoice_number, a.id`,
    [paymentId],
  );
  return {
    id: p.id,
    customer: { id: c.id, code: c.code, name: c.name },
    paymentRef: p.payment_ref,
    receivedOn: p.received_on,
    amountCents: Number(p.amount_cents),
    qboId: p.qbo_id,
    applications: apps.map((a) => ({ invoiceOutsideId: a.qbo_id, amountCents: Number(a.amount_cents) })),
  };
}

async function recordPaymentQboId(q: Queryable, paymentId: string, action: MoneyAction): Promise<void> {
  if (!action.outsideId) throw new MoneyError("unknown");
  await q.execute(
    `UPDATE customer_payments SET qbo_id = $2
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND qbo_id IS NULL`,
    [paymentId, action.outsideId],
  );
}

// The one money action that posts a payment. Refuses (not_configured) before any reserve while
// an applied invoice is not in the accounting system yet.
async function postPaymentAction(
  db: TenantDb,
  session: Session,
  payment: PostablePayment,
  attempt: number,
  deps: Partial<MoneyDeps>,
): Promise<PostingState> {
  if (payment.applications.some((a) => a.invoiceOutsideId === null)) return "not_configured";
  const applications = payment.applications.map((a) => ({
    invoiceOutsideId: a.invoiceOutsideId as string,
    amountCents: a.amountCents,
  }));
  const accounting = deps.accounting ?? accountingAdapter();
  const tenantId = session.tenantId;
  try {
    const out = await executeMoneyAction(
      db,
      session,
      {
        kind: "customer_payment",
        subjectId: payment.id,
        counterpartyId: payment.customer.id,
        amountCents: payment.amountCents,
        attempt,
        proposedBy: "person",
        proposalId: null,
      },
      {
        // The payment row is the record; nothing else moves at reserve time.
        onReserved: async () => {},
        onConfirmed: (q, action) => recordPaymentQboId(q, payment.id, action),
        send: async (action, ctx) => {
          let customerOutsideId: string;
          try {
            customerOutsideId = (
              await db.withTenant(tenantId, (q) => accounting.ensureCustomer(q, payment.customer, ctx))
            ).outsideId;
          } catch (err) {
            return { kind: "failed", category: err instanceof MoneyError ? err.category : "unknown" };
          }
          return db.withTenant(tenantId, (q) =>
            accounting.recordCustomerPayment(
              q,
              {
                actionId: action.id,
                customerOutsideId,
                paymentRef: payment.paymentRef,
                receivedOn: payment.receivedOn,
                amountCents: payment.amountCents,
                applications,
              },
              ctx,
            ),
          );
        },
      },
      { ...deps, accounting },
    );
    return out.action.state;
  } catch (err) {
    if (!(err instanceof MoneyError)) throw err;
    return err.category === "disabled" ? "not_posted" : err.category;
  }
}

export async function recordCustomerPayment(
  db: TenantDb,
  session: Session,
  raw: unknown,
  now: Date,
  deps: Partial<MoneyDeps> = {},
): Promise<RecordResult> {
  if (!flags.customerPaymentsEnabled) return { ok: false, category: "disabled" };
  type Step =
    | { kind: "refused"; result: RecordResult }
    | { kind: "existing"; paymentId: string }
    | { kind: "created"; payment: PostablePayment };
  const step = await db.withTenant(session.tenantId, async (q): Promise<Step> => {
    await assertMembership(q, session);
    const refuse = (category: Extract<RecordResult, { ok: false }>["category"]): Step => ({
      kind: "refused",
      result: { ok: false, category },
    });
    const tenant = await readTenant(q);
    if (!tenant) return refuse("not_found");
    const today = localDateOf(now.toISOString(), tenant.timezone);
    const checked = checkPaymentInput(raw, today);
    if (!checked.ok) return refuse(checked.category);
    const input = checked.input;
    // One recording at a time per carrier: the reference check and the day's count stay exact.
    await tenantLock(q, "customer_payment");

    const [same] = await q.query<{ id: string; customer_id: string; amount_cents: number | string }>(
      `SELECT id, customer_id, amount_cents FROM customer_payments
        WHERE tenant_id = current_tenant_id() AND payment_ref = $1`,
      [input.paymentRef],
    );
    if (same) {
      return same.customer_id === input.customerId && Number(same.amount_cents) === input.amountCents
        ? { kind: "existing", paymentId: same.id }
        : refuse("duplicate_ref");
    }

    const [customer] = await q.query<{ id: string }>(
      "SELECT id FROM customers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE",
      [input.customerId],
    );
    if (!customer) return refuse("not_found");

    const ids = [...input.applications.map((a) => a.invoiceId)].sort();
    const invoices: OpenInvoice[] = [];
    for (const id of ids) {
      const [row] = await q.query<{
        id: string;
        customer_id: string;
        status: string;
        amount_cents: number | string;
        applied: number | string | null;
      }>(
        `SELECT i.id, i.customer_id, i.status, i.amount_cents,
                (SELECT sum(a.amount_cents) FROM payment_applications a
                  WHERE a.tenant_id = current_tenant_id() AND a.invoice_id = i.id) AS applied
           FROM invoices i
          WHERE i.tenant_id = current_tenant_id() AND i.id = CAST($1 AS uuid) FOR UPDATE OF i`,
        [id],
      );
      if (!row) return refuse("validation");
      invoices.push({
        id: row.id,
        customerId: row.customer_id,
        status: row.status,
        amountCents: Number(row.amount_cents),
        appliedCents: Number(row.applied ?? 0),
      });
    }
    const fits = checkApplications(input.customerId, input.applications, invoices);
    if (!fits.ok) return refuse(fits.category);

    const [counted] = await q.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM customer_payments
        WHERE tenant_id = current_tenant_id() AND source = 'ui'
          AND CAST(timezone($1, created_at) AS date) = CAST($2 AS date)`,
      [tenant.timezone, today],
    );
    if (Number(counted?.n ?? 0) >= flags.customerPaymentLimits.perDay) return refuse("limit");

    const paymentId = randomUUID();
    await q.execute(
      `INSERT INTO customer_payments
         (id, tenant_id, customer_id, received_on, amount_cents, method, payment_ref, source, memo)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS date), $4, $5, $6,
               'ui', $7)`,
      [
        paymentId,
        input.customerId,
        input.receivedOn,
        input.amountCents,
        input.method,
        input.paymentRef,
        input.memo ?? null,
      ],
    );
    for (const a of input.applications) {
      await q.execute(
        `INSERT INTO payment_applications (id, tenant_id, payment_id, invoice_id, amount_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4)`,
        [randomUUID(), paymentId, a.invoiceId, a.amountCents],
      );
    }
    for (const id of ids) await refreshInvoiceStatus(q, id);
    const payment = await readPostablePayment(q, paymentId);
    if (!payment) throw new Error("payment write lost its row");
    return { kind: "created", payment };
  });

  if (step.kind === "refused") return step.result;
  if (step.kind === "existing") {
    // A repeat of a payment already recorded: nothing is written and nothing is posted again.
    return { ok: true, created: false, paymentId: step.paymentId, posting: null };
  }
  let posting: PostingState;
  try {
    posting = await postPaymentAction(db, session, step.payment, 1, deps);
  } catch {
    // The payment is recorded either way; whether the post went out is not known until a
    // read-back, so the page says so instead of failing the whole request.
    console.error("invoices: payment post outcome unknown");
    posting = "unknown";
  }
  return { ok: true, created: true, paymentId: step.payment.id, posting };
}

export type PaymentPostResult =
  | { ok: true; posting: PostingState }
  | { ok: false; category: "validation" | "not_found" | "already_posted" | "attempts_used" | "disabled" };

// "Post to QuickBooks" on a payment's record page: the same action and key; a row in flight is
// replayed under its own attempt, a definite failure gets attempt + 1, at most
// invoiceLimits.maxPostAttempts times.
export async function postCustomerPayment(
  db: TenantDb,
  session: Session,
  paymentId: string,
  deps: Partial<MoneyDeps> = {},
): Promise<PaymentPostResult> {
  if (!flags.customerPaymentsEnabled) return { ok: false, category: "disabled" };
  if (!isCanonicalUuid(paymentId)) return { ok: false, category: "validation" };
  const plan = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const payment = await readPostablePayment(q, paymentId);
    if (!payment) return { ok: false as const, category: "not_found" as const };
    if (payment.qboId !== null) return { ok: false as const, category: "already_posted" as const };
    const rows = (await readBySubject(q, "customer_payments", paymentId)).filter(
      (a) => a.kind === "customer_payment",
    );
    const latest = rows.reduce<(typeof rows)[number] | null>(
      (top, a) => (top === null || a.attempt > top.attempt ? a : top),
      null,
    );
    if (latest?.state === "confirmed") return { ok: false as const, category: "already_posted" as const };
    const attempt = latest === null ? 1 : latest.state === "failed" ? latest.attempt + 1 : latest.attempt;
    if (attempt > flags.invoiceLimits.maxPostAttempts) {
      return { ok: false as const, category: "attempts_used" as const };
    }
    return { ok: true as const, payment, attempt };
  });
  if (!plan.ok) return plan;
  return { ok: true, posting: await postPaymentAction(db, session, plan.payment, plan.attempt, deps) };
}
