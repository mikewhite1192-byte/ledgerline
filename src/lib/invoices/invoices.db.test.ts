import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { AccountingAdapter, ReadBack, SendOutcome } from "../adapters/types";
import { runAudit } from "../agent/auditor/run";
import { callTool } from "../agent/gateway";
import { paymentReapplyLimit } from "../agent/gateway/limits";
import type { CompleteFn, GatewayContext, ToolCall } from "../agent/gateway/types";
import type { AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { readInvoiceQueue, readReceivablesInput } from "../data/read";
import { createPgDb } from "../db/pg";
import { refreshPlannerStats } from "../db/test-stats";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { dbLedgerStore, type LedgerStore } from "../money/execute";
import { EXECUTORS, executeProposal, type ExecutorRegistry } from "../proposals/execute";
import { rejectProposal } from "../proposals/reject";
import { findPaymentOnWrongInvoice } from "../rules-engine";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan, type CarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { addDays, type LocalDate } from "../time/local-date";
import { invoicePostExecutor, type InvoiceMoneyDeps } from "./execute";
import { matchWrongInvoiceFinding } from "./match";
import { postCustomerPayment, reconcileCustomerPayment, recordCustomerPayment } from "./payments";
import { postInvoice, reconcileInvoice } from "./post";
import { proposeInvoices } from "./propose";
import { splitInvoiceQueue } from "./queue";

// The invoice queue, invoice approval, posting, customer payments and the planted payment on the
// wrong invoice, against a real database seeded with both demo carriers, as the app's role. The
// accounting system is a test double; nothing here calls a model, QuickBooks or the network. The
// clock is fixed. Two tenant rows carry the demo slugs; the fresh test database has no others with
// those slugs, and both are removed after (their ledger rows first, by the admin login).

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const TODAY: LocalDate = "2026-11-02";
const HOUR = 3_600_000;
const clock = () => new Date(NOW);
const saved = {
  ...flags,
  invoiceLimits: { ...flags.invoiceLimits },
  customerPaymentLimits: { ...flags.customerPaymentLimits },
  approverRole: { ...flags.approverRole },
};

type Carrier = { carrier: DemoCarrier; id: string; plan: CarrierPlan; session: Session };

const tenants: Carrier[] = DEMO_CARRIERS.map((carrier) => {
  const id = randomUUID();
  return {
    carrier,
    id,
    plan: buildCarrierPlan(carrier, golden.anchor),
    session: { sub: `invoices-admin-${carrier.slug}`, email: "", tenantId: id },
  };
});
const [BR, PW] = tenants;

let admin: Db;
let app: Db;
let app2: Db;

// Admin reads and writes, always filtered to the tenant (the admin login skips row security).
const adminRows = <T extends object>(t: Carrier, sql: string, params: Param[] = []) =>
  admin.withTenant(t.id, (q) => q.query<T>(sql, params));
const adminWrite = (t: Carrier, sql: string, params: Param[] = []) =>
  admin.withTenant(t.id, (q) => q.execute(sql, params));

type Card = { id: string; subject_id: string; status: string; decision_note: string | null; amount_cents: string };

// Every card is made at the test's fixed instant and card ids are random, so the seeded load id
// orders them: "the first waiting card" is the same card on every run.
const cards = (t: Carrier) =>
  adminRows<Card>(
    t,
    `SELECT id, subject_id, status, decision_note, amount_cents::text FROM proposals
      WHERE tenant_id = $1 AND kind = 'invoice_post' ORDER BY created_at, subject_id, id`,
    [t.id],
  );

const waitingCards = async (t: Carrier) => (await cards(t)).filter((c) => c.status === "proposed");

type InvoiceRow = {
  id: string;
  invoice_number: string;
  amount_cents: string;
  issued_on: string;
  due_on: string;
  status: string;
  qbo_id: string | null;
  customer_id: string;
};

const invoicesFor = (t: Carrier, loadId: string) =>
  adminRows<InvoiceRow>(
    t,
    `SELECT id, invoice_number, amount_cents::text, CAST(issued_on AS text) AS issued_on,
            CAST(due_on AS text) AS due_on, status, qbo_id, customer_id
       FROM invoices WHERE tenant_id = $1 AND load_id = CAST($2 AS uuid)`,
    [t.id, loadId],
  );

const invoiceById = async (t: Carrier, id: string) =>
  (
    await adminRows<InvoiceRow>(
      t,
      `SELECT id, invoice_number, amount_cents::text, CAST(issued_on AS text) AS issued_on,
              CAST(due_on AS text) AS due_on, status, qbo_id, customer_id
         FROM invoices WHERE tenant_id = $1 AND id = CAST($2 AS uuid)`,
      [t.id, id],
    )
  )[0];

const ledgerFor = (t: Carrier, subjectId: string) =>
  adminRows<{ kind: string; state: string; attempt: number; proposal_id: string | null }>(
    t,
    `SELECT kind, state, attempt, proposal_id FROM money_actions
      WHERE tenant_id = $1 AND subject_id = CAST($2 AS uuid) ORDER BY attempt`,
    [t.id, subjectId],
  );

const proposalById = async (t: Carrier, id: string) =>
  (
    await adminRows<{ status: string; decision_note: string | null; money_action_id: string | null }>(
      t,
      "SELECT status, decision_note, money_action_id FROM proposals WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
      [t.id, id],
    )
  )[0];

// The next number after the seed's own invoices, from the plan.
function nextNumber(t: Carrier, ahead: number): string {
  const prefix = `${t.plan.rows.invoices[0].invoice_number.split("-INV-")[0]}-INV-`;
  const top = Math.max(...t.plan.rows.invoices.map((i) => Number(i.invoice_number.slice(prefix.length))));
  return `${prefix}${top + ahead}`;
}

type ReadBackRef = Parameters<AccountingAdapter["readBack"]>[1];

// An accounting system double: it confirms every write, or answers "timeout" for invoices or
// payments while told to. A read-back answers what it was last told (nothing found, by default).
// It keeps what it was asked to create and to read back.
function testBooks() {
  const seen = { customers: 0, invoices: [] as string[], payments: [] as string[], readBacks: [] as ReadBackRef[] };
  let invoiceAnswer: "confirm" | "timeout" = "confirm";
  let paymentAnswer: "confirm" | "timeout" = "confirm";
  let readBackAnswer: ReadBack = { found: false };
  const unused = async (): Promise<never> => {
    throw new Error("not used by invoices");
  };
  const adapter: AccountingAdapter = {
    system: "qbo_sandbox",
    ready: async () => ({ ok: true }),
    ensureCustomer: async (_q, c) => {
      seen.customers += 1;
      return { outsideId: `C-${c.code}` };
    },
    ensureVendor: unused,
    createInvoice: async (_q, inv): Promise<SendOutcome> => {
      seen.invoices.push(inv.invoiceNumber);
      if (invoiceAnswer === "timeout") return { kind: "unknown", category: "timeout" };
      return {
        kind: "confirmed",
        system: "qbo_sandbox",
        type: "Invoice",
        id: `QI-${seen.invoices.length}`,
        ref: inv.invoiceNumber,
        amountCents: inv.lines.reduce((s, l) => s + l.amountCents, 0),
      };
    },
    createBill: unused,
    payBill: unused,
    createExpense: unused,
    recordCustomerPayment: async (_q, p): Promise<SendOutcome> => {
      seen.payments.push(p.paymentRef);
      if (paymentAnswer === "timeout") return { kind: "unknown", category: "timeout" };
      return {
        kind: "confirmed",
        system: "qbo_sandbox",
        type: "Payment",
        id: `QP-${seen.payments.length}`,
        amountCents: p.amountCents,
      };
    },
    readBack: async (_q, ref) => {
      seen.readBacks.push(ref);
      return readBackAnswer;
    },
  };
  return {
    adapter,
    seen,
    answerInvoices(a: "confirm" | "timeout") {
      invoiceAnswer = a;
    },
    answerPayments(a: "confirm" | "timeout") {
      paymentAnswer = a;
    },
    answerReadBack(a: ReadBack) {
      readBackAnswer = a;
    },
  };
}

function moneyDeps(books: ReturnType<typeof testBooks>, lines: string[]): InvoiceMoneyDeps {
  return { accounting: books.adapter, waitMs: 2_000, pollMs: 10, log: (l) => lines.push(l) };
}

// The production registry, with the invoice executor's money deps swapped for the test's.
const registryWith = (money: InvoiceMoneyDeps): ExecutorRegistry => ({
  ...EXECUTORS,
  invoice_post: invoicePostExecutor(money),
});
const quiet = registryWith({ log: () => {} });

// The person's approval with the second confirm: these cards carry no auditor verdict (the auditor
// is switched off here and not required), and anything but a pass needs that confirm.
const approve = (t: Carrier, id: string, db: Db = app, executors: ExecutorRegistry = quiet) =>
  executeProposal(t.session, id, { confirmed: true }, { db, clock, executors });

// The auditor's own read of a proposal, through the gateway as the app role, on the fixed clock.
const auditorCtx = (t: Carrier): GatewayContext => ({
  session: t.session,
  role: "auditor",
  model: "wonder",
  turnId: null,
  traceId: randomUUID(),
  now: clock(),
  deadlineAt: NOW + 60_000,
  timeZone: t.carrier.timezone,
});
const gatewayNow = (ctx: GatewayContext, call: ToolCall) => callTool(ctx, call, { db: app, clock: () => NOW });
async function packFor(t: Carrier, proposalId: string): Promise<Record<string, unknown>> {
  const out = await gatewayNow(auditorCtx(t), {
    id: "c",
    name: "get_proposal",
    argumentsJson: JSON.stringify({ proposalId }),
  });
  if (out.decision !== "allowed") throw new Error(`get_proposal was not allowed: ${out.reason}`);
  return out.result;
}

// A model that always answers a clean pass. No model is called.
const AUDIT_CALL_ID = "c0ffee00-0000-4000-8000-0000000000b2";
const passModel = (calls: { n: number }): CompleteFn => async () => {
  calls.n += 1;
  return {
    callId: AUDIT_CALL_ID,
    status: "ok",
    text: JSON.stringify({
      verdict: "pass",
      concerns: [],
      checks: ["cause", "sources", "amount", "limit"].map((name) => ({ name, pass: true, note: "holds" })),
    }),
    toolCalls: [],
    usage: { input: 900, cached: 0, output: 300, reasoning: 200 },
    costNanocents: 1,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  } satisfies AiResult;
};

describe("invoices against a seeded database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    app2 = createPgDb({ connectionString: appUrl() });
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
    // Plans fit these rows, not counts an earlier file's cleanup left behind (see test-stats.ts).
    await refreshPlannerStats(admin);
    flags.invoicesEnabled = true;
    flags.customerPaymentsEnabled = true;
    flags.accountingEnabled = false;
    flags.auditorEnabled = false;
    flags.auditorRequired = false;
  }, 120_000);

  afterAll(async () => {
    Object.assign(flags, saved);
    // Only what this file made: the ledger rows (the app role has no DELETE on them), then the two
    // tenants, whose other rows go with them.
    for (const t of tenants) {
      await admin?.withTenant(t.id, (q) =>
        q.execute("DELETE FROM money_actions WHERE tenant_id = current_tenant_id()"),
      );
      await admin?.withTenant(t.id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app2?.close();
    await app?.close();
    await admin?.close();
  });

  describe("the queue and its cards", () => {
    it("splits each seeded queue: the planted load with no rate is the one exception", async () => {
      for (const t of tenants) {
        const split = await app.withTenant(t.id, async (q) => {
          const { loads, customers } = await readInvoiceQueue(q, flags.invoicesStart);
          return splitInvoiceQueue(loads, customers);
        });
        expect(split.exceptions.map((e) => [e.load.id, e.reason]), t.carrier.slug).toEqual([
          [t.plan.planted.noRateLoadId, "missing_rate"],
        ]);
        expect(split.invoiceable.length, t.carrier.slug).toBeGreaterThan(2);
        expect(split.invoiceable.every((i) => i.amountCents > 0 && Number.isSafeInteger(i.amountCents))).toBe(true);
      }
    });

    it("writes nothing while invoicing is off", async () => {
      flags.invoicesEnabled = false;
      try {
        expect(await proposeInvoices(app, BR.session, clock())).toEqual({ ok: false, category: "disabled" });
        expect(await cards(BR)).toEqual([]);
      } finally {
        flags.invoicesEnabled = true;
      }
    });

    it("proposes one card per invoiceable load, a capped number per press, and never twice", async () => {
      const n = (
        await app.withTenant(BR.id, async (q) => {
          const { loads, customers } = await readInvoiceQueue(q, flags.invoicesStart);
          return splitInvoiceQueue(loads, customers);
        })
      ).invoiceable.length;
      flags.invoiceLimits = { ...flags.invoiceLimits, proposalsPerRun: n - 1 };
      try {
        const first = await proposeInvoices(app, BR.session, clock());
        expect(first).toEqual({
          ok: true,
          counts: { created: n - 1, unchanged: 0, inFlight: 0, decided: 0, retired: 0, exceptions: 1, truncated: true },
        });
        const second = await proposeInvoices(app, BR.session, clock());
        expect(second).toMatchObject({ ok: true, counts: { created: 1, unchanged: n - 1, truncated: false } });
        const third = await proposeInvoices(app, BR.session, clock());
        expect(third).toMatchObject({ ok: true, counts: { created: 0, unchanged: n, truncated: false } });
      } finally {
        flags.invoiceLimits = { ...saved.invoiceLimits };
      }
      const all = await cards(BR);
      expect(all).toHaveLength(n);
      expect(new Set(all.map((c) => c.subject_id)).size).toBe(n);
      expect(all.some((c) => c.subject_id === BR.plan.planted.noRateLoadId)).toBe(false);
    });

    it("retires a waiting card whose load changed or stopped qualifying, and asks again after", async () => {
      const [card] = await waitingCards(BR);
      const loadId = card.subject_id;
      const [{ linehaul_cents: rate }] = await adminRows<{ linehaul_cents: string }>(
        BR,
        "SELECT linehaul_cents::text FROM loads WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
        [BR.id, loadId],
      );
      const setRate = (cents: number | null) =>
        adminWrite(BR, "UPDATE loads SET linehaul_cents = $3 WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
          BR.id,
          loadId,
          cents,
        ]);
      try {
        await setRate(Number(rate) + 100);
        const changed = await proposeInvoices(app, BR.session, clock());
        expect(changed).toMatchObject({ ok: true, counts: { created: 1, retired: 0 } });
        expect(await proposalById(BR, card.id)).toMatchObject({ status: "expired", decision_note: "superseded" });

        await setRate(null);
        const gone = await proposeInvoices(app, BR.session, clock());
        expect(gone).toMatchObject({ ok: true, counts: { created: 0, retired: 1, exceptions: 2 } });
      } finally {
        await setRate(Number(rate));
      }
      const back = await proposeInvoices(app, BR.session, clock());
      expect(back).toMatchObject({ ok: true, counts: { created: 1, retired: 0, exceptions: 1 } });
      // All three were made at the same fixed instant, so compare them as a set.
      const forLoad = (await cards(BR)).filter((c) => c.subject_id === loadId);
      expect(forLoad.map((c) => c.status).sort()).toEqual(["expired", "expired", "proposed"]);
      expect(forLoad.find((c) => c.status === "proposed")?.amount_cents).toBe(card.amount_cents);
    });

    it("does not ask again about a card a person rejected while its content is the same", async () => {
      // A load that has only this one card: the test above left two expired cards on its own load,
      // and that load can be the first waiting card.
      const all = await cards(BR);
      const [card] = all.filter(
        (c) => c.status === "proposed" && all.filter((o) => o.subject_id === c.subject_id).length === 1,
      );
      expect(await rejectProposal(BR.session, card.id, "not_needed", { db: app, clock })).toEqual({ ok: true });
      const again = await proposeInvoices(app, BR.session, clock());
      expect(again).toMatchObject({ ok: true, counts: { created: 0, decided: 1 } });
      expect((await cards(BR)).filter((c) => c.subject_id === card.subject_id).map((c) => c.status)).toEqual([
        "rejected",
      ]);
    });
  });

  describe("approving a card", () => {
    it("writes one invoice for two approvals at once, numbered next, due at the customer's terms", async () => {
      const [card] = await waitingCards(BR);
      const lines: string[] = [];
      const executors = registryWith({ log: (l) => lines.push(l) });
      const results = await Promise.all([
        approve(BR, card.id, app, executors),
        approve(BR, card.id, app2, executors),
      ]);
      // Each caller either ran the same approval to its end or found it already decided.
      for (const r of results) {
        if (r.ok) expect(r).toEqual({ ok: true, proposalId: card.id, status: "done", moneyActionId: null });
        else expect(r).toEqual({ ok: false, category: "already_decided", retryable: false });
      }
      expect(results.some((r) => r.ok)).toBe(true);
      const written = await invoicesFor(BR, card.subject_id);
      expect(written).toHaveLength(1);
      const [inv] = written;
      const [customer] = await adminRows<{ terms_days: number }>(
        BR,
        "SELECT terms_days FROM customers WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
        [BR.id, inv.customer_id],
      );
      expect(inv).toMatchObject({
        invoice_number: nextNumber(BR, 1),
        amount_cents: card.amount_cents,
        issued_on: TODAY,
        due_on: addDays(TODAY, customer.terms_days),
        status: "open",
        qbo_id: null,
      });
      const [load] = await adminRows<{ status: string }>(
        BR,
        "SELECT status FROM loads WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
        [BR.id, card.subject_id],
      );
      expect(load.status).toBe("invoiced");
      expect(await proposalById(BR, card.id)).toMatchObject({ status: "done", decision_note: "not_posted" });
      // Posting is off: no ledger row, and the log says what would have been sent.
      expect(await ledgerFor(BR, inv.id)).toEqual([]);
      expect(lines.some((l) => l.startsWith("money: would send invoice") && l.includes("accountingEnabled off"))).toBe(true);
      expect((await approve(BR, card.id)).ok).toBe(false);
    });

    it("gives two cards approved at once the next two numbers", async () => {
      const [a, b] = await waitingCards(BR);
      const [ra, rb] = await Promise.all([approve(BR, a.id, app), approve(BR, b.id, app2)]);
      expect(ra).toMatchObject({ ok: true, status: "done" });
      expect(rb).toMatchObject({ ok: true, status: "done" });
      const numbers = [
        ...(await invoicesFor(BR, a.subject_id)),
        ...(await invoicesFor(BR, b.subject_id)),
      ].map((i) => i.invoice_number);
      expect(numbers.sort()).toEqual([nextNumber(BR, 2), nextNumber(BR, 3)]);
    });

    it("fails a card as stale when its load changed after it was proposed, writing nothing", async () => {
      const [card] = await waitingCards(BR);
      await adminWrite(
        BR,
        "UPDATE loads SET linehaul_cents = linehaul_cents + 100 WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
        [BR.id, card.subject_id],
      );
      try {
        expect(await approve(BR, card.id)).toEqual({ ok: false, category: "stale", retryable: false });
        expect(await invoicesFor(BR, card.subject_id)).toEqual([]);
        expect(await proposalById(BR, card.id)).toMatchObject({ status: "failed", decision_note: "stale" });
      } finally {
        await adminWrite(
          BR,
          "UPDATE loads SET linehaul_cents = linehaul_cents - 100 WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
          [BR.id, card.subject_id],
        );
      }
      // The next press asks again, under a new revision.
      const again = await proposeInvoices(app, BR.session, clock());
      expect(again).toMatchObject({ ok: true, counts: { created: 1 } });
    });
  });

  describe("posting through a test accounting system", () => {
    it("refuses with no ledger row while posting is off, logging what it would send", async () => {
      const [card] = await waitingCards(BR);
      expect(await approve(BR, card.id)).toMatchObject({ ok: true, status: "done" });
      const [inv] = await invoicesFor(BR, card.subject_id);
      const books = testBooks();
      const lines: string[] = [];
      expect(await postInvoice(app, BR.session, inv.id, moneyDeps(books, lines))).toEqual({
        ok: false,
        category: "disabled",
      });
      expect(await ledgerFor(BR, inv.id)).toEqual([]);
      expect(books.seen.invoices).toEqual([]);
      expect(lines.some((l) => l.startsWith("money: would send invoice"))).toBe(true);
    });

    it("posts an invoice once, keeps its accounting id, and never posts it again", async () => {
      flags.accountingEnabled = true;
      try {
        const [card] = await waitingCards(BR);
        expect(await approve(BR, card.id)).toMatchObject({ ok: true, status: "done" });
        const [inv] = await invoicesFor(BR, card.subject_id);
        const books = testBooks();
        const deps = moneyDeps(books, []);
        const posted = await postInvoice(app, BR.session, inv.id, deps);
        expect(posted).toMatchObject({ ok: true, state: "confirmed" });
        expect((await invoiceById(BR, inv.id)).qbo_id).toBe("QI-1");
        expect(await postInvoice(app, BR.session, inv.id, deps)).toEqual({ ok: false, category: "already_posted" });
        expect(books.seen.invoices).toEqual([inv.invoice_number]);
        expect(await ledgerFor(BR, inv.id)).toEqual([{ kind: "invoice", state: "confirmed", attempt: 1, proposal_id: null }]);
      } finally {
        flags.accountingEnabled = false;
      }
    });

    it("leaves a timed-out post unknown, and a second click replays it without sending again", async () => {
      flags.accountingEnabled = true;
      try {
        const [card] = await waitingCards(BR);
        expect(await approve(BR, card.id)).toMatchObject({ ok: true, status: "done" });
        const [inv] = await invoicesFor(BR, card.subject_id);
        const books = testBooks();
        books.answerInvoices("timeout");
        const deps = moneyDeps(books, []);
        expect(await postInvoice(app, BR.session, inv.id, deps)).toMatchObject({ ok: true, state: "unknown" });
        expect(await postInvoice(app, BR.session, inv.id, deps)).toMatchObject({ ok: true, state: "unknown" });
        expect(books.seen.invoices).toHaveLength(1);
        expect((await invoiceById(BR, inv.id)).qbo_id).toBeNull();
        expect(await ledgerFor(BR, inv.id)).toEqual([{ kind: "invoice", state: "unknown", attempt: 1, proposal_id: null }]);
      } finally {
        flags.accountingEnabled = false;
      }
    });

    it("posts through the approval itself when posting is on, linking the ledger row to the card", async () => {
      flags.accountingEnabled = true;
      try {
        const [card] = await waitingCards(BR);
        const books = testBooks();
        const result = await approve(BR, card.id, app, registryWith(moneyDeps(books, [])));
        expect(result).toMatchObject({ ok: true, status: "done" });
        const [inv] = await invoicesFor(BR, card.subject_id);
        expect(inv.qbo_id).toBe("QI-1");
        const p = await proposalById(BR, card.id);
        expect(p.status).toBe("done");
        expect(p.decision_note).toBeNull();
        expect(p.money_action_id).not.toBeNull();
        expect(await ledgerFor(BR, inv.id)).toEqual([
          { kind: "invoice", state: "confirmed", attempt: 1, proposal_id: card.id },
        ]);
      } finally {
        flags.accountingEnabled = false;
      }
    });

    it("never posts a seeded load invoice or an opening balance, and reserves nothing for either", async () => {
      // Seeded invoices are dated before this file's own (all issued today), some after the start.
      const [seeded] = await adminRows<{ id: string }>(
        BR,
        `SELECT id FROM invoices
          WHERE tenant_id = $1 AND source = 'load' AND status <> 'void' AND qbo_id IS NULL
            AND issued_on >= CAST($2 AS date) AND issued_on < CAST($3 AS date)
          ORDER BY invoice_number LIMIT 1`,
        [BR.id, flags.invoicesStart, TODAY],
      );
      const [opening] = await adminRows<{ id: string }>(
        BR,
        `SELECT id FROM invoices
          WHERE tenant_id = $1 AND source = 'opening' AND status <> 'void' AND qbo_id IS NULL
          ORDER BY invoice_number LIMIT 1`,
        [BR.id],
      );
      if (!seeded || !opening) throw new Error("the seed has no unposted load invoice or opening balance");
      flags.accountingEnabled = true;
      try {
        const books = testBooks();
        const deps = moneyDeps(books, []);
        for (const id of [seeded.id, opening.id]) {
          expect(await postInvoice(app, BR.session, id, deps)).toEqual({ ok: false, category: "history" });
          expect(await ledgerFor(BR, id)).toEqual([]);
          expect((await invoiceById(BR, id)).qbo_id).toBeNull();
        }
        expect(books.seen.invoices).toEqual([]);
      } finally {
        flags.accountingEnabled = false;
      }
    });

    it("never posts an invoice the queue made before the invoices start date", async () => {
      const [card] = await waitingCards(BR);
      expect(await approve(BR, card.id)).toMatchObject({ ok: true, status: "done" });
      const [inv] = await invoicesFor(BR, card.subject_id);
      const start = flags.invoicesStart;
      flags.accountingEnabled = true;
      flags.invoicesStart = addDays(TODAY, 1);
      try {
        const books = testBooks();
        expect(await postInvoice(app, BR.session, inv.id, moneyDeps(books, []))).toEqual({
          ok: false,
          category: "history",
        });
        expect(await ledgerFor(BR, inv.id)).toEqual([]);
        expect(books.seen.invoices).toEqual([]);
      } finally {
        flags.invoicesStart = start;
        flags.accountingEnabled = false;
      }
    });
  });

  describe("guards, follow-ups and the auditor on invoice cards", () => {
    // Prairie Wind's own queue, so Blue Ridge's flow above is untouched. Its planted payment on the
    // wrong invoice is left alone until its own test below.
    const loadNumberOf = async (t: Carrier, loadId: string) =>
      (
        await adminRows<{ load_number: string }>(
          t,
          "SELECT load_number FROM loads WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
          [t.id, loadId],
        )
      )[0].load_number;
    const bumpRate = (t: Carrier, loadId: string, cents: number) =>
      adminWrite(t, "UPDATE loads SET linehaul_cents = linehaul_cents + $3 WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
        t.id,
        loadId,
        cents,
      ]);
    const failureOf = async (t: Carrier, subjectId: string) =>
      adminRows<{ state: string; failure_category: string | null }>(
        t,
        "SELECT state, failure_category FROM money_actions WHERE tenant_id = $1 AND subject_id = CAST($2 AS uuid) ORDER BY attempt",
        [t.id, subjectId],
      );
    // A card approved while the accounting system times out: the invoice is written and its post
    // is left unknown, with the card executing.
    async function unknownPost(t: Carrier) {
      const [card] = await waitingCards(t);
      const books = testBooks();
      books.answerInvoices("timeout");
      const result = await approve(t, card.id, app, registryWith(moneyDeps(books, [])));
      expect(result).toMatchObject({ ok: true, proposalId: card.id, status: "executing" });
      const [inv] = await invoicesFor(t, card.subject_id);
      expect(await ledgerFor(t, inv.id)).toEqual([{ kind: "invoice", state: "unknown", attempt: 1, proposal_id: card.id }]);
      return { card, inv };
    }

    it("refuses an approval, a post and a check while its switch is off, and the approval resumes after", async () => {
      expect(await proposeInvoices(app, PW.session, clock())).toMatchObject({ ok: true, counts: { truncated: true } });
      const [card] = await waitingCards(PW);
      const seededInvoice = PW.plan.rows.invoices[0].id;
      const seededPayment = PW.plan.rows.customer_payments[0].id;
      flags.invoicesEnabled = false;
      flags.customerPaymentsEnabled = false;
      try {
        expect(await approve(PW, card.id)).toEqual({ ok: false, category: "disabled", retryable: false });
        expect(await invoicesFor(PW, card.subject_id)).toEqual([]);
        // The approval stands and nothing else moved, so it resumes once the switch is on.
        expect(await proposalById(PW, card.id)).toMatchObject({ status: "approved", decision_note: null });
        expect(await postInvoice(app, PW.session, seededInvoice)).toEqual({ ok: false, category: "disabled" });
        expect(await reconcileInvoice(app, PW.session, seededInvoice)).toEqual({ ok: false, category: "disabled" });
        expect(await reconcileCustomerPayment(app, PW.session, seededPayment)).toEqual({
          ok: false,
          category: "disabled",
        });
      } finally {
        flags.invoicesEnabled = true;
        flags.customerPaymentsEnabled = true;
      }
      expect(await reconcileInvoice(app, PW.session, "not-a-uuid")).toEqual({ ok: false, category: "validation" });
      expect(await approve(PW, card.id)).toEqual({ ok: true, proposalId: card.id, status: "done", moneyActionId: null });
      expect(await invoicesFor(PW, card.subject_id)).toHaveLength(1);
    });

    it("fails a card as stale when its load changed while its post was unknown, never leaving it executing", async () => {
      flags.accountingEnabled = true;
      try {
        const { card } = await unknownPost(PW);
        await bumpRate(PW, card.subject_id, 100);
        try {
          expect(await approve(PW, card.id)).toEqual({ ok: false, category: "stale", retryable: false });
          expect(await proposalById(PW, card.id)).toMatchObject({ status: "failed", decision_note: "stale" });
        } finally {
          await bumpRate(PW, card.subject_id, -100);
        }
      } finally {
        flags.accountingEnabled = false;
      }
    });

    it("settles an unknown invoice post from its record page: same amount confirms, scoped to that invoice", async () => {
      flags.accountingEnabled = true;
      try {
        const { card, inv } = await unknownPost(PW);
        const books = testBooks();
        const deps = moneyDeps(books, []);
        books.answerReadBack({
          found: true,
          system: "qbo_sandbox",
          type: "Invoice",
          id: "QI-77",
          amountCents: Number(inv.amount_cents),
          status: "succeeded",
        });
        // The stale card's unknown row above is another invoice's, so it is never read here.
        expect(await reconcileInvoice(app, PW.session, inv.id, deps)).toEqual({
          ok: true,
          summary: { checked: 1, confirmed: 1, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 },
        });
        expect(books.seen.readBacks).toHaveLength(1);
        expect(books.seen.readBacks[0]).toMatchObject({
          type: "Invoice",
          localRef: inv.invoice_number,
          partyLocalId: inv.customer_id,
        });
        expect(books.seen.invoices).toEqual([]);
        expect((await invoiceById(PW, inv.id)).qbo_id).toBe("QI-77");
        expect(await proposalById(PW, card.id)).toMatchObject({ status: "done", decision_note: null });
        expect(await ledgerFor(PW, inv.id)).toEqual([
          { kind: "invoice", state: "confirmed", attempt: 1, proposal_id: card.id },
        ]);
        // Nothing left to settle for it.
        expect(await reconcileInvoice(app, PW.session, inv.id, deps)).toMatchObject({
          ok: true,
          summary: { checked: 0, confirmed: 0 },
        });
      } finally {
        flags.accountingEnabled = false;
      }
    });

    it("fails an unknown post QuickBooks holds at another amount, and leaves one it cannot find unknown", async () => {
      flags.accountingEnabled = true;
      try {
        const other = await unknownPost(PW);
        const books = testBooks();
        books.answerReadBack({
          found: true,
          system: "qbo_sandbox",
          type: "Invoice",
          id: "QI-78",
          amountCents: Number(other.inv.amount_cents) + 1,
          status: "succeeded",
        });
        expect(await reconcileInvoice(app, PW.session, other.inv.id, moneyDeps(books, []))).toEqual({
          ok: true,
          summary: { checked: 1, confirmed: 0, failed: 1, stillUnknown: 0, skipped: 0, errors: 0 },
        });
        expect(await failureOf(PW, other.inv.id)).toEqual([{ state: "failed", failure_category: "amount_mismatch" }]);
        expect(await proposalById(PW, other.card.id)).toMatchObject({ status: "failed", decision_note: "amount_mismatch" });
        expect((await invoiceById(PW, other.inv.id)).qbo_id).toBeNull();

        const missing = await unknownPost(PW);
        const none = testBooks();
        expect(await reconcileInvoice(app, PW.session, missing.inv.id, moneyDeps(none, []))).toEqual({
          ok: true,
          summary: { checked: 1, confirmed: 0, failed: 0, stillUnknown: 1, skipped: 0, errors: 0 },
        });
        expect(none.seen.readBacks).toHaveLength(1);
        // Still unknown, with the check counted: nothing found is never "never happened".
        expect(await failureOf(PW, missing.inv.id)).toEqual([{ state: "unknown", failure_category: "unknown" }]);
        expect(await proposalById(PW, missing.card.id)).toMatchObject({ status: "executing" });
      } finally {
        flags.accountingEnabled = false;
      }
    });

    it("settles an unknown payment post from its record page, reading it back with its applications", async () => {
      const [inv] = await adminRows<InvoiceRow>(
        PW,
        `SELECT id, invoice_number, amount_cents::text, CAST(issued_on AS text) AS issued_on,
                CAST(due_on AS text) AS due_on, status, qbo_id, customer_id
           FROM invoices WHERE tenant_id = $1 AND qbo_id = 'QI-77'`,
        [PW.id],
      );
      const amount = Number(inv.amount_cents);
      flags.accountingEnabled = true;
      try {
        const books = testBooks();
        books.answerPayments("timeout");
        const deps = { accounting: books.adapter, waitMs: 2_000, pollMs: 10, log: () => {} };
        const recorded = await recordCustomerPayment(
          app,
          PW.session,
          {
            customerId: inv.customer_id,
            receivedOn: TODAY,
            amountCents: amount,
            method: "ach",
            paymentRef: "ACH-CHECK-1",
            applications: [{ invoiceId: inv.id, amountCents: amount }],
          },
          clock(),
          deps,
        );
        expect(recorded).toMatchObject({ ok: true, created: true, posting: "unknown" });
        const paymentId = recorded.ok ? recorded.paymentId : "";
        books.answerReadBack({
          found: true,
          system: "qbo_sandbox",
          type: "Payment",
          id: "QP-77",
          amountCents: amount,
          status: "succeeded",
        });
        expect(await reconcileCustomerPayment(app, PW.session, paymentId, deps)).toEqual({
          ok: true,
          summary: { checked: 1, confirmed: 1, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 },
        });
        expect(books.seen.payments).toEqual(["ACH-CHECK-1"]);
        expect(books.seen.readBacks).toHaveLength(1);
        expect(books.seen.readBacks[0]).toMatchObject({
          type: "Payment",
          localRef: "ACH-CHECK-1",
          partyLocalId: inv.customer_id,
          applications: [{ invoiceOutsideId: "QI-77", amountCents: amount }],
        });
        const [payment] = await adminRows<{ qbo_id: string | null }>(
          PW,
          "SELECT qbo_id FROM customer_payments WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
          [PW.id, paymentId],
        );
        expect(payment.qbo_id).toBe("QP-77");
        expect(await ledgerFor(PW, paymentId)).toEqual([
          { kind: "customer_payment", state: "confirmed", attempt: 1, proposal_id: null },
        ]);
      } finally {
        flags.accountingEnabled = false;
      }
    });

    it("retires a waiting card whose load left the queue on every press, even one the cap cut short", async () => {
      const [card] = await waitingCards(PW);
      const setStatus = (status: string) =>
        adminWrite(PW, "UPDATE loads SET status = $3 WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
          PW.id,
          card.subject_id,
          status,
        ]);
      flags.invoiceLimits = { ...flags.invoiceLimits, proposalsPerRun: 1 };
      try {
        await setStatus("in_transit");
        const press = await proposeInvoices(app, PW.session, clock());
        expect(press).toMatchObject({ ok: true, counts: { created: 1, retired: 1, truncated: true } });
        expect(await proposalById(PW, card.id)).toMatchObject({ status: "expired", decision_note: "superseded" });
      } finally {
        await setStatus("delivered");
        flags.invoiceLimits = { ...saved.invoiceLimits };
      }
      // Back in the queue: the next press asks about it again.
      expect(await proposeInvoices(app, PW.session, clock())).toMatchObject({ ok: true, counts: { retired: 0 } });
      expect((await waitingCards(PW)).filter((c) => c.subject_id === card.subject_id)).toHaveLength(1);
    });

    it("gives the auditor an engine card's load and the engine's own total and lines, every check reported", async () => {
      const [card] = await waitingCards(PW);
      const pack = await packFor(PW, card.id);
      expect(pack.proposal).toMatchObject({
        id: card.id,
        kind: "invoice_post",
        status: "proposed",
        subject: { table: "loads", id: card.subject_id, label: await loadNumberOf(PW, card.subject_id) },
        amountCents: Number(card.amount_cents),
        operatorVerdict: "engine",
      });
      expect(pack.engine).toMatchObject({
        ok: true,
        check: "invoice_post",
        loadFound: true,
        loadStatus: "delivered",
        alreadyInvoiced: false,
        proposedCents: Number(card.amount_cents),
        engine: { ok: true, amountCents: Number(card.amount_cents) },
        matches: { amount: true, lines: true },
      });
      // A changed load is evidence the auditor sees, never a silent pass.
      await bumpRate(PW, card.subject_id, 100);
      try {
        expect((await packFor(PW, card.id)).engine).toMatchObject({
          engine: { amountCents: Number(card.amount_cents) + 100 },
          matches: { amount: false },
        });
      } finally {
        await bumpRate(PW, card.subject_id, -100);
      }
    });

    it("audits an engine card end to end, and the gate holds every card to the auditor's verdict", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const [audited, waiting] = await waitingCards(PW);
      flags.auditorEnabled = true;
      flags.auditorRequired = true;
      try {
        const calls = { n: 0 };
        const out = await runAudit(PW.session, audited.id, {
          db: app,
          clock,
          callTool: gatewayNow,
          complete: passModel(calls),
          env: { META_MODEL_WONDER: "muse-wonder-1.0" },
        });
        expect(out).toEqual({ state: "done", verdict: "pass", concerns: [], checkedAt: new Date(NOW).toISOString() });
        expect(calls.n).toBe(1);
        const decisions = await adminRows<{ turn_id: string | null; tool: string; decision: string }>(
          PW,
          `SELECT d.turn_id, d.tool, d.decision FROM gateway_decisions d
             JOIN proposals p ON p.tenant_id = d.tenant_id AND CAST(p.auditor_trace_id AS text) = d.trace_id
            WHERE d.tenant_id = $1 AND p.id = CAST($2 AS uuid)`,
          [PW.id, audited.id],
        );
        expect(decisions).toEqual([{ turn_id: null, tool: "get_proposal", decision: "allowed" }]);

        // No verdict yet: nobody can approve it.
        expect(await approve(PW, waiting.id)).toEqual({ ok: false, category: "auditor_required", retryable: false });
        // A verdict the auditor could not reach needs the second confirm.
        await adminWrite(
          PW,
          `UPDATE proposals SET auditor_verdict = 'unknown', auditor_checked_at = CAST($3 AS timestamptz)
            WHERE tenant_id = $1 AND id = CAST($2 AS uuid)`,
          [PW.id, waiting.id, new Date(NOW).toISOString()],
        );
        const once = (id: string) => executeProposal(PW.session, id, { confirmed: false }, { db: app, clock, executors: quiet });
        expect(await once(waiting.id)).toEqual({ ok: false, category: "needs_confirm", retryable: false });
        expect(await approve(PW, waiting.id)).toEqual({ ok: true, proposalId: waiting.id, status: "done", moneyActionId: null });
        // A pass goes through on one click.
        expect(await once(audited.id)).toEqual({ ok: true, proposalId: audited.id, status: "done", moneyActionId: null });
      } finally {
        flags.auditorEnabled = false;
        flags.auditorRequired = false;
        vi.restoreAllMocks();
      }
    });
  });

  describe("customer payments", () => {
    // An invoice this file wrote and nobody has paid, with its customer.
    async function unpaid(t: Carrier, posted: boolean) {
      const rows = await adminRows<InvoiceRow>(
        t,
        `SELECT id, invoice_number, amount_cents::text, CAST(issued_on AS text) AS issued_on,
                CAST(due_on AS text) AS due_on, status, qbo_id, customer_id
           FROM invoices
          WHERE tenant_id = $1 AND source = 'load' AND issued_on = CAST($2 AS date) AND status = 'open'
            AND (qbo_id IS NOT NULL) = $3
          ORDER BY invoice_number`,
        [t.id, TODAY, posted],
      );
      if (!rows[0]) throw new Error("no unpaid invoice from this file");
      return rows[0];
    }

    const form = (inv: InvoiceRow, ref: string, amountCents: number, applied = amountCents) => ({
      customerId: inv.customer_id,
      receivedOn: TODAY,
      amountCents,
      method: "ach",
      paymentRef: ref,
      applications: [{ invoiceId: inv.id, amountCents: applied }],
    });

    it("writes nothing while payments are off", async () => {
      flags.customerPaymentsEnabled = false;
      try {
        const inv = await unpaid(BR, false);
        expect(await recordCustomerPayment(app, BR.session, form(inv, "ACH-OFF-1", 100), clock())).toEqual({
          ok: false,
          category: "disabled",
        });
      } finally {
        flags.customerPaymentsEnabled = true;
      }
    });

    it("records a payment, applies it, and moves the invoice from open to partly paid to paid", async () => {
      const inv = await unpaid(BR, false);
      const amount = Number(inv.amount_cents);
      const half = Math.floor(amount / 2);
      const first = await recordCustomerPayment(app, BR.session, form(inv, "ACH-INV-1", half), clock());
      // The invoice is not in the accounting system yet, so the payment is not posted.
      expect(first).toMatchObject({ ok: true, created: true, posting: "not_configured" });
      expect((await invoiceById(BR, inv.id)).status).toBe("partially_paid");

      // The same form again is the same payment; the same reference for another amount is refused.
      const again = await recordCustomerPayment(app, BR.session, form(inv, "ACH-INV-1", half), clock());
      expect(again).toEqual({ ok: true, created: false, paymentId: first.ok ? first.paymentId : "", posting: null });
      expect(await recordCustomerPayment(app, BR.session, form(inv, "ACH-INV-1", half + 1), clock())).toEqual({
        ok: false,
        category: "duplicate_ref",
      });
      // The same reference, customer and amount applied another way is not a repeat: refused,
      // and the stored applications stay as they were.
      for (const other of [form(inv, "ACH-INV-1", half, half - 1), { ...form(inv, "ACH-INV-1", half), applications: [] }]) {
        expect(await recordCustomerPayment(app, BR.session, other, clock())).toEqual({
          ok: false,
          category: "duplicate_ref",
        });
      }
      const kept = await adminRows<{ invoice_id: string; amount_cents: string }>(
        BR,
        `SELECT a.invoice_id, a.amount_cents::text FROM payment_applications a
           JOIN customer_payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
          WHERE a.tenant_id = $1 AND p.payment_ref = 'ACH-INV-1'`,
        [BR.id],
      );
      expect(kept).toEqual([{ invoice_id: inv.id, amount_cents: String(half) }]);

      // More applied than the payment, or than the invoice still owes, is refused.
      expect(await recordCustomerPayment(app, BR.session, form(inv, "ACH-INV-2", 100, 101), clock())).toEqual({
        ok: false,
        category: "over_applied",
      });
      expect(
        await recordCustomerPayment(app, BR.session, form(inv, "ACH-INV-2", amount, amount - half + 1), clock()),
      ).toEqual({ ok: false, category: "over_applied" });

      const rest = await recordCustomerPayment(app, BR.session, form(inv, "ACH-INV-2", amount - half), clock());
      expect(rest).toMatchObject({ ok: true, created: true });
      const paid = await invoiceById(BR, inv.id);
      expect(paid.status).toBe("paid");
      const [p] = await adminRows<{ n: string }>(
        BR,
        "SELECT count(*)::text AS n FROM customer_payments WHERE tenant_id = $1 AND payment_ref IN ('ACH-INV-1', 'ACH-INV-2')",
        [BR.id],
      );
      expect(p.n).toBe("2");
    });

    it("posts a payment once every invoice it applies to is posted, and only once", async () => {
      const inv = await unpaid(BR, true);
      // Posting off: recorded here, nothing reserved.
      const recorded = await recordCustomerPayment(app, BR.session, form(inv, "ACH-POST-1", 1_000), clock());
      expect(recorded).toMatchObject({ ok: true, created: true, posting: "not_posted" });
      const paymentId = recorded.ok ? recorded.paymentId : "";
      expect(await ledgerFor(BR, paymentId)).toEqual([]);

      flags.accountingEnabled = true;
      try {
        const books = testBooks();
        const deps = { accounting: books.adapter, waitMs: 2_000, pollMs: 10, log: () => {} };
        expect(await postCustomerPayment(app, BR.session, paymentId, deps)).toEqual({ ok: true, posting: "confirmed" });
        expect(await postCustomerPayment(app, BR.session, paymentId, deps)).toEqual({
          ok: false,
          category: "already_posted",
        });
        expect(books.seen.payments).toEqual(["ACH-POST-1"]);
        expect(await ledgerFor(BR, paymentId)).toEqual([
          { kind: "customer_payment", state: "confirmed", attempt: 1, proposal_id: null },
        ]);
      } finally {
        flags.accountingEnabled = false;
      }
    });

    it("rolls back a payment post whose applications changed after it was read, sending nothing", async () => {
      const [inv] = await adminRows<InvoiceRow>(
        BR,
        `SELECT id, invoice_number, amount_cents::text, CAST(issued_on AS text) AS issued_on,
                CAST(due_on AS text) AS due_on, status, qbo_id, customer_id
           FROM invoices
          WHERE tenant_id = $1 AND source = 'load' AND issued_on = CAST($2 AS date)
            AND status IN ('open', 'partially_paid') AND qbo_id IS NOT NULL
          ORDER BY invoice_number LIMIT 1`,
        [BR.id, TODAY],
      );
      if (!inv) throw new Error("no posted invoice from this file with a balance");
      const recorded = await recordCustomerPayment(app, BR.session, form(inv, "ACH-POST-2", 500), clock());
      expect(recorded).toMatchObject({ ok: true, created: true, posting: "not_posted" });
      const paymentId = recorded.ok ? recorded.paymentId : "";
      const shift = (by: number) =>
        adminWrite(
          BR,
          "UPDATE payment_applications SET amount_cents = amount_cents + $3 WHERE tenant_id = $1 AND payment_id = CAST($2 AS uuid)",
          [BR.id, paymentId, by],
        );
      // Another session changes the payment's applications after the post read them and before
      // it reserves: the reserve transaction reads them again and rolls itself back.
      let moved = false;
      const store: LedgerStore = {
        ...dbLedgerStore,
        approvalFrom: async (q, session) => {
          if (!moved) {
            moved = true;
            await shift(-1);
          }
          return dbLedgerStore.approvalFrom(q, session);
        },
      };
      flags.accountingEnabled = true;
      try {
        const books = testBooks();
        const deps = { accounting: books.adapter, waitMs: 2_000, pollMs: 10, log: () => {} };
        expect(await postCustomerPayment(app, BR.session, paymentId, { ...deps, store })).toEqual({
          ok: true,
          posting: "applications_changed",
        });
        expect(moved).toBe(true);
        expect(books.seen.payments).toEqual([]);
        expect(await ledgerFor(BR, paymentId)).toEqual([]);
        // Nothing was left reserved, so the next press reads the payment again and posts it.
        await shift(1);
        expect(await postCustomerPayment(app, BR.session, paymentId, deps)).toEqual({ ok: true, posting: "confirmed" });
        expect(books.seen.payments).toEqual(["ACH-POST-2"]);
        expect(await ledgerFor(BR, paymentId)).toEqual([
          { kind: "customer_payment", state: "confirmed", attempt: 1, proposal_id: null },
        ]);
      } finally {
        flags.accountingEnabled = false;
      }
    });
  });

  describe("payments that did not come from the form", () => {
    it("never posts a seeded payment, and reserves nothing for it", async () => {
      const [seeded] = await adminRows<{ id: string }>(
        BR,
        `SELECT id FROM customer_payments
          WHERE tenant_id = $1 AND source <> 'ui' AND qbo_id IS NULL ORDER BY payment_ref LIMIT 1`,
        [BR.id],
      );
      expect(seeded).toBeDefined();
      flags.accountingEnabled = true;
      try {
        const books = testBooks();
        const deps = { accounting: books.adapter, waitMs: 2_000, pollMs: 10, log: () => {} };
        expect(await postCustomerPayment(app, BR.session, seeded!.id, deps)).toEqual({
          ok: false,
          category: "validation",
        });
        expect(books.seen.payments).toEqual([]);
        expect(await ledgerFor(BR, seeded!.id)).toEqual([]);
      } finally {
        flags.accountingEnabled = false;
      }
    });
  });

  describe("the planted payment on the wrong invoice", () => {
    // A waiting payment_reapply proposal as the agent leaves one: its conversation, turn and
    // gateway decision, and the args the limit sized. Written by the admin login so created_at
    // can be set.
    async function proposeMove(t: Carrier, args: Record<string, unknown>, amountCents: number): Promise<string> {
      const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const created = new Date(NOW - HOUR).toISOString();
      await admin.withTenant(t.id, async (q) => {
        await q.execute(
          "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
          [conversation, t.session.sub],
        );
        await q.execute(
          `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Fix the payment?', 'done', $3,
             CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
          [turn, conversation, trace, created],
        );
        await q.execute(
          `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark',
             'propose_payment_reapply', 'propose', 'allowed', 'ok', 1)`,
          [decision, turn, trace],
        );
        await q.execute(
          `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
             amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
             created_at, updated_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'payment_reapply',
             'payment_applications', CAST($4 AS uuid), $5, 'none', 'Move a payment', CAST($6 AS jsonb), 'eligible',
             CAST($7 AS uuid), $8, $9, CAST($10 AS timestamptz), CAST($10 AS timestamptz))`,
          [
            id,
            conversation,
            turn,
            args.applicationId as string,
            amountCents,
            JSON.stringify(args),
            decision,
            `payment_reapply:${args.applicationId as string}:${id.replace(/-/g, "").padEnd(64, "0")}`,
            trace,
            created,
          ],
        );
      });
      return id;
    }

    const findingsNow = (t: Carrier) =>
      app.withTenant(t.id, async (q) => findPaymentOnWrongInvoice(await readReceivablesInput(q, TODAY)));

    it("refuses a move onto an invoice another payment already partly paid, moving nothing", async () => {
      const t = BR;
      const w = t.plan.planted.wrongInvoice;
      const ids = {
        paymentId: w.paymentId,
        applicationId: w.applicationId,
        fromInvoiceId: w.appliedToInvoiceId,
        toInvoiceId: w.meantForInvoiceId,
      };
      const [{ amount_cents: appliedText }] = await adminRows<{ amount_cents: string }>(
        t,
        "SELECT amount_cents::text FROM payment_applications WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
        [t.id, ids.applicationId],
      );
      const amountCents = Number(appliedText);
      const before = await invoiceById(t, ids.toInvoiceId);
      // Another payment pays one cent of the target: it still owes something, so the engine still
      // names it, but less than the application being moved.
      const otherPayment = randomUUID();
      const otherApplication = randomUUID();
      await adminWrite(
        t,
        `INSERT INTO customer_payments (id, tenant_id, customer_id, received_on, amount_cents, method, payment_ref, source)
         VALUES (CAST($2 AS uuid), $1, CAST($3 AS uuid), CAST($4 AS date), 1, 'ach', 'partly-paid-target', 'seed')`,
        [t.id, otherPayment, before.customer_id, addDays(TODAY, -1)],
      );
      try {
        await adminWrite(
          t,
          `INSERT INTO payment_applications (id, tenant_id, payment_id, invoice_id, amount_cents)
           VALUES (CAST($2 AS uuid), $1, CAST($3 AS uuid), CAST($4 AS uuid), 1)`,
          [t.id, otherApplication, otherPayment, ids.toInvoiceId],
        );
        expect(Number(before.amount_cents) - 1).toBeLessThan(amountCents);
        expect(matchWrongInvoiceFinding(await findingsNow(t), ids)).not.toBeNull();
        const id = await proposeMove(t, { ...ids, amountCents }, amountCents);
        expect(await approve(t, id)).toEqual({ ok: false, category: "over_applied", retryable: false });
        expect(await proposalById(t, id)).toMatchObject({ status: "failed", decision_note: "over_applied" });
        const onSource = await adminRows<{ id: string }>(
          t,
          "SELECT id FROM payment_applications WHERE tenant_id = $1 AND id = CAST($2 AS uuid) AND invoice_id = CAST($3 AS uuid)",
          [t.id, ids.applicationId, ids.fromInvoiceId],
        );
        expect(onSource).toHaveLength(1);
        const onTarget = await adminRows<{ id: string }>(
          t,
          `SELECT id FROM payment_applications
            WHERE tenant_id = $1 AND payment_id = CAST($2 AS uuid) AND invoice_id = CAST($3 AS uuid)`,
          [t.id, ids.paymentId, ids.toInvoiceId],
        );
        expect(onTarget).toEqual([]);
        expect(await invoiceById(t, ids.toInvoiceId)).toEqual(before);
      } finally {
        await adminWrite(t, "DELETE FROM payment_applications WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
          t.id,
          otherApplication,
        ]);
        await adminWrite(t, "DELETE FROM customer_payments WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
          t.id,
          otherPayment,
        ]);
      }
      // The plant is whole again for the move below.
      expect(matchWrongInvoiceFinding(await findingsNow(t), ids)).not.toBeNull();
    });

    for (const which of ["blue-ridge", "prairie-wind"] as const) {
      it(`${which}: the engine's finding becomes a proposal, moves on approval, and is gone after`, async () => {
        const t = tenants.find((x) => x.carrier.slug === which) as Carrier;
        const w = t.plan.planted.wrongInvoice;
        const ids = {
          paymentId: w.paymentId,
          applicationId: w.applicationId,
          fromInvoiceId: w.appliedToInvoiceId,
          toInvoiceId: w.meantForInvoiceId,
        };
        const ctx: GatewayContext = {
          session: t.session,
          role: "operator",
          model: "spark",
          turnId: null,
          traceId: "trace-invoices-db",
          now: clock(),
          deadlineAt: NOW + 60_000,
          timeZone: t.carrier.timezone,
        };
        expect(matchWrongInvoiceFinding(await findingsNow(t), ids)).not.toBeNull();
        const limit = await app.withTenant(t.id, (q) => paymentReapplyLimit(q, ctx, ids));
        expect(limit).toMatchObject({ ok: true, reasons: ["payment_on_wrong_invoice"] });
        if (!limit.ok) throw new Error("limit refused the plant");
        const args = { ...ids, amountCents: limit.requestedCents };

        // A payment already in the accounting system is refused, never moved here alone (D1).
        await adminWrite(t, "UPDATE customer_payments SET qbo_id = 'QP-OUTSIDE' WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
          t.id,
          ids.paymentId,
        ]);
        try {
          expect(await app.withTenant(t.id, (q) => paymentReapplyLimit(q, ctx, ids))).toMatchObject({
            ok: false,
            reason: "engine_refused",
          });
          const blocked = await proposeMove(t, args, limit.requestedCents);
          expect((await packFor(t, blocked)).engine).toMatchObject({ postedOutside: true });
          expect(await approve(t, blocked)).toEqual({ ok: false, category: "posted_outside", retryable: false });
          expect(await proposalById(t, blocked)).toMatchObject({ status: "failed", decision_note: "posted_outside" });
        } finally {
          await adminWrite(t, "UPDATE customer_payments SET qbo_id = NULL WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
            t.id,
            ids.paymentId,
          ]);
        }
        // So is one whose post is reserved and not settled: no outside id yet, but the books may
        // already hold it.
        const postId = randomUUID();
        await adminWrite(
          t,
          `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, attempt,
             idempotency_key, request_id, amount_cents, counterparty_table, counterparty_id, proposed_by,
             approver_membership_id)
           SELECT CAST($2 AS uuid), p.tenant_id, 'customer_payment', 'accounting', 'customer_payments', p.id, 1,
                  'customer_payment:' || CAST(p.id AS text) || ':1', $4, p.amount_cents, 'customers',
                  p.customer_id, 'person', m.id
             FROM customer_payments p
             JOIN memberships m ON m.tenant_id = p.tenant_id
            WHERE p.tenant_id = $1 AND p.id = CAST($3 AS uuid)
            ORDER BY m.id LIMIT 1`,
          [t.id, postId, ids.paymentId, postId.replace(/-/g, "")],
        );
        try {
          expect(await ledgerFor(t, ids.paymentId)).toMatchObject([{ kind: "customer_payment", state: "reserved" }]);
          expect(await app.withTenant(t.id, (q) => paymentReapplyLimit(q, ctx, ids))).toMatchObject({
            ok: false,
            reason: "engine_refused",
          });
          const pending = await proposeMove(t, args, limit.requestedCents);
          // The auditor's pack reads it the executor's way: no outside id, but a post reserved.
          expect((await packFor(t, pending)).engine).toMatchObject({ postedOutside: true });
          expect(await approve(t, pending)).toEqual({ ok: false, category: "posted_outside", retryable: false });
          expect(await proposalById(t, pending)).toMatchObject({ status: "failed", decision_note: "posted_outside" });
        } finally {
          await adminWrite(t, "DELETE FROM money_actions WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [t.id, postId]);
        }
        expect(matchWrongInvoiceFinding(await findingsNow(t), ids)).not.toBeNull();

        const id = await proposeMove(t, args, limit.requestedCents);
        // The auditor's pack: the payment's reference, and every check the executor makes.
        const [{ payment_ref: ref }] = await adminRows<{ payment_ref: string }>(
          t,
          "SELECT payment_ref FROM customer_payments WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
          [t.id, ids.paymentId],
        );
        const pack = await packFor(t, id);
        expect(pack.proposal).toMatchObject({ subject: { table: "payment_applications", label: ref } });
        expect(pack.engine).toMatchObject({
          ok: true,
          check: "payment_on_wrong_invoice",
          found: true,
          proposedCents: limit.requestedCents,
          applicationOnFromInvoice: true,
          postedOutside: false,
          findingMatches: true,
        });
        // With customer payments switched off nothing moves and the approval stands until it is on.
        flags.customerPaymentsEnabled = false;
        try {
          expect(await approve(t, id)).toEqual({ ok: false, category: "disabled", retryable: false });
          expect(await proposalById(t, id)).toMatchObject({ status: "approved", decision_note: null });
        } finally {
          flags.customerPaymentsEnabled = true;
        }
        expect(await approve(t, id)).toEqual({ ok: true, proposalId: id, status: "done", moneyActionId: null });
        expect(await approve(t, id)).toEqual({ ok: false, category: "already_decided", retryable: false });
        const onTarget = await adminRows<{ amount_cents: string }>(
          t,
          `SELECT amount_cents::text FROM payment_applications
            WHERE tenant_id = $1 AND payment_id = CAST($2 AS uuid) AND invoice_id = CAST($3 AS uuid)`,
          [t.id, ids.paymentId, ids.toInvoiceId],
        );
        expect(onTarget.map((a) => Number(a.amount_cents)).reduce((s, c) => s + c, 0)).toBeGreaterThanOrEqual(
          limit.requestedCents,
        );
        const onSource = await adminRows<{ id: string }>(
          t,
          "SELECT id FROM payment_applications WHERE tenant_id = $1 AND id = CAST($2 AS uuid) AND invoice_id = CAST($3 AS uuid)",
          [t.id, ids.applicationId, ids.fromInvoiceId],
        );
        expect(onSource).toEqual([]);
        const target = await invoiceById(t, ids.toInvoiceId);
        expect(["paid", "partially_paid"]).toContain(target.status);
        const after = await findingsNow(t);
        expect(matchWrongInvoiceFinding(after, ids)).toBeNull();
        expect(after.filter((f) => f.sources.some((s) => s.id === ids.paymentId))).toEqual([]);
        // No money moved and nothing outside was called: no ledger row names the payment.
        expect(await ledgerFor(t, ids.paymentId)).toEqual([]);
      });
    }
  });

  describe("tenant walls", () => {
    it("never lets one carrier see, approve or post another carrier's invoices and payments", async () => {
      const [brCard] = await cards(BR);
      const [brInvoice] = await adminRows<InvoiceRow>(
        BR,
        `SELECT id, invoice_number, amount_cents::text, CAST(issued_on AS text) AS issued_on,
                CAST(due_on AS text) AS due_on, status, qbo_id, customer_id
           FROM invoices WHERE tenant_id = $1 AND status = 'open' ORDER BY invoice_number LIMIT 1`,
        [BR.id],
      );
      const [brPayment] = await adminRows<{ id: string }>(
        BR,
        "SELECT id FROM customer_payments WHERE tenant_id = $1 ORDER BY payment_ref LIMIT 1",
        [BR.id],
      );
      expect(await approve(PW, brCard.id)).toEqual({ ok: false, category: "not_found", retryable: false });
      expect(await postInvoice(app, PW.session, brInvoice.id)).toEqual({ ok: false, category: "not_found" });
      expect(await postCustomerPayment(app, PW.session, brPayment.id)).toEqual({ ok: false, category: "not_found" });
      expect(
        await recordCustomerPayment(
          app,
          PW.session,
          {
            customerId: brInvoice.customer_id,
            receivedOn: TODAY,
            amountCents: 100,
            method: "check",
            paymentRef: "CHK-WALL-1",
            applications: [{ invoiceId: brInvoice.id, amountCents: 100 }],
          },
          clock(),
        ),
      ).toEqual({ ok: false, category: "not_found" });
      const seen = await app.withTenant(PW.id, (q) =>
        q.query<{ n: string }>("SELECT count(*)::text AS n FROM invoices WHERE id = CAST($1 AS uuid)", [brInvoice.id]),
      );
      expect(seen[0].n).toBe("0");
    });
  });
});
