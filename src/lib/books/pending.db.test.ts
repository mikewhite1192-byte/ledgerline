import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { AccountingAdapter, ReadBack, SendOutcome } from "../adapters/types";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { clearLedger, dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { serviceSession } from "../sweep/service-session";
import { postBooksHistory, postPendingBooks, type BooksDeps, type BooksOptions } from "./pending";

// The books step against the real database, as the app's role, with an accounting double: it posts
// what is missing oldest first, by the carrier's own date, once; it never reaches back before its
// start date and never posts seeded history (only the backfill does); a definite failure goes
// again as the next attempt after its wait, at most maxAttempts times; an unknown post stops the
// step and the reconcile pass reads it back; maxItems, the deadline and the switch stop it; and with
// the books switch off, accounting off or no connection, nothing is read or written. One carrier,
// removed after.

const savedBooks = structuredClone(flags.books);
const savedAccounting = flags.accountingEnabled;
const START = "2026-11-01";
// The step's clock for its budget only: a fixed instant far from any deadline.
const NOW_MS = Date.parse("2026-11-03T15:00:00.000Z");

let admin: Db;
let app: Db;
let f: Fixture;
let service: Session;

type Script = { payment: SendOutcome["kind"]; category?: string };

// The accounting double. Every create confirms unless the script says otherwise; readBack finds
// what the script says. Each call is counted by kind.
function books(script: Partial<Script> = {}, onCall?: () => void) {
  const calls = { ready: 0, vendors: 0, customers: 0, expenses: 0, payments: 0, readBacks: 0 };
  let found: ReadBack = { found: false };
  const unused = async (): Promise<never> => {
    throw new Error("not used by this test");
  };
  const confirmed = (type: string, amountCents: number): SendOutcome => ({
    kind: "confirmed",
    system: "qbo_sandbox",
    type,
    id: `QB-${randomUUID().slice(0, 8)}`,
    amountCents,
  });
  const adapter: AccountingAdapter = {
    system: "qbo_sandbox",
    ready: async () => {
      calls.ready += 1;
      return { ok: true };
    },
    ensureCustomer: async (_q, c) => {
      calls.customers += 1;
      return { outsideId: `C-${c.code}` };
    },
    ensureVendor: async (_q, d) => {
      calls.vendors += 1;
      return { outsideId: `V-${d.code}` };
    },
    createInvoice: unused,
    createBill: unused,
    payBill: unused,
    createExpense: async (_q, e) => {
      calls.expenses += 1;
      onCall?.();
      return confirmed("Purchase", e.amountCents + e.feeCents);
    },
    createCheck: unused,
    recordCustomerPayment: async (_q, p) => {
      calls.payments += 1;
      onCall?.();
      const kind = script.payment ?? "confirmed";
      if (kind === "failed") return { kind: "failed", category: (script.category ?? "validation") as "validation" };
      if (kind === "unknown") return { kind: "unknown", category: "timeout" };
      return confirmed("Payment", p.amountCents);
    },
    readBack: async () => {
      calls.readBacks += 1;
      return found;
    },
  };
  return {
    adapter,
    calls,
    find: (r: ReadBack) => {
      found = r;
    },
  };
}

const logs: string[] = [];
const opts = (over: Partial<BooksOptions> = {}): BooksOptions => ({
  deadlineMs: NOW_MS + 60_000,
  maxItems: 10,
  since: START,
  ...over,
});
const deps = (accounting: AccountingAdapter, over: Partial<BooksDeps> = {}): BooksDeps => ({
  db: app,
  money: { accounting, sleep: async () => {}, pollMs: 1 },
  nowMs: () => NOW_MS,
  log: (l) => logs.push(l),
  ...over,
});

type LedgerRow = { kind: string; subject_id: string; attempt: number; state: string; failure_category: string | null };
const ledger = () =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<LedgerRow>(
      `SELECT kind, CAST(subject_id AS text) AS subject_id, attempt, state, failure_category
         FROM money_actions WHERE tenant_id = current_tenant_id()
        ORDER BY created_at, attempt`,
    ),
  );

// A paid advance as the seed writes one: no proposal, paid at the given instant.
async function paidAdvance(paidAt: string): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on,
         amount_cents, status, source, paid_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS timestamptz),
         CAST(CAST($4 AS timestamptz) AT TIME ZONE 'America/Chicago' AS date), 20000, 'paid', 'seed',
         CAST($4 AS timestamptz))`,
      [id, f.driverId, `ADV-${id.slice(0, 8)}`, paidAt],
    ),
  );
  return id;
}

async function payment(source: "ui" | "seed", receivedOn: string): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO customer_payments (id, tenant_id, customer_id, received_on, amount_cents, method, payment_ref, source)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS date), 7500, 'ach', $4, $5)`,
      [id, f.customerId, receivedOn, `ACH-${id.slice(0, 8)}`, source],
    ),
  );
  return id;
}

async function clearRecords(): Promise<void> {
  await clearLedger(admin, f);
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute("DELETE FROM advances WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM customer_payments WHERE tenant_id = current_tenant_id() AND id <> CAST($1 AS uuid)", [
      f.paymentId,
    ]);
    await q.execute("UPDATE customer_payments SET qbo_id = NULL WHERE tenant_id = current_tenant_id()");
  });
}

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl(), max: 2 });
  f = await makeTenant(admin, `books-${randomUUID().slice(0, 8)}`);
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@books-test.invalid', 'staff')`,
    ),
  );
  const s = await serviceSession(app, f.tenantId);
  if (!s) throw new Error("no service login");
  service = s;
});

beforeEach(async () => {
  Object.assign(flags.books, { enabled: true, startDate: START, maxAttempts: 3 });
  flags.accountingEnabled = true;
  logs.length = 0;
  await clearRecords();
});

afterEach(() => {
  Object.assign(flags.books, structuredClone(savedBooks));
  flags.accountingEnabled = savedAccounting;
});

afterAll(async () => {
  await dropTenant(admin, f);
  await app?.close();
  await admin?.close();
});

describe("the books step", () => {
  it("reads and writes nothing with books off, accounting off, or no connection", async () => {
    await paidAdvance("2026-11-02T15:00:00Z");
    const b = books();
    flags.books.enabled = false;
    expect(await postPendingBooks(service, opts(), deps(b.adapter))).toEqual({ ok: false, category: "disabled" });
    flags.books.enabled = true;
    flags.accountingEnabled = false;
    expect(await postPendingBooks(service, opts(), deps(b.adapter))).toEqual({ ok: false, category: "accounting_off" });
    flags.accountingEnabled = true;
    const offline = books();
    offline.adapter.ready = async () => ({ ok: false, category: "not_connected" });
    expect(await postPendingBooks(service, opts(), deps(offline.adapter))).toEqual({
      ok: false,
      category: "not_connected",
    });
    expect(b.calls.ready).toBe(0);
    expect(offline.calls.vendors + offline.calls.expenses + offline.calls.payments).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("posts a paid advance and a recorded payment once, oldest first, by the carrier's own date", async () => {
    // 22:30 on Nov 2 in Chicago (Nov 3 in UTC), and 23:00 on Oct 31 in Chicago (Nov 1 in UTC).
    const late = await paidAdvance("2026-11-03T04:30:00Z");
    const before = await paidAdvance("2026-11-01T04:00:00Z");
    const b = books();
    // The step never reaches back before its start date, whatever it is asked.
    const out = await postPendingBooks(service, opts({ since: "2026-10-01" }), deps(b.adapter));
    expect(out).toMatchObject({ ok: true, tried: 2, confirmed: 2, failed: 0, pending: 0, stop: "empty" });
    const rows = await ledger();
    expect(rows.map((r) => [r.kind, r.subject_id, r.attempt, r.state])).toEqual([
      ["advance_expense", late, 1, "confirmed"],
      ["customer_payment", f.paymentId, 1, "confirmed"],
    ]);
    expect(rows.some((r) => r.subject_id === before)).toBe(false);
    expect(logs.at(-1)).toMatch(/^books: step tenant=\S+ tried=2 confirmed=2 failed=0 pending=0 refused=0 stop=empty/);
    // The same records again: nothing left to post, nothing written twice.
    const again = await postPendingBooks(service, opts(), deps(b.adapter));
    expect(again).toMatchObject({ ok: true, tried: 0, stop: "empty" });
    expect(await ledger()).toHaveLength(2);
    expect(b.calls.expenses + b.calls.payments).toBe(2);
  });

  it("never posts a seeded payment from the step, and the backfill does", async () => {
    const seeded = await payment("seed", "2026-11-02");
    const b = books();
    await postPendingBooks(service, opts(), deps(b.adapter));
    expect((await ledger()).some((r) => r.subject_id === seeded)).toBe(false);
    const history = await postBooksHistory(service, opts({ since: "2026-10-01" }), deps(b.adapter));
    expect(history).toMatchObject({ ok: true, tried: 1, confirmed: 1 });
    expect((await ledger()).filter((r) => r.subject_id === seeded).map((r) => r.state)).toEqual(["confirmed"]);
  });

  it("tries a definite failure again as the next attempt after its wait, at most maxAttempts times", async () => {
    const b = books({ payment: "failed", category: "validation" });
    expect(await postPendingBooks(service, opts(), deps(b.adapter))).toMatchObject({ tried: 1, failed: 1 });
    // Inside the wait: nothing new.
    expect(await postPendingBooks(service, opts(), deps(b.adapter))).toMatchObject({ tried: 0 });
    const now = { retryAfterMinutes: 0 };
    await postPendingBooks(service, opts(), deps(b.adapter, now));
    await postPendingBooks(service, opts(), deps(b.adapter, now));
    expect(await postPendingBooks(service, opts(), deps(b.adapter, now))).toMatchObject({ tried: 0, stop: "empty" });
    expect((await ledger()).map((r) => [r.attempt, r.state, r.failure_category])).toEqual([
      [1, "failed", "validation"],
      [2, "failed", "validation"],
      [3, "failed", "validation"],
    ]);
    expect(b.calls.payments).toBe(3);
  });

  it("stops at an unknown post, and the reconcile pass reads it back", async () => {
    const b = books({ payment: "unknown" });
    b.find({ found: true, system: "qbo_sandbox", type: "Payment", id: "QB-77", amountCents: 50_000, status: "succeeded" });
    const out = await postPendingBooks(service, opts(), deps(b.adapter));
    expect(out).toMatchObject({ ok: true, tried: 1, pending: 1, stop: "unknown" });
    if (!out.ok) throw new Error("not ok");
    expect(out.reconciled).toMatchObject({ checked: 1, confirmed: 1 });
    const rows = await ledger();
    expect(rows.map((r) => [r.subject_id, r.state])).toEqual([[f.paymentId, "confirmed"]]);
    expect(b.calls.payments).toBe(1);
  });

  it("stops at maxItems, at the deadline, and when the switch goes off mid-step", async () => {
    await payment("ui", "2026-11-02");
    await payment("ui", "2026-11-02");
    const b = books();
    expect(await postPendingBooks(service, opts({ maxItems: 1 }), deps(b.adapter))).toMatchObject({
      tried: 1,
      stop: "max_items",
    });
    expect(await postPendingBooks(service, opts({ deadlineMs: NOW_MS + 2_000 }), deps(b.adapter))).toMatchObject({
      tried: 0,
      stop: "deadline",
      reconciled: null,
    });
    expect(await ledger()).toHaveLength(1);
    const off = books({}, () => {
      flags.books.enabled = false;
    });
    expect(await postPendingBooks(service, opts(), deps(off.adapter))).toMatchObject({ tried: 1, stop: "disabled" });
    expect(off.calls.payments).toBe(1);
    expect(await ledger()).toHaveLength(2);
  });
});
