import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { AccountingAdapter, InvoiceEmailStatus, ReadBack, SendOutcome } from "../adapters/types";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { EXECUTORS, executeProposal } from "../proposals/execute";
import { INVOICE_REVIEW_STATUSES, type InvoiceReviewStatus } from "../rules-engine";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan, type CarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { addDays, localDateOf, type LocalDate } from "../time/local-date";
import { invoicePostExecutor, type InvoiceMoneyDeps } from "./execute";
import { postInvoice, reconcileInvoice } from "./post";
import { proposeInvoices } from "./propose";
import { markReviewed, markSent } from "./review";
import { readInvoiceReview, readMemberRoles, readReviewQueue } from "./review-read";

// The invoice review against a real database seeded with both demo carriers, as the app's role:
// the 0028 columns, the planted review statuses, posting as unsent, marking reviewed and sent, the
// accounting sync errors and their settles, an amount changed after posting, and row security.
// The accounting system is a test double; nothing here calls QuickBooks, a model or the network,
// and nothing is ever sent. The clock is fixed. Two tenant rows carry the demo slugs (the seed
// checks them); the fresh test database has no others, and both are removed after.

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const clock = () => new Date(NOW);
const saved = { ...flags, invoiceLimits: { ...flags.invoiceLimits }, approverRole: { ...flags.approverRole } };

type Carrier = { carrier: DemoCarrier; id: string; plan: CarrierPlan; session: Session; today: LocalDate };

const tenants: Carrier[] = DEMO_CARRIERS.map((carrier) => {
  const id = randomUUID();
  return {
    carrier,
    id,
    plan: buildCarrierPlan(carrier, golden.anchor),
    session: { sub: `review-admin-${carrier.slug}`, email: "", tenantId: id },
    today: localDateOf(new Date(NOW).toISOString(), carrier.timezone),
  };
});
const [BR, PW] = tenants;

let admin: Db;
let app: Db;

// Admin reads and writes, always filtered to the tenant (the admin login skips row security).
const adminRows = <T extends object>(t: Carrier, sql: string, params: Param[] = []) =>
  admin.withTenant(t.id, (q) => q.query<T>(sql, params));
const adminWrite = (t: Carrier, sql: string, params: Param[] = []) =>
  admin.withTenant(t.id, (q) => q.execute(sql, params));

type StoredInvoice = {
  id: string;
  invoice_number: string;
  customer_id: string;
  load_id: string | null;
  amount_cents: string;
  issued_on: string;
  qbo_id: string | null;
  qbo_email_status: string | null;
  qbo_amount_cents: string | null;
  reviewed_at: string | null;
  reviewed_by_membership_id: string | null;
  review_note: string | null;
  sent_on: string | null;
  sent_by_membership_id: string | null;
};

const stored = async (t: Carrier, id: string): Promise<StoredInvoice> => {
  const [row] = await adminRows<StoredInvoice>(
    t,
    `SELECT id, invoice_number, customer_id, load_id, amount_cents::text, CAST(issued_on AS text) AS issued_on,
            qbo_id, qbo_email_status, qbo_amount_cents::text, CAST(reviewed_at AS text) AS reviewed_at,
            reviewed_by_membership_id, review_note, CAST(sent_on AS text) AS sent_on, sent_by_membership_id
       FROM invoices WHERE tenant_id = $1 AND id = CAST($2 AS uuid)`,
    [t.id, id],
  );
  if (!row) throw new Error(`invoice ${id} is not in ${t.carrier.slug}`);
  return row;
};

const ledgerFor = (t: Carrier, subjectId: string) =>
  adminRows<{ kind: string; state: string; attempt: number; failure_category: string | null }>(
    t,
    `SELECT kind, state, attempt, failure_category FROM money_actions
      WHERE tenant_id = $1 AND subject_id = CAST($2 AS uuid) ORDER BY attempt`,
    [t.id, subjectId],
  );

const memberId = async (t: Carrier) =>
  (
    await adminRows<{ id: string }>(t, "SELECT id FROM memberships WHERE tenant_id = $1 AND cognito_sub = $2", [
      t.id,
      t.session.sub,
    ])
  )[0].id;

// The review as the app role reads it, inside the tenant's own transaction.
const reviewOf = (t: Carrier, id: string) => app.withTenant(t.id, (q) => readInvoiceReview(q, id));
const queueOf = (t: Carrier, status?: InvoiceReviewStatus) => app.withTenant(t.id, (q) => readReviewQueue(q, status));

// Set a customer's billing address for the length of fn, then put the stored one back.
async function withBillingEmail<T>(t: Carrier, customerId: string, email: string | null, fn: () => Promise<T>) {
  const [before] = await adminRows<{ billing_email: string | null }>(
    t,
    "SELECT billing_email FROM customers WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
    [t.id, customerId],
  );
  await adminWrite(t, "UPDATE customers SET billing_email = $3 WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
    t.id,
    customerId,
    email,
  ]);
  try {
    return await fn();
  } finally {
    await adminWrite(t, "UPDATE customers SET billing_email = $3 WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
      t.id,
      customerId,
      before.billing_email,
    ]);
  }
}

type CreateArgs = Parameters<AccountingAdapter["createInvoice"]>[1];

// An accounting system double that answers invoice creates as told: confirmed and waiting in its
// send queue (the reply carries NeedToSend), a timeout, or a validation refusal. A read-back
// answers what it was last told. It keeps every create it was asked for.
function testBooks() {
  const seen = { creates: [] as CreateArgs[], readBacks: 0 };
  let answer: "confirm" | "timeout" | "refuse" = "confirm";
  let readBackAnswer: ReadBack = { found: false };
  const unused = async (): Promise<never> => {
    throw new Error("not used by the invoice review");
  };
  const adapter: AccountingAdapter = {
    system: "qbo_sandbox",
    ready: async () => ({ ok: true }),
    ensureCustomer: async (_q, c) => ({ outsideId: `C-${c.code}` }),
    ensureVendor: unused,
    createInvoice: async (_q, inv): Promise<SendOutcome> => {
      seen.creates.push(inv);
      if (answer === "timeout") return { kind: "unknown", category: "timeout" };
      if (answer === "refuse") return { kind: "failed", category: "validation", httpStatus: 400 };
      return {
        kind: "confirmed",
        system: "qbo_sandbox",
        type: "Invoice",
        id: `QI-${seen.creates.length}`,
        ref: inv.invoiceNumber,
        amountCents: inv.lines.reduce((s, l) => s + l.amountCents, 0),
        emailStatus: "NeedToSend",
      };
    },
    createBill: unused,
    payBill: unused,
    createExpense: unused,
    recordCustomerPayment: unused,
    readBack: async () => {
      seen.readBacks += 1;
      return readBackAnswer;
    },
  };
  return {
    adapter,
    seen,
    answerInvoices(a: "confirm" | "timeout" | "refuse") {
      answer = a;
    },
    answerReadBack(a: ReadBack) {
      readBackAnswer = a;
    },
  };
}

const moneyDeps = (books: ReturnType<typeof testBooks>): InvoiceMoneyDeps => ({
  accounting: books.adapter,
  waitMs: 2_000,
  pollMs: 10,
  log: () => {},
});

const found = (inv: StoredInvoice, emailStatus?: InvoiceEmailStatus): ReadBack => ({
  found: true,
  system: "qbo_sandbox",
  type: "Invoice",
  id: `QI-RB-${inv.invoice_number}`,
  amountCents: Number(inv.amount_cents),
  status: "succeeded",
  ...(emailStatus ? { emailStatus } : {}),
});

const withAccounting = async <T>(fn: () => Promise<T>): Promise<T> => {
  flags.accountingEnabled = true;
  try {
    return await fn();
  } finally {
    flags.accountingEnabled = false;
  }
};

describe("invoice review against a seeded database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug IN ($1, $2) ORDER BY slug", [
        BR.carrier.slug,
        PW.carrier.slug,
      ]),
    );
    if (leftover.length > 0) {
      throw new Error(
        `a tenant ${leftover[0].slug} already exists: the database tests need a fresh database ` +
          "(npm run test:db:fresh)",
      );
    }
    for (const t of tenants) {
      await admin.withTenant(t.id, async (q) => {
        await q.execute(
          "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)",
          [t.carrier.slug, t.carrier.name, t.carrier.timezone],
        );
        await q.execute(
          `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
           VALUES (current_tenant_id(), $1, $2, 'admin')`,
          [t.session.sub, `admin@${t.carrier.slug}.example`],
        );
      });
      await replaceTenantData(app, t.id, t.plan);
    }
    flags.invoicesEnabled = true;
    flags.invoiceReviewEnabled = true;
    flags.accountingEnabled = false;
    flags.auditorEnabled = false;
    flags.auditorRequired = false;
  }, 120_000);

  afterAll(async () => {
    Object.assign(flags, saved);
    // Only what this file made: the ledger rows (the app role has no DELETE on them), then the two
    // tenants, whose other rows go with them. Then a read proves nothing of either is left.
    for (const t of tenants) {
      await admin?.withTenant(t.id, (q) =>
        q.execute("DELETE FROM money_actions WHERE tenant_id = current_tenant_id()"),
      );
      await admin?.withTenant(t.id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    const left = await admin?.withoutTenant((q) =>
      q.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM tenants WHERE id IN (CAST($1 AS uuid), CAST($2 AS uuid)))
              + (SELECT count(*) FROM invoices WHERE tenant_id IN (CAST($1 AS uuid), CAST($2 AS uuid)))
              + (SELECT count(*) FROM money_actions WHERE tenant_id IN (CAST($1 AS uuid), CAST($2 AS uuid))) AS n`,
        [BR.id, PW.id],
      ),
    );
    await app?.close();
    await admin?.close();
    if (left && Number(left[0].n) !== 0) throw new Error(`cleanup left ${left[0].n} rows behind`);
  });

  it("has the review columns and their checks once 0028 has run after 0015", async () => {
    const cols = await admin.withoutTenant((q) =>
      q.query<{ table_name: string; column_name: string; data_type: string }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public'
            AND ((table_name = 'invoices' AND column_name IN ('reviewed_at', 'reviewed_by_membership_id',
                   'review_note', 'sent_on', 'sent_by_membership_id', 'qbo_email_status', 'qbo_amount_cents'))
              OR (table_name = 'customers' AND column_name IN ('pod_required', 'billing_email')))
          ORDER BY table_name, column_name`,
      ),
    );
    expect(cols.map((c) => `${c.table_name}.${c.column_name}:${c.data_type}`)).toEqual([
      "customers.billing_email:text",
      "customers.pod_required:boolean",
      "invoices.qbo_amount_cents:bigint",
      "invoices.qbo_email_status:text",
      "invoices.review_note:text",
      "invoices.reviewed_at:timestamp with time zone",
      "invoices.reviewed_by_membership_id:uuid",
      "invoices.sent_by_membership_id:uuid",
      "invoices.sent_on:date",
    ]);
    const checks = await admin.withoutTenant((q) =>
      q.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'invoices'::regclass AND conname IN ('invoices_reviewed_pair',
            'invoices_review_note_needs_review', 'invoices_sent_pair', 'invoices_sent_after_issue',
            'invoices_qbo_pair', 'invoices_reviewed_by_fk', 'invoices_sent_by_fk')
          ORDER BY conname`,
      ),
    );
    expect(checks).toHaveLength(7);
    // A real address shape is refused by the table itself, not only by the adapter.
    const customer = BR.plan.rows.customers[0];
    await expect(
      adminWrite(BR, "UPDATE customers SET billing_email = 'ar@example.com' WHERE tenant_id = $1 AND id = $2", [
        BR.id,
        customer.id,
      ]),
    ).rejects.toThrow();
    // An accounting id is never stored without its amount.
    const inv = BR.plan.planted.invoiceReview.readyInvoiceId;
    await expect(
      adminWrite(BR, "UPDATE invoices SET qbo_id = 'QI-X' WHERE tenant_id = $1 AND id = $2", [BR.id, inv]),
    ).rejects.toThrow();
    expect((await stored(BR, inv)).qbo_id).toBeNull();
  });

  it("reads every seeded plant back as planted, for both carriers", async () => {
    for (const t of tenants) {
      const r = t.plan.planted.invoiceReview;
      const queue = await queueOf(t);
      expect(queue.counts, t.carrier.slug).toEqual({
        sync_error: 0,
        rate_mismatch: 1,
        missing_documents: 1,
        duplicate_warning: 2,
        needs_review: r.needsReviewInvoiceIds.length,
        ready_to_send: 1,
      });
      const ids = (s: InvoiceReviewStatus) => queue.rows.filter((x) => x.status === s).map((x) => x.id).sort();
      expect(ids("rate_mismatch")).toEqual([r.rateMismatchInvoiceId]);
      expect(ids("missing_documents")).toEqual([r.missingDocumentsInvoiceId]);
      expect(ids("duplicate_warning")).toEqual([...r.duplicateInvoiceIds].sort());
      expect(ids("needs_review")).toEqual([...r.needsReviewInvoiceIds].sort());
      expect(ids("ready_to_send")).toEqual([r.readyInvoiceId]);
      // Worst first, in the engine's order.
      const ranks = queue.rows.map((x) => INVOICE_REVIEW_STATUSES.indexOf(x.status));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      // One status filters the rows and keeps the whole queue's counts.
      const dup = await queueOf(t, "duplicate_warning");
      expect(dup.rows.map((x) => x.id).sort()).toEqual([...r.duplicateInvoiceIds].sort());
      expect(dup.counts).toEqual(queue.counts);
      // Every seeded customer has a synthetic billing address; the two document customers ask for one.
      const customers = await adminRows<{ id: string; pod_required: boolean; billing_email: string | null }>(
        t,
        "SELECT id, pod_required, billing_email FROM customers WHERE tenant_id = $1",
        [t.id],
      );
      expect(customers.every((c) => /^[a-z0-9._-]+@[a-z0-9-]+\.example$/.test(c.billing_email ?? ""))).toBe(true);
      expect(customers.filter((c) => c.pod_required).map((c) => c.id).sort()).toEqual([...r.podCustomerIds].sort());
      // The duplicate's warning names the other invoice; the missing document names the load.
      const second = await reviewOf(t, r.duplicateInvoiceIds[1]);
      expect(second?.duplicates.map((d) => d.id)).toEqual([r.duplicateInvoiceIds[0]]);
      const missing = await reviewOf(t, r.missingDocumentsInvoiceId);
      expect(missing?.review.reasons).toEqual(["no_delivery_document", "not_reviewed"]);
      expect(missing?.podRequired).toBe(true);
    }
  });

  it("refuses to write while the review switch is off, and changes nothing", async () => {
    const id = BR.plan.planted.invoiceReview.needsReviewInvoiceIds[0];
    flags.invoiceReviewEnabled = false;
    try {
      expect(await markReviewed(app, BR.session, id, null, clock())).toEqual({ ok: false, category: "disabled" });
      expect(await markSent(app, BR.session, id, BR.today, clock())).toEqual({ ok: false, category: "disabled" });
    } finally {
      flags.invoiceReviewEnabled = true;
    }
    expect(await stored(BR, id)).toMatchObject({ reviewed_at: null, sent_on: null });
  });

  describe("a customer with no billing address", () => {
    it("is refused before anything is reserved when posted from the record page", async () => {
      const id = BR.plan.planted.invoiceReview.needsReviewInvoiceIds[2];
      const inv = await stored(BR, id);
      const books = testBooks();
      const out = await withAccounting(() =>
        withBillingEmail(BR, inv.customer_id, null, () => postInvoice(app, BR.session, id, moneyDeps(books))),
      );
      expect(out).toEqual({ ok: false, category: "no_billing_address" });
      expect(await ledgerFor(BR, id)).toEqual([]);
      expect(books.seen.creates).toEqual([]);
      expect((await stored(BR, id)).qbo_id).toBeNull();
    });

    it("keeps the approved invoice unposted, finishes the card, and reserves nothing", async () => {
      expect(await proposeInvoices(app, PW.session, clock())).toMatchObject({ ok: true });
      const [card] = await adminRows<{ id: string; subject_id: string }>(
        PW,
        `SELECT id, subject_id FROM proposals WHERE tenant_id = $1 AND kind = 'invoice_post' AND status = 'proposed'
          ORDER BY created_at, id LIMIT 1`,
        [PW.id],
      );
      const [load] = await adminRows<{ customer_id: string }>(
        PW,
        "SELECT customer_id FROM loads WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
        [PW.id, card.subject_id],
      );
      const books = testBooks();
      const executors = { ...EXECUTORS, invoice_post: invoicePostExecutor(moneyDeps(books)) };
      const out = await withAccounting(() =>
        withBillingEmail(PW, load.customer_id, null, () =>
          executeProposal(PW.session, card.id, { confirmed: true }, { db: app, clock, executors }),
        ),
      );
      expect(out).toMatchObject({ ok: true, status: "done" });
      const [after] = await adminRows<{ status: string; decision_note: string | null; money_action_id: string | null }>(
        PW,
        "SELECT status, decision_note, money_action_id FROM proposals WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
        [PW.id, card.id],
      );
      expect(after).toEqual({ status: "done", decision_note: "no_billing_address", money_action_id: null });
      const [written] = await adminRows<{ id: string; qbo_id: string | null }>(
        PW,
        "SELECT id, qbo_id FROM invoices WHERE tenant_id = $1 AND load_id = CAST($2 AS uuid)",
        [PW.id, card.subject_id],
      );
      expect(written.qbo_id).toBeNull();
      expect(await ledgerFor(PW, written.id)).toEqual([]);
      expect(books.seen.creates).toEqual([]);
      // The new invoice waits in the review queue, unreviewed and unposted.
      const view = await reviewOf(PW, written.id);
      expect(view?.review.reasons).toContain("not_reviewed");
      expect(view).toMatchObject({ posted: false, inQueue: true });
    });
  });

  describe("posting as unsent, then review and the recorded send", () => {
    const id = BR.plan.planted.invoiceReview.needsReviewInvoiceIds[0];

    it("posts the invoice into the accounting system's send queue with its billing address", async () => {
      const before = await stored(BR, id);
      expect(before.issued_on <= BR.today).toBe(true);
      const [customer] = await adminRows<{ billing_email: string }>(
        BR,
        "SELECT billing_email FROM customers WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
        [BR.id, before.customer_id],
      );
      const books = testBooks();
      const out = await withAccounting(() => postInvoice(app, BR.session, id, moneyDeps(books)));
      expect(out).toMatchObject({ ok: true, state: "confirmed" });
      expect(books.seen.creates).toHaveLength(1);
      expect(books.seen.creates[0].billingEmail).toBe(customer.billing_email);
      expect(customer.billing_email).toMatch(/\.example$/);
      const after = await stored(BR, id);
      expect(after).toMatchObject({
        qbo_id: "QI-1",
        qbo_email_status: "need_to_send",
        qbo_amount_cents: before.amount_cents,
        reviewed_at: null,
        sent_on: null,
      });
      const view = await reviewOf(BR, id);
      expect(view?.review.status).toBe("needs_review");
      expect(view?.review.reasons).toEqual(["not_reviewed"]);
      expect(view).toMatchObject({ posted: true, emailStatus: "need_to_send", inQueue: true });
    });

    it("refuses to record a send before the invoice is reviewed", async () => {
      expect(await markSent(app, BR.session, id, BR.today, clock())).toEqual({ ok: false, category: "not_ready" });
      expect((await stored(BR, id)).sent_on).toBeNull();
    });

    it("marks it reviewed once, with who and the note, and it reads ready to send", async () => {
      expect(await markReviewed(app, BR.session, id, "  Checked the rate.  ", clock())).toEqual({
        ok: true,
        changed: true,
      });
      expect(await markReviewed(app, BR.session, id, "Again.", clock())).toEqual({ ok: true, changed: false });
      const member = await memberId(BR);
      const row = await stored(BR, id);
      expect(row.reviewed_by_membership_id).toBe(member);
      expect(row.review_note).toBe("Checked the rate.");
      expect(new Date(row.reviewed_at!).getTime()).toBe(NOW);
      const view = await reviewOf(BR, id);
      expect(view?.review).toMatchObject({ status: "ready_to_send", reasons: [] });
      expect(view?.inQueue).toBe(true);
      const roles = await app.withTenant(BR.id, (q) => readMemberRoles(q, [member, null, "not-a-uuid"]));
      expect([...roles]).toEqual([[member, "admin"]]);
    });

    it("refuses a bad note and a send date outside the invoice date and today", async () => {
      const other = BR.plan.planted.invoiceReview.needsReviewInvoiceIds[1];
      expect(await markReviewed(app, BR.session, other, "x".repeat(241), clock())).toEqual({
        ok: false,
        category: "validation",
      });
      expect(await markReviewed(app, BR.session, other, "line\u0007bell", clock())).toEqual({
        ok: false,
        category: "validation",
      });
      const issued = (await stored(BR, id)).issued_on as LocalDate;
      for (const bad of [addDays(BR.today, 1), addDays(issued, -1), "2026-13-01", 20261102]) {
        expect(await markSent(app, BR.session, id, bad, clock()), String(bad)).toEqual({
          ok: false,
          category: "validation",
        });
      }
      expect((await stored(BR, id)).sent_on).toBeNull();
      expect((await stored(BR, other)).reviewed_at).toBeNull();
    });

    it("records the send once: a repeat changes nothing, and it leaves the queue", async () => {
      expect(await markSent(app, BR.session, id, BR.today, clock())).toEqual({ ok: true, changed: true });
      expect(await markSent(app, BR.session, id, BR.today, clock())).toEqual({ ok: true, changed: false });
      const row = await stored(BR, id);
      expect(row).toMatchObject({ sent_on: BR.today, sent_by_membership_id: await memberId(BR) });
      const view = await reviewOf(BR, id);
      expect(view).toMatchObject({ sentOn: BR.today, inQueue: false });
      expect((await queueOf(BR)).rows.map((x) => x.id)).not.toContain(id);
      // Nothing was sent anywhere: the one ledger row is the post itself.
      expect(await ledgerFor(BR, id)).toEqual([
        { kind: "invoice", state: "confirmed", attempt: 1, failure_category: null },
      ]);
    });

    it("refuses to record a send for an invoice that was never posted", async () => {
      const ready = BR.plan.planted.invoiceReview.readyInvoiceId;
      expect((await reviewOf(BR, ready))?.review.status).toBe("ready_to_send");
      expect(await markSent(app, BR.session, ready, BR.today, clock())).toEqual({
        ok: false,
        category: "not_posted",
      });
      expect((await stored(BR, ready)).sent_on).toBeNull();
    });
  });

  describe("accounting sync errors", () => {
    it("reads a timed-out post as a sync error until Check settles it", async () => {
      const id = BR.plan.planted.invoiceReview.needsReviewInvoiceIds[1];
      const inv = await stored(BR, id);
      const books = testBooks();
      books.answerInvoices("timeout");
      await withAccounting(async () => {
        expect(await postInvoice(app, BR.session, id, moneyDeps(books))).toMatchObject({ ok: true, state: "unknown" });
        const unknown = await reviewOf(BR, id);
        expect(unknown?.review.status).toBe("sync_error");
        expect(unknown?.review.reasons).toEqual(["posting_unknown", "not_reviewed"]);
        expect(unknown?.posted).toBe(false);
        expect((await queueOf(BR, "sync_error")).rows.map((x) => x.id)).toEqual([id]);
        // A mark as sent is refused while the post is unsettled.
        expect(await markSent(app, BR.session, id, BR.today, clock())).toEqual({ ok: false, category: "not_posted" });

        books.answerReadBack(found(inv, "NeedToSend"));
        expect(await reconcileInvoice(app, BR.session, id, moneyDeps(books))).toEqual({
          ok: true,
          summary: { checked: 1, confirmed: 1, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 },
        });
      });
      expect(books.seen.creates).toHaveLength(1);
      expect(books.seen.readBacks).toBe(1);
      expect(await stored(BR, id)).toMatchObject({
        qbo_id: `QI-RB-${inv.invoice_number}`,
        qbo_email_status: "need_to_send",
        qbo_amount_cents: inv.amount_cents,
      });
      const settled = await reviewOf(BR, id);
      expect(settled?.review).toMatchObject({ status: "needs_review", reasons: ["not_reviewed"] });
    });

    it("reads a refused post as a sync error, and Retry posts again as attempt 2", async () => {
      const id = PW.plan.planted.invoiceReview.needsReviewInvoiceIds[0];
      const books = testBooks();
      books.answerInvoices("refuse");
      await withAccounting(async () => {
        expect(await postInvoice(app, PW.session, id, moneyDeps(books))).toMatchObject({ ok: true, state: "failed" });
        const failed = await reviewOf(PW, id);
        expect(failed?.review.status).toBe("sync_error");
        expect(failed?.review.reasons).toEqual(["posting_failed", "not_reviewed"]);
        expect(failed?.reasons[0].sentence).toMatch(/^The post to accounting failed: /);
        expect(failed?.reasons[0].sentence).not.toMatch(/400|validation/);
        books.answerInvoices("confirm");
        expect(await postInvoice(app, PW.session, id, moneyDeps(books))).toMatchObject({
          ok: true,
          state: "confirmed",
        });
      });
      expect(await ledgerFor(PW, id)).toEqual([
        { kind: "invoice", state: "failed", attempt: 1, failure_category: "validation" },
        { kind: "invoice", state: "confirmed", attempt: 2, failure_category: null },
      ]);
      expect(books.seen.creates).toHaveLength(2);
      expect((await reviewOf(PW, id))?.review).toMatchObject({ status: "needs_review", reasons: ["not_reviewed"] });
    });
  });

  it("flags an invoice whose amount changed after it was posted", async () => {
    // The detention executor never raises a posted invoice (it requires qbo_id IS NULL), so the
    // amendment is written here directly: one detention line on the load and the same cents on
    // the invoice, as a later correction would. The engine's total then agrees with the invoice;
    // only the accounting system's copy is behind.
    const id = PW.plan.planted.invoiceReview.needsReviewInvoiceIds[0];
    const before = await stored(PW, id);
    expect(before.qbo_amount_cents).toBe(before.amount_cents);
    expect(before.load_id).not.toBeNull();
    await admin.withTenant(PW.id, async (q) => {
      await q.execute(
        `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, description)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'detention',
                 (SELECT COALESCE(MAX(seq), 0) + 1 FROM load_accessorials
                   WHERE tenant_id = current_tenant_id() AND load_id = CAST($2 AS uuid) AND kind = 'detention'),
                 15000, 'Detention at delivery, 3 hours')`,
        [randomUUID(), before.load_id],
      );
      await q.execute(
        "UPDATE invoices SET amount_cents = amount_cents + 15000 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [id],
      );
    });
    const view = await reviewOf(PW, id);
    expect(view?.review.status).toBe("rate_mismatch");
    expect(view?.review.reasons).toEqual(["posted_amount_differs", "not_reviewed"]);
    const held = (Number(before.qbo_amount_cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
    expect(view?.reasons[0].sentence).toBe(`The accounting system holds this invoice at $${held}.`);
    expect(view?.inQueue).toBe(true);
  });

  it("keeps each carrier's reviews to itself", async () => {
    const brInvoice = BR.plan.planted.invoiceReview.needsReviewInvoiceIds[2];
    expect(await reviewOf(PW, brInvoice)).toBeNull();
    expect(await markReviewed(app, PW.session, brInvoice, "Not mine.", clock())).toEqual({
      ok: false,
      category: "not_found",
    });
    expect(await markSent(app, PW.session, brInvoice, PW.today, clock())).toEqual({
      ok: false,
      category: "not_found",
    });
    const pwQueue = await queueOf(PW);
    const brIds = new Set(BR.plan.rows.invoices.map((i) => i.id));
    expect(pwQueue.rows.some((x) => brIds.has(x.id))).toBe(false);
    // A session for one carrier cannot name the other's tenant.
    await expect(
      markReviewed(app, { ...PW.session, tenantId: BR.id }, brInvoice, null, clock()),
    ).rejects.toThrow();
    expect(await stored(BR, brInvoice)).toMatchObject({ reviewed_at: null, review_note: null, sent_on: null });
  });
});
