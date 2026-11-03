import { flags } from "../../config/flags";
import { accountingAdapter } from "../adapters";
import type { AccountingAdapter } from "../adapters/types";
import { postPaidAdvanceExpense, expenseReconcileHooks } from "../advances/post-expense";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { invoiceReconcileHooks, postInvoiceAction, readPostableInvoice } from "../invoices/execute";
import { QUEUE_CARD_LOADS_SQL, madeByQueue } from "../invoices/made-by-queue";
import { paymentReconcileHooks, postPaymentAction, readPostablePayment } from "../invoices/payments";
import { datedBeforeInvoicesStart } from "../invoices/post";
import { categoryOf, DEFAULT_TIMEOUT_MS, type ExecuteResult, type MoneyDeps } from "../money/execute";
import { reconcileMoneyActions, type ReconcileHooks, type ReconcileSummary } from "../money/reconcile";
import { MoneyError, type MoneyActionKind } from "../money/types";
import { runAccountingLegs } from "../settlements/legs";
import { settlementReconcileHooks } from "../settlements/reconcile-hooks";
import { isLocalDate, type LocalDate } from "../time/local-date";
import { postRecordExpense, recordReconcileHooks } from "./records";

// The books step (D-104): every money movement records to the QuickBooks sandbox by itself. Each
// desk wake runs it first, under the carrier's service login, inside a time budget taken from the
// front of the wake's slice. It posts what is still missing, oldest first: a paid paystub's bill
// and bill payment, a paid advance's expense, an issued money code and a released escrow balance
// (each behind its kinds switch), an invoice the queue made, and a payment a person recorded once
// every invoice it pays is in QuickBooks. A definite failure is tried again as the next attempt
// after a ten-minute wait, at most books.maxAttempts times; after that the record says it needs a
// person (status.ts). Then the reconcile pass reads back what is still unknown.
//
// Every send goes through the money executor (the ledger row is reserved before the call, the key
// is <kind>:<subject>:<attempt>, accountingEnabled and the adapter are checked again at the write).
// The step calls the library posts, never the record pages' old button wrappers: an invoice the
// queue made already passed the admin-above-$2,000 rule when its card was approved, and the paystub
// and advance were approved by a person before they were paid, so the service login posts them as
// they are. books.enabled, accountingEnabled and the adapter are checked here first; any of them
// off or not ready means nothing is read or written.
//
// postBooksHistory is the backfill script's entry (scripts/books-backfill.local.ts): the same step
// over the carrier's older history, which also posts seeded invoices and payments (not made by the
// queue, not recorded on the form). The desk route never calls it.

export type BooksSource = "settlement" | "advance" | "money_code" | "escrow" | "invoice" | "payment";

export type BooksOptions = { deadlineMs: number; maxItems: number; since: LocalDate };

export type BooksDeps = {
  db?: TenantDb;
  money?: Partial<MoneyDeps>;
  // The request clock in milliseconds, for the budget only (never a date). Tests inject it.
  nowMs?: () => number;
  clock?: () => Date;
  log?: (line: string) => void;
  // The wait after a definite failure, in whole minutes (BOOKS_RETRY_AFTER_MINUTES unless a test
  // shortens it).
  retryAfterMinutes?: number;
};

export type BooksStop = "empty" | "deadline" | "max_items" | "unknown" | "rate_limited" | "disabled";

export type BooksSummary =
  | { ok: false; category: string }
  | {
      ok: true;
      tried: number;
      confirmed: number;
      failed: number;
      pending: number;
      refused: number;
      stop: BooksStop;
      reconciled: ReconcileSummary | null;
    };

// Below this much time left, nothing new starts.
export const BOOKS_MIN_LEFT_MS = 3_000;
// Each outside call ends this long before the deadline.
const CALL_MARGIN_MS = 1_000;
// A definite failure waits this long before its next attempt.
export const BOOKS_RETRY_AFTER_MINUTES = 10;
// Candidates read past maxItems, so a record refused before any write never holds a later one up.
const LOOKAHEAD = 20;

// The accounting kinds the step's reconcile pass reads back.
export const BOOKS_KINDS: readonly MoneyActionKind[] = [
  "settlement_bill",
  "settlement_bill_payment",
  "advance_expense",
  "invoice",
  "customer_payment",
  "money_code_expense",
  "escrow_release_expense",
];

export type Candidate = { source: BooksSource; id: string; kind: MoneyActionKind; onDate: string; lastAttempt: number | null };

// One statement, oldest first. The latest accounting row of each record decides: none yet, or a
// definite failure (never another amount) with tries left and the wait over. A row reserved, sent
// or unknown is in flight and is left to its sender and the reconcile pass. On one day, invoices
// come before everything else and payments after, so a payment's invoices are posted first.
// $4 (history) is true only from postBooksHistory: it lifts the invoices start date, the
// made-by-queue rule and the recorded-on-the-form rule.
const CANDIDATES_SQL = `WITH zone AS (
    SELECT timezone FROM tenants WHERE id = current_tenant_id()
  ),
  latest AS (
    SELECT DISTINCT ON (kind, subject_id) kind, subject_id, state, attempt, failure_category, settled_at
      FROM money_actions
     WHERE tenant_id = current_tenant_id() AND channel = 'accounting'
     ORDER BY kind, subject_id, attempt DESC, created_at DESC
  ),
  queue_loads AS (${QUEUE_CARD_LOADS_SQL.split("$1").join("NULL")}),
  c AS (
    SELECT 'settlement' AS source, s.id,
           CASE WHEN EXISTS (SELECT 1 FROM latest b WHERE b.kind = 'settlement_bill' AND b.subject_id = s.id
                               AND b.state = 'confirmed')
                THEN 'settlement_bill_payment' ELSE 'settlement_bill' END AS kind,
           CAST(s.paid_at AT TIME ZONE z.timezone AS date) AS on_date, 1 AS phase
      FROM settlements s CROSS JOIN zone z
     WHERE s.tenant_id = current_tenant_id() AND s.status = 'paid' AND s.paid_at IS NOT NULL AND s.net_cents > 0
    UNION ALL
    SELECT 'advance', a.id, 'advance_expense', CAST(a.paid_at AT TIME ZONE z.timezone AS date), 1
      FROM advances a CROSS JOIN zone z
     WHERE a.tenant_id = current_tenant_id() AND a.status = 'paid' AND a.paid_at IS NOT NULL
    UNION ALL
    SELECT 'money_code', m.id, 'money_code_expense', CAST(m.issued_at AT TIME ZONE z.timezone AS date), 1
      FROM money_codes m CROSS JOIN zone z
     WHERE CAST($5 AS boolean) AND m.tenant_id = current_tenant_id() AND m.status = 'issued'
       AND m.issued_at IS NOT NULL
    UNION ALL
    SELECT 'escrow', e.id, 'escrow_release_expense', CAST(e.released_at AT TIME ZONE z.timezone AS date), 1
      FROM escrow_releases e CROSS JOIN zone z
     WHERE CAST($6 AS boolean) AND e.tenant_id = current_tenant_id() AND e.status = 'released'
       AND e.released_at IS NOT NULL
    UNION ALL
    SELECT 'invoice', i.id, 'invoice', i.issued_on, 0
      FROM invoices i
      JOIN customers cu ON cu.tenant_id = i.tenant_id AND cu.id = i.customer_id
     WHERE i.tenant_id = current_tenant_id() AND i.status <> 'void' AND i.qbo_id IS NULL
       AND cu.billing_email IS NOT NULL
       AND (CAST($4 AS boolean)
            OR (i.issued_on >= CAST($7 AS date) AND i.source = 'load'
                AND CAST(i.load_id AS text) IN (SELECT load_id FROM queue_loads)))
    UNION ALL
    SELECT 'payment', p.id, 'customer_payment', p.received_on, 2
      FROM customer_payments p
     WHERE p.tenant_id = current_tenant_id() AND p.qbo_id IS NULL
       AND (CAST($4 AS boolean) OR p.source = 'ui')
       AND NOT EXISTS (
         SELECT 1 FROM payment_applications pa
           JOIN invoices ai ON ai.tenant_id = pa.tenant_id AND ai.id = pa.invoice_id
          WHERE pa.tenant_id = p.tenant_id AND pa.payment_id = p.id AND ai.qbo_id IS NULL)
  )
  SELECT c.source, CAST(c.id AS text) AS id, c.kind, CAST(c.on_date AS text) AS on_date,
         l.attempt AS last_attempt
    FROM c LEFT JOIN latest l ON l.kind = c.kind AND l.subject_id = c.id
   WHERE c.on_date >= CAST($1 AS date)
     AND (l.state IS NULL
          OR (l.state = 'failed' AND l.failure_category IS DISTINCT FROM 'amount_mismatch'
              AND l.attempt < $2
              AND l.settled_at < now() - make_interval(mins => CAST($8 AS integer))))
   ORDER BY c.on_date, c.phase, c.id
   LIMIT $3`;

type Mode = "step" | "history";

async function readCandidates(
  db: TenantDb,
  tenantId: string,
  mode: Mode,
  since: LocalDate,
  limit: number,
  retryAfterMinutes: number,
): Promise<Candidate[]> {
  const rows = await db.withTenant(tenantId, (q) =>
    q.query<{ source: BooksSource; id: string; kind: MoneyActionKind; on_date: string; last_attempt: number | null }>(
      CANDIDATES_SQL,
      [
        since,
        flags.books.maxAttempts,
        limit,
        mode === "history",
        flags.books.kinds.moneyCodes === true,
        flags.books.kinds.escrow === true,
        flags.invoicesStart,
        retryAfterMinutes,
      ],
    ),
  );
  return rows.map((r) => ({
    source: r.source,
    id: r.id,
    kind: r.kind,
    onDate: r.on_date,
    lastAttempt: r.last_attempt === null ? null : Number(r.last_attempt),
  }));
}

// What one record's post came to. refused: nothing was written (a switch, the adapter, or the
// record no longer fits). unknown: it may exist in QuickBooks; the reconcile pass reads it back.
type Outcome = { result: "confirmed" | "failed" | "pending" | "refused" | "unknown"; category: string | null };

function ofState(state: string, category: string | null): Outcome {
  if (state === "confirmed") return { result: "confirmed", category: null };
  if (state === "failed") return { result: "failed", category };
  if (state === "unknown") return { result: "unknown", category };
  // reserved or sent: another caller holds it.
  return { result: "pending", category: null };
}

function ofAction(r: ExecuteResult | null): Outcome {
  if (r === null) return { result: "refused", category: "not_found" };
  return ofState(r.action.state, r.action.failureCategory);
}

function ofError(err: unknown): Outcome {
  if (err instanceof MoneyError) {
    // A MoneyError before the send means nothing was written; unknown means it may have been.
    return err.category === "unknown"
      ? { result: "unknown", category: "unknown" }
      : { result: "refused", category: err.category };
  }
  // Not always before a send: unknown, never "nothing was written".
  return { result: "unknown", category: categoryOf(err) };
}

async function postOne(
  db: TenantDb,
  session: Session,
  c: Candidate,
  mode: Mode,
  money: Partial<MoneyDeps>,
  clock: () => Date,
): Promise<Outcome> {
  const attempt = (c.lastAttempt ?? 0) + 1;
  if (attempt > flags.books.maxAttempts) return { result: "refused", category: "attempts_used" };
  switch (c.source) {
    case "settlement": {
      const out = await runAccountingLegs(
        db,
        session,
        c.id,
        { proposalId: null, batchId: null, retryFailed: true },
        money,
        clock,
      );
      if (out.bill === "confirmed" && out.billPayment === "confirmed") return { result: "confirmed", category: null };
      const stuck = out.bill === "confirmed" ? out.billPayment : out.bill;
      if (stuck === "failed") return { result: "failed", category: null };
      if (stuck === "unknown") return { result: "unknown", category: "unknown" };
      if (stuck === "reserved" || stuck === "sent") return { result: "pending", category: null };
      return { result: "refused", category: stuck };
    }
    case "advance":
      return ofAction(await postPaidAdvanceExpense(db, session, c.id, attempt, money));
    case "money_code":
      return ofAction(await postRecordExpense(db, session, "money_code_expense", c.id, attempt, money));
    case "escrow":
      return ofAction(await postRecordExpense(db, session, "escrow_release_expense", c.id, attempt, money));
    case "invoice": {
      const read = await db.withTenant(session.tenantId, async (q) => {
        const r = await readPostableInvoice(q, c.id);
        if (!r.ok) return r;
        if (r.row.status === "void" || r.row.qbo_id !== null) return { ok: false as const, category: "validation" };
        // The step's own rule, asked again under the invoice's lock: only an invoice the queue made,
        // dated on or after the invoices start. Only the backfill posts older or seeded ones.
        if (mode === "step" && (datedBeforeInvoicesStart(r.row.issued_on) || !(await madeByQueue(q, r.row)))) {
          return { ok: false as const, category: "history" };
        }
        return r;
      });
      if (!read.ok) return { result: "refused", category: read.category };
      const r = await postInvoiceAction(db, session, read.invoice, { attempt, proposalId: null }, money);
      return ofAction(r);
    }
    case "payment": {
      const payment = await db.withTenant(session.tenantId, (q) => readPostablePayment(q, c.id));
      if (!payment || payment.qboId !== null) return { result: "refused", category: "not_found" };
      // Only a payment a person recorded on the form, unless this is the backfill.
      if (mode === "step" && payment.source !== "ui") return { result: "refused", category: "history" };
      const state = await postPaymentAction(db, session, payment, attempt, money);
      if (state === "confirmed" || state === "failed" || state === "unknown" || state === "reserved" || state === "sent") {
        return ofState(state, null);
      }
      return { result: "refused", category: state };
    }
  }
}

// The reconcile hooks of every books kind, as each kind's own post registers them.
export function booksReconcileHooks(
  db: TenantDb,
  tenantId: string,
  money: Partial<MoneyDeps>,
  accounting: AccountingAdapter,
): Partial<Record<MoneyActionKind, ReconcileHooks>> {
  const s = settlementReconcileHooks(db, tenantId, accounting);
  return {
    settlement_bill: s.settlement_bill,
    settlement_bill_payment: s.settlement_bill_payment,
    advance_expense: expenseReconcileHooks(db, tenantId, { ...money, accounting }),
    invoice: invoiceReconcileHooks(db, tenantId, accounting),
    customer_payment: paymentReconcileHooks(db, tenantId, accounting),
    ...recordReconcileHooks(db, tenantId, accounting),
  };
}

async function runBooks(session: Session, opts: BooksOptions, deps: BooksDeps, mode: Mode): Promise<BooksSummary> {
  const log = deps.log ?? ((line: string) => console.info(line));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const clock = deps.clock ?? (() => new Date());
  const tenantId = session?.tenantId;
  if (typeof tenantId !== "string") return { ok: false, category: "validation" };
  if (!Number.isFinite(opts?.deadlineMs) || !Number.isSafeInteger(opts?.maxItems) || opts.maxItems < 1) {
    return { ok: false, category: "validation" };
  }
  if (!isLocalDate(opts.since)) return { ok: false, category: "validation" };
  const retryAfterMinutes = deps.retryAfterMinutes ?? BOOKS_RETRY_AFTER_MINUTES;
  if (!Number.isSafeInteger(retryAfterMinutes) || retryAfterMinutes < 0 || retryAfterMinutes > 1_440) {
    return { ok: false, category: "validation" };
  }
  // The switches and the adapter first: off or not ready, nothing is read or written.
  if (flags.books.enabled !== true) return { ok: false, category: "disabled" };
  if (flags.accountingEnabled !== true) return { ok: false, category: "accounting_off" };
  const db = deps.db ?? getDb();
  const accounting = deps.money?.accounting ?? accountingAdapter();
  try {
    const ready = await db.withTenant(tenantId, (q) => accounting.ready(q));
    if (!ready || ready.ok !== true) {
      const category = ready && "category" in ready ? ready.category : undefined;
      return { ok: false, category: typeof category === "string" ? category : "not_configured" };
    }
  } catch (err) {
    return { ok: false, category: err instanceof MoneyError ? err.category : "unavailable" };
  }
  // The step never reaches back before its start date; only the backfill does.
  const since = mode === "step" && opts.since < flags.books.startDate ? flags.books.startDate : opts.since;
  const left = () => opts.deadlineMs - nowMs();
  const summary = { tried: 0, confirmed: 0, failed: 0, pending: 0, refused: 0 };
  const notes: string[] = [];
  let stop: BooksStop = "empty";
  if (left() < BOOKS_MIN_LEFT_MS) {
    stop = "deadline";
  } else {
    const candidates = await readCandidates(db, tenantId, mode, since, opts.maxItems + LOOKAHEAD, retryAfterMinutes);
    for (const c of candidates) {
      if (summary.tried >= opts.maxItems) {
        stop = "max_items";
        break;
      }
      if (left() < BOOKS_MIN_LEFT_MS) {
        stop = "deadline";
        break;
      }
      // The switch again before each record: it may have been turned off during the step.
      if (flags.books.enabled !== true || flags.accountingEnabled !== true) {
        stop = "disabled";
        break;
      }
      const budget = Math.max(1, left() - CALL_MARGIN_MS);
      const money: Partial<MoneyDeps> = {
        ...deps.money,
        accounting,
        timeoutMs: Math.min(deps.money?.timeoutMs ?? DEFAULT_TIMEOUT_MS, budget),
        waitMs: Math.min(deps.money?.waitMs ?? 8_000, budget),
      };
      let out: Outcome;
      try {
        out = await postOne(db, session, c, mode, money, clock);
      } catch (err) {
        out = ofError(err);
      }
      if (out.result === "refused") {
        summary.refused += 1;
        notes.push(`${c.kind}:${c.id}:${out.category ?? "refused"}`);
        continue;
      }
      summary.tried += 1;
      // An unknown post counts as pending: the reconcile pass reads it back.
      summary[out.result === "unknown" ? "pending" : out.result] += 1;
      if (out.result !== "confirmed") notes.push(`${c.kind}:${c.id}:${out.category ?? out.result}`);
      if (out.result === "unknown") {
        stop = "unknown";
        break;
      }
      if (out.category === "rate_limited") {
        stop = "rate_limited";
        break;
      }
    }
    if (stop === "empty" && candidates.length >= opts.maxItems + LOOKAHEAD) stop = "max_items";
  }
  // Then read back what is still unknown, while time is left.
  let reconciled: ReconcileSummary | null = null;
  if (left() >= BOOKS_MIN_LEFT_MS && flags.books.enabled === true) {
    try {
      reconciled = await reconcileMoneyActions(
        db,
        session,
        // One row a wake: its timeout is figured once from the time left, so more rows could
        // run past the step's budget.
        { limit: 1, hooks: booksReconcileHooks(db, tenantId, deps.money ?? {}, accounting) },
        {
          ...deps.money,
          accounting,
          timeoutMs: Math.min(deps.money?.timeoutMs ?? DEFAULT_TIMEOUT_MS, Math.max(1, left() - CALL_MARGIN_MS)),
        },
      );
    } catch (err) {
      notes.push(`reconcile:${categoryOf(err)}`);
    }
  }
  const r = reconciled;
  log(
    `books: ${mode} tenant=${tenantId} tried=${summary.tried} confirmed=${summary.confirmed} ` +
      `failed=${summary.failed} pending=${summary.pending} refused=${summary.refused} stop=${stop} ` +
      `reconciled=${r ? `${r.checked}/${r.confirmed}/${r.failed}/${r.stillUnknown}` : "-"}` +
      (notes.length > 0 ? ` notes=${notes.slice(0, 8).join(",")}` : ""),
  );
  return { ok: true, ...summary, stop, reconciled };
}

// The backfill script's dry run only: what postBooksHistory would try next, oldest first, read in
// one statement and written nowhere. The switches are not asked: a dry run posts nothing.
export async function previewBooksHistory(
  session: Session,
  since: LocalDate,
  limit: number,
  deps: Pick<BooksDeps, "db" | "retryAfterMinutes"> = {},
): Promise<Candidate[]> {
  if (!isLocalDate(since) || !Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new RangeError("since must be a date and limit 1 to 5000");
  }
  return readCandidates(
    deps.db ?? getDb(),
    session.tenantId,
    "history",
    since,
    limit,
    deps.retryAfterMinutes ?? BOOKS_RETRY_AFTER_MINUTES,
  );
}

// The desk wake's step: records dated on or after books.startDate only, queue-made invoices and
// payments recorded on the form only.
export function postPendingBooks(session: Session, opts: BooksOptions, deps: BooksDeps = {}): Promise<BooksSummary> {
  return runBooks(session, opts, deps, "step");
}

// The backfill script's entry only: the same step over older history, seeded invoices and
// payments included. Never called from a route or a schedule.
export function postBooksHistory(session: Session, opts: BooksOptions, deps: BooksDeps = {}): Promise<BooksSummary> {
  return runBooks(session, opts, deps, "history");
}
