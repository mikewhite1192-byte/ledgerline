import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { requestIdOf } from "../../../money/keys";
import { MoneyError } from "../../../money/types";
import type { SendContext } from "../../types";
import { createQboAdapter } from "./adapter";
import { openToken } from "./crypto";
import {
  ACCESS,
  type Answer,
  fault,
  FakeQboDb,
  KEY,
  NEW_ACCESS,
  NEW_REFRESH,
  qboEnv,
  REALM,
  REALM_OFF_BY_ONE,
  REFRESH,
  scriptedFetch,
  TENANT,
  tokenReply,
} from "./test-fakes";

const saved = { ...flags };
const ACTION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const CUSTOMER = "0b9f3c1e-7d2a-4c55-9e10-3a4b5c6d7e8f";
const ctx = (actionId = ACTION): SendContext => ({
  requestId: requestIdOf(actionId),
  timeoutMs: 1_000,
  tenantZone: "America/Chicago",
});

const invoice = (over: Record<string, unknown> = {}) => ({
  actionId: ACTION,
  invoiceNumber: "BR-INV-1001",
  customerOutsideId: "58",
  issuedOn: "2026-11-02",
  dueOn: "2026-12-02",
  lines: [
    { kind: "linehaul" as const, description: "Linehaul", amountCents: 250_000 },
    { kind: "fuel_surcharge" as const, description: "Fuel surcharge", amountCents: 31_005 },
  ],
  ...over,
});

const invoiceReply = (total = 2810.05, customer = "58") => ({
  Invoice: { Id: "901", DocNumber: "BR-INV-1001", TotalAmt: total, CustomerRef: { value: customer } },
});

// The look by document number before every post: nothing holds it yet.
const NONE: Answer = { status: 200, body: { QueryResponse: {} } };
const held = (type: string, ...rows: unknown[]): Answer => ({
  status: 200,
  body: { QueryResponse: { [type]: rows } },
});

const OTHER_ACTION = "3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const payment = (over: Record<string, unknown> = {}) => ({
  actionId: ACTION,
  customerOutsideId: "58",
  paymentRef: "PAY-2001",
  receivedOn: "2026-11-20",
  amountCents: 10_000,
  applications: [{ invoiceOutsideId: "901", amountCents: 6_000 }],
  ...over,
});

// A payment as QuickBooks returns it: each line linking one invoice, the rest unapplied.
const paymentRecord = (lines: [string, number][], unapplied: number, total = 100) => ({
  Id: "950",
  PaymentRefNum: "PAY-2001",
  TotalAmt: total,
  UnappliedAmt: unapplied,
  CustomerRef: { value: "58" },
  Line: lines.map(([invoice, amount]) => ({
    Amount: amount,
    LinkedTxn: [{ TxnId: invoice, TxnType: "Invoice" }],
  })),
});

function make(answers: Answer[], db = new FakeQboDb(), env = qboEnv()) {
  const { fetch, sent } = scriptedFetch(answers);
  const lines: string[] = [];
  const adapter = createQboAdapter({ env, fetch, log: (l) => lines.push(l) });
  return { adapter, sent, lines, db };
}

beforeEach(() => {
  flags.accountingEnabled = true;
});

afterEach(() => {
  Object.assign(flags, saved);
});

describe("QuickBooks adapter: switch and settings", () => {
  it("refuses every write with the switch off and sends nothing", async () => {
    flags.accountingEnabled = false;
    const { adapter, sent, db } = make([]);
    expect(await adapter.ready(db)).toEqual({ ok: false, category: "disabled" });
    expect(await adapter.createInvoice(db, invoice(), ctx())).toEqual({ kind: "failed", category: "disabled" });
    await expect(
      adapter.ensureCustomer(db, { id: CUSTOMER, code: "CUST-1", name: "Test Shipper" }, ctx()),
    ).rejects.toMatchObject({ category: "disabled" });
    expect(sent).toHaveLength(0);
  });

  it("answers not_configured for missing or production settings, naming only the variable", async () => {
    for (const [over, variable] of [
      [{ QBO_ENVIRONMENT: "production" }, "QBO_ENVIRONMENT"],
      [{ QBO_ENVIRONMENT: undefined }, "QBO_ENVIRONMENT"],
      [{ QBO_ALLOWED_REALM_ID: "12345" }, "QBO_ALLOWED_REALM_ID"],
      [{ QBO_CLIENT_SECRET: undefined }, "QBO_CLIENT_SECRET"],
      [{ QBO_TOKEN_KEY: "short" }, "QBO_TOKEN_KEY"],
      [{ QBO_REDIRECT_URI: "http://app.example/api/qbo/callback" }, "QBO_REDIRECT_URI"],
    ] as const) {
      const { adapter, sent, lines, db } = make([], new FakeQboDb(), qboEnv(over));
      expect(await adapter.ready(db), variable).toEqual({ ok: false, category: "not_configured" });
      expect(sent).toHaveLength(0);
      expect(lines.join("\n"), variable).toContain(variable);
    }
  });

  it("refuses a stored company that is not the allowed one, as a whole string", async () => {
    const { adapter, sent, db } = make([], new FakeQboDb({ realmId: REALM_OFF_BY_ONE }));
    expect(await adapter.ready(db)).toEqual({ ok: false, category: "not_configured" });
    expect(await adapter.createInvoice(db, invoice(), ctx())).toEqual({
      kind: "failed",
      category: "not_configured",
    });
    expect(sent).toHaveLength(0);
  });

  it("answers not_connected with no row or an expired refresh token", async () => {
    for (const db of [new FakeQboDb({ connected: false }), new FakeQboDb({ refreshExpired: true })]) {
      const { adapter, sent } = make([], db);
      expect(await adapter.ready(db)).toEqual({ ok: false, category: "not_connected" });
      expect(sent).toHaveLength(0);
    }
  });

  it("refuses a context whose request id is not the action's", async () => {
    const { adapter, sent, db } = make([]);
    const wrong = { ...ctx(), requestId: requestIdOf(CUSTOMER) };
    expect(await adapter.createInvoice(db, invoice(), wrong)).toEqual({ kind: "failed", category: "validation" });
    expect(sent).toHaveLength(0);
  });
});

describe("QuickBooks adapter: creates", () => {
  it("looks for its number, then posts once with the ledger's requestid, the minor version and exact decimals", async () => {
    const { adapter, sent, db } = make([NONE, { status: 200, body: invoiceReply() }]);
    const out = await adapter.createInvoice(db, invoice(), ctx());
    expect(out).toEqual({
      kind: "confirmed",
      system: "qbo_sandbox",
      type: "Invoice",
      id: "901",
      ref: "BR-INV-1001",
      amountCents: 281_005,
    });
    expect(sent).toHaveLength(2);
    expect(sent[0].method).toBe("GET");
    expect(sent[0].url.searchParams.get("query")).toBe(
      "SELECT * FROM Invoice WHERE DocNumber = 'BR-INV-1001'",
    );
    const req = sent[1];
    expect(req.method).toBe("POST");
    expect(req.url.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(req.url.pathname).toBe(`/v3/company/${REALM}/invoice`);
    expect(req.url.searchParams.get("requestid")).toBe(ctx().requestId);
    expect(req.url.searchParams.get("minorversion")).toBe("75");
    expect(req.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(req.body).toContain('"Amount":2500.00');
    expect(req.body).toContain('"UnitPrice":310.05');
    expect(JSON.parse(req.body ?? "")).toEqual({
      CustomerRef: { value: "58" },
      DocNumber: "BR-INV-1001",
      TxnDate: "2026-11-02",
      DueDate: "2026-12-02",
      PrivateNote: `LedgerLine action ${ACTION}`,
      Line: [
        {
          DetailType: "SalesItemLineDetail",
          Amount: 2500,
          Description: "Linehaul",
          SalesItemLineDetail: { ItemRef: { value: "201" }, Qty: 1, UnitPrice: 2500 },
        },
        {
          DetailType: "SalesItemLineDetail",
          Amount: 310.05,
          Description: "Fuel surcharge",
          SalesItemLineDetail: { ItemRef: { value: "202" }, Qty: 1, UnitPrice: 310.05 },
        },
      ],
    });
  });

  it("maps refusals and unknowns from the status, never from Intuit's words", async () => {
    const cases: [Answer, unknown][] = [
      [{ status: 400, body: fault("2020") }, { kind: "failed", category: "validation", httpStatus: 400 }],
      [{ status: 403, body: fault("003100", "AuthorizationFault") }, { kind: "failed", category: "auth", httpStatus: 403 }],
      [{ status: 429, body: {} }, { kind: "failed", category: "rate_limited", httpStatus: 429 }],
      [{ status: 503, body: {} }, { kind: "unknown", category: "unavailable", httpStatus: 503 }],
      [{ status: 302 }, { kind: "unknown", category: "unknown", httpStatus: 302 }],
      [{ status: 200, body: fault("10000") }, { kind: "unknown", category: "unknown", httpStatus: 200 }],
      [{ status: 200, body: { Invoice: { Id: "x" } } }, { kind: "unknown", category: "unknown" }],
      [{ throws: "TimeoutError" }, { kind: "unknown", category: "timeout" }],
      [{ throws: "TypeError" }, { kind: "unknown", category: "network" }],
    ];
    for (const [answer, expected] of cases) {
      const { adapter, sent, lines, db } = make([NONE, answer]);
      expect(await adapter.createInvoice(db, invoice(), ctx()), JSON.stringify(answer)).toEqual(expected);
      expect(sent).toHaveLength(2);
      expect(lines.join("\n")).not.toMatch(/upstream|Bearer|access-|refresh-/);
    }
  });

  it("refreshes once on a 401, stores both rotated tokens and resends with the same requestid", async () => {
    const { adapter, sent, db } = make([
      NONE,
      { status: 401, body: fault("3200", "AuthenticationFault") },
      { status: 200, body: tokenReply() },
      { status: 200, body: invoiceReply() },
    ]);
    const out = await adapter.createInvoice(db, invoice(), ctx());
    expect(out).toMatchObject({ kind: "confirmed", id: "901" });
    expect(sent.map((s) => `${s.method} ${s.url.host}${s.url.pathname}`)).toEqual([
      `GET sandbox-quickbooks.api.intuit.com/v3/company/${REALM}/query`,
      `POST sandbox-quickbooks.api.intuit.com/v3/company/${REALM}/invoice`,
      "POST oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      `POST sandbox-quickbooks.api.intuit.com/v3/company/${REALM}/invoice`,
    ]);
    expect(sent[3].url.searchParams.get("requestid")).toBe(sent[1].url.searchParams.get("requestid"));
    expect(sent[3].headers.Authorization).toBe(`Bearer ${NEW_ACCESS}`);
    expect(new URLSearchParams(sent[2].body ?? "").get("refresh_token")).toBe(REFRESH);
    // Under FOR UPDATE, and the rotated refresh token is the one stored.
    expect(db.locks).toBe(1);
    expect(db.refreshed).toHaveLength(1);
    const [access, refresh] = db.refreshed[0].map(String);
    expect(openToken(KEY, Buffer.from(access, "base64"), TENANT, REALM, "access")).toBe(NEW_ACCESS);
    expect(openToken(KEY, Buffer.from(refresh, "base64"), TENANT, REALM, "refresh")).toBe(NEW_REFRESH);
  });

  it("answers auth after a second 401, with one refresh only", async () => {
    const { adapter, sent, db } = make([
      NONE,
      { status: 401, body: {} },
      { status: 200, body: tokenReply() },
      { status: 401, body: {} },
    ]);
    expect(await adapter.createInvoice(db, invoice(), ctx())).toEqual({
      kind: "failed",
      category: "auth",
      httpStatus: 401,
    });
    expect(sent).toHaveLength(4);
  });

  it("refreshes an expiring access token before the call", async () => {
    const db = new FakeQboDb({ expiring: true });
    const { adapter, sent } = make(
      [
        { status: 200, body: tokenReply() },
        NONE,
        { status: 200, body: invoiceReply() },
      ],
      db,
    );
    expect(await adapter.createInvoice(db, invoice(), ctx())).toMatchObject({ kind: "confirmed" });
    expect(sent[0].url.host).toBe("oauth.platform.intuit.com");
    expect(sent[1].headers.Authorization).toBe(`Bearer ${NEW_ACCESS}`);
    expect(sent[2].headers.Authorization).toBe(`Bearer ${NEW_ACCESS}`);
    expect(db.refreshed).toHaveLength(1);
  });

  it("answers not_connected when Intuit refuses the refresh token", async () => {
    const db = new FakeQboDb({ expiring: true });
    const { adapter } = make([{ status: 400, body: { error: "invalid_grant" } }], db);
    expect(await adapter.ready(db)).toEqual({ ok: false, category: "not_connected" });
    expect(db.refreshed).toHaveLength(0);
  });

  it("adopts our own document on a 6140, and refuses another party's", async () => {
    const ours = make([
      NONE,
      { status: 400, body: fault("6140") },
      held("Invoice", invoiceReply().Invoice),
    ]);
    expect(await ours.adapter.createInvoice(ours.db, invoice(), ctx())).toMatchObject({
      kind: "confirmed",
      id: "901",
      amountCents: 281_005,
    });
    expect(ours.sent[2].url.searchParams.get("query")).toBe(
      "SELECT * FROM Invoice WHERE DocNumber = 'BR-INV-1001'",
    );
    const theirs = make([
      NONE,
      { status: 400, body: fault("6140") },
      held("Invoice", invoiceReply(2810.05, "77").Invoice),
    ]);
    expect(await theirs.adapter.createInvoice(theirs.db, invoice(), ctx())).toEqual({
      kind: "failed",
      category: "validation",
    });
    const nothing = make([NONE, { status: 400, body: fault("6140") }, NONE]);
    expect(await nothing.adapter.createInvoice(nothing.db, invoice(), ctx())).toEqual({
      kind: "failed",
      category: "validation",
    });
    expect(nothing.sent.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("numbers a settlement bill with the tenant's key, then the period end and driver code", async () => {
    const bill = {
      actionId: ACTION,
      vendorOutsideId: "70",
      driverCode: "BR-D07",
      periodEnd: "2026-11-07",
      lines: [{ kind: "load_pay" as const, description: "Loads", amountCents: 180_000 }],
    };
    const reply = { Bill: { Id: "345", DocNumber: "T5B0E-261107-BR-D07", TotalAmt: 1800, VendorRef: { value: "70" } } };
    const { adapter, sent, db } = make([NONE, { status: 200, body: reply }]);
    expect(await adapter.createBill(db, bill, ctx())).toMatchObject({
      kind: "confirmed",
      type: "Bill",
      id: "345",
      ref: "T5B0E-261107-BR-D07",
    });
    expect(sent[0].url.searchParams.get("query")).toBe(
      "SELECT * FROM Bill WHERE DocNumber = 'T5B0E-261107-BR-D07'",
    );
    expect(JSON.parse(sent[1].body ?? "")).toMatchObject({ DocNumber: "T5B0E-261107-BR-D07" });
    // A driver code that would take the number past 21 characters is refused before sending.
    const long = make([]);
    expect(await long.adapter.createBill(long.db, { ...bill, driverCode: "DRV-12345" }, ctx())).toEqual({
      kind: "failed",
      category: "validation",
    });
    expect(long.sent).toHaveLength(0);
  });

  it("refuses a document number over Intuit's limit before sending", async () => {
    const { adapter, sent, db } = make([]);
    expect(
      await adapter.createInvoice(db, invoice({ invoiceNumber: "X".repeat(22) }), ctx()),
    ).toEqual({ kind: "failed", category: "validation" });
    expect(sent).toHaveLength(0);
  });
});

describe("QuickBooks adapter: a document number already held", () => {
  const posts = (sent: { method: string }[]) => sent.filter((r) => r.method === "POST").length;

  it("replays the same requestid: adopts what the look finds, or posts with the same requestid", async () => {
    // The first send went through and its answer was lost: the look finds it and nothing posts.
    const found = make([held("Invoice", invoiceReply().Invoice)]);
    expect(await found.adapter.createInvoice(found.db, invoice(), ctx())).toEqual({
      kind: "confirmed",
      system: "qbo_sandbox",
      type: "Invoice",
      id: "901",
      ref: "BR-INV-1001",
      amountCents: 281_005,
    });
    expect(posts(found.sent)).toBe(0);
    // Intuit had not listed it yet: the post carries the same requestid, so Intuit answers with
    // the first record instead of making a second.
    const first = make([NONE, { status: 200, body: invoiceReply() }]);
    const again = make([NONE, { status: 200, body: invoiceReply() }]);
    const a = await first.adapter.createInvoice(first.db, invoice(), ctx());
    const b = await again.adapter.createInvoice(again.db, invoice(), ctx());
    expect(b).toEqual(a);
    expect(again.sent[1].url.searchParams.get("requestid")).toBe(
      first.sent[1].url.searchParams.get("requestid"),
    );
  });

  it("adopts a single match under a new requestid instead of making a second document", async () => {
    const ours = { ...invoiceReply().Invoice, PrivateNote: `LedgerLine action ${ACTION}` };
    const { adapter, sent, lines, db } = make([held("Invoice", ours)]);
    const out = await adapter.createInvoice(db, invoice({ actionId: OTHER_ACTION }), ctx(OTHER_ACTION));
    expect(out).toMatchObject({ kind: "confirmed", id: "901", amountCents: 281_005 });
    expect(posts(sent)).toBe(0);
    expect(lines).toContain("qbo: Invoice adopted by number id=901");
    expect(lines.join("\n")).not.toContain("hand-made");
  });

  it("tags an adopted document without our private note as hand-made in the log", async () => {
    for (const row of [invoiceReply().Invoice, { ...invoiceReply().Invoice, PrivateNote: "Entered by hand" }]) {
      const { adapter, sent, lines, db } = make([held("Invoice", row)]);
      expect(await adapter.createInvoice(db, invoice(), ctx())).toMatchObject({ kind: "confirmed", id: "901" });
      expect(posts(sent)).toBe(0);
      expect(lines).toContain("qbo: Invoice adopted by number id=901 hand-made");
    }
  });

  it("never posts when two documents carry the number", async () => {
    const { adapter, sent, lines, db } = make([
      held("Invoice", invoiceReply().Invoice, { ...invoiceReply().Invoice, Id: "902" }),
    ]);
    expect(await adapter.createInvoice(db, invoice(), ctx())).toEqual({ kind: "unknown", category: "unknown" });
    expect(posts(sent)).toBe(0);
    expect(lines.join("\n")).toContain("duplicate");
  });

  it("never posts or confirms on a match with another amount, a void or another party", async () => {
    const cases: [unknown, unknown, string | null][] = [
      [invoiceReply(2810.04).Invoice, { kind: "failed", category: "amount_mismatch" }, "amount_mismatch"],
      [
        { ...invoiceReply(0).Invoice, PrivateNote: "Voided - LedgerLine action" },
        { kind: "failed", category: "amount_mismatch" },
        "voided",
      ],
      [
        invoiceReply(2810.05, "77").Invoice,
        { kind: "failed", category: "validation" },
        "number held by another party",
      ],
      [{ ...invoiceReply().Invoice, TotalAmt: "x" }, { kind: "unknown", category: "unknown" }, null],
    ];
    for (const [row, expected, logged] of cases) {
      const { adapter, sent, lines, db } = make([held("Invoice", row)]);
      expect(await adapter.createInvoice(db, invoice(), ctx()), JSON.stringify(row)).toEqual(expected);
      expect(posts(sent)).toBe(0);
      expect(lines.join("\n")).not.toContain("adopted");
      if (logged) expect(lines.join("\n")).toContain(logged);
    }
  });

  it("sends nothing when the look itself fails", async () => {
    const { adapter, sent, db } = make([{ status: 503, body: {} }]);
    expect(await adapter.createInvoice(db, invoice(), ctx())).toEqual({ kind: "failed", category: "unavailable" });
    expect(posts(sent)).toBe(0);
  });

  it("looks a customer payment up by its reference number", async () => {
    const { adapter, sent, db } = make([held("Payment", paymentRecord([["901", 60]], 40))]);
    expect(await adapter.recordCustomerPayment(db, payment(), ctx())).toMatchObject({
      kind: "confirmed",
      type: "Payment",
      id: "950",
    });
    expect(sent[0].url.searchParams.get("query")).toBe(
      "SELECT * FROM Payment WHERE PaymentRefNum = 'PAY-2001'",
    );
  });
});

describe("QuickBooks adapter: customer payments as applied", () => {
  it("confirms a payment applied exactly as asked", async () => {
    const { adapter, sent, db } = make([NONE, { status: 200, body: { Payment: paymentRecord([["901", 60]], 40) } }]);
    expect(await adapter.recordCustomerPayment(db, payment(), ctx())).toEqual({
      kind: "confirmed",
      system: "qbo_sandbox",
      type: "Payment",
      id: "950",
      ref: "PAY-2001",
      amountCents: 10_000,
    });
    expect(JSON.parse(sent[1].body ?? "").Line).toEqual([
      { Amount: 60, LinkedTxn: [{ TxnId: "901", TxnType: "Invoice" }] },
    ]);
  });

  it("never confirms a payment QuickBooks cut to the invoice's open balance", async () => {
    // Asked 60.00 on the invoice; QuickBooks applied 45.00 and left 55.00 unapplied, total as sent.
    const { adapter, lines, db } = make([NONE, { status: 200, body: { Payment: paymentRecord([["901", 45]], 55) } }]);
    expect(await adapter.recordCustomerPayment(db, payment(), ctx())).toEqual({
      kind: "failed",
      category: "amount_mismatch",
    });
    expect(lines.join("\n")).toContain("applied_short");
  });

  it("never confirms a payment whose unapplied rest or lines cannot be read", async () => {
    const noRest = { ...paymentRecord([["901", 60]], 40) } as Record<string, unknown>;
    delete noRest.UnappliedAmt;
    const twoLinks = {
      ...paymentRecord([], 40),
      Line: [{ Amount: 60, LinkedTxn: [{ TxnId: "901", TxnType: "Invoice" }, { TxnId: "902", TxnType: "Invoice" }] }],
    };
    const otherInvoice = paymentRecord([["903", 60]], 40);
    for (const record of [noRest, twoLinks, otherInvoice]) {
      const { adapter, db } = make([NONE, { status: 200, body: { Payment: record } }]);
      expect(await adapter.recordCustomerPayment(db, payment(), ctx()), JSON.stringify(record)).toEqual({
        kind: "failed",
        category: "amount_mismatch",
      });
    }
  });

  it("never adopts a held payment that was cut", async () => {
    const { adapter, sent, db } = make([held("Payment", paymentRecord([["901", 45]], 55))]);
    expect(await adapter.recordCustomerPayment(db, payment(), ctx())).toEqual({
      kind: "failed",
      category: "amount_mismatch",
    });
    expect(sent.filter((r) => r.method === "POST")).toHaveLength(0);
  });
});

describe("QuickBooks adapter: customers and vendors", () => {
  const customer = { id: CUSTOMER, code: "CUST-1", name: "Test O'Shipper" };

  it("uses the stored id first and sends nothing", async () => {
    const db = new FakeQboDb();
    db.entityIds.set(`customers:${CUSTOMER}`, "58");
    const { adapter, sent } = make([], db);
    expect(await adapter.ensureCustomer(db, customer, ctx())).toEqual({ outsideId: "58" });
    expect(sent).toHaveLength(0);
  });

  it("finds by display name, quote escaped, then stores the id", async () => {
    const db = new FakeQboDb();
    const { adapter, sent } = make(
      [{ status: 200, body: { QueryResponse: { Customer: [{ Id: "58" }] } } }],
      db,
    );
    expect(await adapter.ensureCustomer(db, customer, ctx())).toEqual({ outsideId: "58" });
    expect(sent[0].url.searchParams.get("query")).toBe(
      "SELECT * FROM Customer WHERE DisplayName = 'T5B0E6F1A2C3D Test O\\'Shipper (CUST-1)'",
    );
    expect(db.entityIds.get(`customers:${CUSTOMER}`)).toBe("58");
  });

  it("creates with its own stable requestid, and looks again after a 6240", async () => {
    const created = make([
      { status: 200, body: { QueryResponse: {} } },
      { status: 200, body: { Customer: { Id: "59" } } },
    ]);
    expect(await created.adapter.ensureCustomer(created.db, customer, ctx())).toEqual({ outsideId: "59" });
    const requestId = created.sent[1].url.searchParams.get("requestid");
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(requestId).not.toBe(ctx().requestId);
    expect(JSON.parse(created.sent[1].body ?? "")).toEqual({
      DisplayName: "T5B0E6F1A2C3D Test O'Shipper (CUST-1)",
    });

    const again = make([
      { status: 200, body: { QueryResponse: {} } },
      { status: 400, body: fault("6240") },
      { status: 200, body: { QueryResponse: { Customer: [{ Id: "60" }] } } },
    ]);
    expect(await again.adapter.ensureCustomer(again.db, customer, ctx())).toEqual({ outsideId: "60" });
    expect(again.sent[1].url.searchParams.get("requestid")).toBe(requestId);
  });

  it("refuses two records with one display name", async () => {
    const { adapter, db } = make([
      { status: 200, body: { QueryResponse: { Customer: [{ Id: "58" }, { Id: "61" }] } } },
    ]);
    await expect(adapter.ensureCustomer(db, customer, ctx())).rejects.toMatchObject({
      category: "not_configured",
    });
    expect(db.entityIds.size).toBe(0);
  });

  it("marks an owner-operator vendor for 1099s", async () => {
    const { adapter, sent, db } = make([
      { status: 200, body: { QueryResponse: {} } },
      { status: 200, body: { Vendor: { Id: "70" } } },
    ]);
    const driver = {
      id: CUSTOMER,
      code: "DRV-7",
      firstName: "Sam",
      lastName: "Rivera",
      workerType: "owner_operator",
    };
    expect(await adapter.ensureVendor(db, driver, ctx())).toEqual({ outsideId: "70" });
    expect(JSON.parse(sent[1].body ?? "")).toEqual({
      DisplayName: "T5B0E6F1A2C3D Rivera, Sam (DRV-7)",
      Vendor1099: true,
    });
    expect(db.entityIds.get(`drivers:${CUSTOMER}`)).toBe("70");
  });
});

describe("QuickBooks adapter: read-back", () => {
  const ref = (over: Record<string, unknown> = {}) => ({
    type: "Invoice",
    requestId: ctx().requestId,
    outsideId: "901",
    outsideRef: null,
    ...over,
  });

  it("reads by id, with the switch off too", async () => {
    flags.accountingEnabled = false;
    const { adapter, sent, db } = make([{ status: 200, body: invoiceReply() }]);
    expect(await adapter.readBack(db, ref(), ctx())).toEqual({
      found: true,
      system: "qbo_sandbox",
      type: "Invoice",
      id: "901",
      ref: "BR-INV-1001",
      amountCents: 281_005,
      status: "succeeded",
    });
    expect(sent[0].method).toBe("GET");
    expect(sent[0].url.pathname).toBe(`/v3/company/${REALM}/invoice/901`);
    expect(sent[0].url.searchParams.get("requestid")).toBeNull();
  });

  it("answers not found for a 610, and finds by document number when there is no id", async () => {
    const gone = make([{ status: 400, body: fault("610") }]);
    expect(await gone.adapter.readBack(gone.db, ref(), ctx())).toEqual({ found: false });

    const byRef = make([{ status: 200, body: { QueryResponse: { Invoice: [invoiceReply().Invoice] } } }]);
    expect(
      await byRef.adapter.readBack(byRef.db, ref({ outsideId: null, outsideRef: "BR-INV-1001" }), ctx()),
    ).toMatchObject({ found: true, id: "901" });

    const none = make([{ status: 200, body: { QueryResponse: {} } }]);
    expect(
      await none.adapter.readBack(none.db, ref({ outsideId: null, outsideRef: "BR-INV-1001" }), ctx()),
    ).toEqual({ found: false });
  });

  it("never reads a document found by number as ours when it belongs to another party", async () => {
    const byNumber = (partyOutsideId?: string | null) =>
      ref({ outsideId: null, outsideRef: "BR-INV-1001", partyOutsideId });
    // Another customer's document, or one with no readable party: not ours, nothing posted.
    for (const row of [invoiceReply(2810.05, "77").Invoice, { ...invoiceReply().Invoice, CustomerRef: undefined }]) {
      const other = make([held("Invoice", row)]);
      expect(await other.adapter.readBack(other.db, byNumber("58"), ctx()), JSON.stringify(row)).toEqual({
        found: false,
      });
      expect(other.sent.map((r) => r.method)).toEqual(["GET"]);
      expect(other.lines).toContain("qbo: Invoice number held by another party");
    }
    // The same customer: found as before.
    const same = make([held("Invoice", invoiceReply().Invoice)]);
    expect(await same.adapter.readBack(same.db, byNumber("58"), ctx())).toMatchObject({
      found: true,
      id: "901",
      status: "succeeded",
    });
    expect(same.lines.join("\n")).not.toContain("another party");
    // No party given: unchanged, the single match is read back.
    for (const party of [undefined, null]) {
      const open = make([held("Invoice", invoiceReply(2810.05, "77").Invoice)]);
      expect(await open.adapter.readBack(open.db, byNumber(party), ctx())).toMatchObject({
        found: true,
        id: "901",
      });
    }
  });

  it("refuses a malformed party before sending anything", async () => {
    const { adapter, sent, db } = make([]);
    for (const partyOutsideId of ["", "58 ", "5a", 58]) {
      await expect(
        adapter.readBack(
          db,
          ref({ outsideId: null, outsideRef: "BR-INV-1001", partyOutsideId }) as never,
          ctx(),
        ),
      ).rejects.toMatchObject({ category: "validation" });
    }
    expect(sent).toHaveLength(0);
  });

  it("throws on two documents with one number, and on an unreadable answer", async () => {
    const two = make([
      { status: 200, body: { QueryResponse: { Invoice: [invoiceReply().Invoice, { ...invoiceReply().Invoice, Id: "902" }] } } },
    ]);
    const err = await two.adapter
      .readBack(two.db, ref({ outsideId: null, outsideRef: "BR-INV-1001" }), ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoneyError);
    expect(err).toMatchObject({ category: "duplicate" });
    // Reading back never makes anything.
    expect(two.sent.map((r) => r.method)).toEqual(["GET"]);
    expect(two.lines.join("\n")).toContain("duplicate");
    const down = make([{ status: 503, body: {} }]);
    await expect(down.adapter.readBack(down.db, ref(), ctx())).rejects.toMatchObject({
      category: "unavailable",
    });
  });

  it("reads a voided document back as canceled, by id and by number", async () => {
    const voided = { ...invoiceReply(0).Invoice, PrivateNote: "Voided - LedgerLine action" };
    const byId = make([{ status: 200, body: { Invoice: voided } }]);
    expect(await byId.adapter.readBack(byId.db, ref(), ctx())).toMatchObject({
      found: true,
      id: "901",
      amountCents: 0,
      status: "canceled",
    });
    expect(byId.lines.join("\n")).toContain("voided");
    const byNumber = make([held("Invoice", voided)]);
    expect(
      await byNumber.adapter.readBack(byNumber.db, ref({ outsideId: null, outsideRef: "BR-INV-1001" }), ctx()),
    ).toMatchObject({ found: true, status: "canceled" });
    // A zero total without the note: still never a success.
    const zeroed = make([{ status: 200, body: invoiceReply(0) }]);
    expect(await zeroed.adapter.readBack(zeroed.db, ref(), ctx())).toMatchObject({ status: "canceled" });
    // The note alone, total kept: canceled too.
    const noted = make([{ status: 200, body: { Invoice: { ...invoiceReply().Invoice, PrivateNote: "Voided" } } }]);
    expect(await noted.adapter.readBack(noted.db, ref(), ctx())).toMatchObject({ status: "canceled" });
  });

  it("reads a payment back as succeeded only when applied as asked", async () => {
    const asked = [{ invoiceOutsideId: "901", amountCents: 6_000 }];
    const payRef = (over: Record<string, unknown> = {}) =>
      ref({ type: "Payment", outsideId: "950", applications: asked, ...over });
    const good = make([{ status: 200, body: { Payment: paymentRecord([["901", 60]], 40) } }]);
    expect(await good.adapter.readBack(good.db, payRef(), ctx())).toMatchObject({
      found: true,
      id: "950",
      amountCents: 10_000,
      status: "succeeded",
    });
    const cut = make([{ status: 200, body: { Payment: paymentRecord([["901", 45]], 55) } }]);
    await expect(cut.adapter.readBack(cut.db, payRef(), ctx())).rejects.toMatchObject({
      category: "amount_mismatch",
    });
    expect(cut.lines.join("\n")).toContain("applied_short");
  });

  it("refuses to read a payment back without what it was asked to apply, sending nothing", async () => {
    const { adapter, sent, db } = make([]);
    await expect(
      adapter.readBack(db, ref({ type: "Payment", outsideId: "950" }), ctx()),
    ).rejects.toMatchObject({ category: "validation" });
    expect(sent).toHaveLength(0);
  });
});
