import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import type { Param, Queryable } from "../db";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import type { EmailSender } from "../driver-notes/deliver";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { approveReminder, rejectReminder } from "./decide";
import { draftCollections, DRAFTING_LEASE_MS, REMINDER_PURPOSE, type CompleteFn } from "./draft";
import { sendReminder } from "./send";
import { readCollectionsView } from "./view";

// Collections against the real database, as the app's role, with a fake model. Each late invoice
// gets at most one reminder per stage however many runs press the button; a reminder that fails
// the check keeps no text; a run stops at its spending cap and the rest wait (over_cap) for the
// next run; approval re-reads the invoice and refuses one paid since drafting; approval records
// the reminder and email stays refused, logged as "would send" with a category and never the
// address, until every switch agrees, and then goes once; and another carrier sees none of it.
// Only this file's tenants are made, and they are removed after.

const saved = {
  ...flags,
  collectionsLimits: { ...flags.collectionsLimits },
  collectionsEmailAllowlist: [...flags.collectionsEmailAllowlist],
};
// 10:00 AM in Chicago, the fixture carrier's zone: its date is Nov 2, 2026.
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const clock = () => new Date(NOW);
const deadline = () => new Date(NOW + 20_000);
const NANOCENTS_PER_CENT = 1_000_000_000;

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let address: string;

// Letters only, so the carrier's name brings no digits into the reminder.
function letters(n: number): string {
  return Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
}

// The fixture carrier's invoices, all to its one customer, as of Nov 2, 2026:
//   L97  due Jul 28: 97 days late, stage 90
//   L62  due Sep 1: 62 days late, stage 60
//   L34  due Sep 29: 34 days late, stage 30
//   L12  due Oct 21: 12 days late, no reminder
const INVOICES = {
  L97: { id: randomUUID(), number: "TST-INV-10001", amount: 120_000, issued: "2026-06-28", due: "2026-07-28" },
  L62: { id: randomUUID(), number: "TST-INV-10002", amount: 80_000, issued: "2026-08-02", due: "2026-09-01" },
  L34: { id: randomUUID(), number: "TST-INV-10003", amount: 50_000, issued: "2026-08-30", due: "2026-09-29" },
  L12: { id: randomUUID(), number: "TST-INV-10004", amount: 30_000, issued: "2026-09-21", due: "2026-10-21" },
};

async function seedInvoices(f: Fixture, slug: string) {
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      "UPDATE customers SET billing_email = $2 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [f.customerId, `ar@${slug}.example`],
    );
    for (const inv of Object.values(INVOICES)) {
      await q.execute(
        `INSERT INTO invoices (id, tenant_id, source, load_id, customer_id, invoice_number, amount_cents,
           issued_on, due_on, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'opening', NULL, CAST($2 AS uuid), $3, $4,
           CAST($5 AS date), CAST($6 AS date), 'open')`,
        [inv.id, f.customerId, inv.number, inv.amount, inv.issued, inv.due],
      );
    }
  });
}

// What the fake model saw, and how much each call costs in the ledger.
let seen: AiRequest[] = [];
let costCents = 0;

function fact(request: AiRequest, label: string): string {
  const user = request.messages.find((m) => m.role === "user")?.content ?? "";
  const line = user.split("\n").find((l) => l.startsWith(`${label}: `));
  if (line === undefined) throw new Error(`the pack has no ${label}`);
  return line.slice(label.length + 2);
}

// The call's row in the model ledger, as complete() writes it before it returns the call's id.
async function ledgerRow(q: Queryable, id: string, request: AiRequest) {
  await q.execute(
    `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, trace_id, status,
       reserved_nanocents, cost_nanocents)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'spark', 'meta', 'test-model', 'text', $2,
       CAST($3 AS uuid), 'ok', $4, $4)`,
    [id, request.purpose, request.traceId ?? null, costCents * NANOCENTS_PER_CENT],
  );
}

async function result(request: AiRequest, session: Session, text: string, status: AiResult["status"] = "ok"): Promise<AiResult> {
  const callId = randomUUID();
  await admin.withTenant(session.tenantId, (q) => ledgerRow(q, callId, request));
  return {
    callId,
    status,
    text,
    toolCalls: [],
    usage: { input: 0, cached: 0, output: 0, reasoning: 0 },
    costNanocents: costCents * NANOCENTS_PER_CENT,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  };
}

// A reminder written from the pack's own facts: it passes the check on its own numbers.
function goodText(request: AiRequest, balance = fact(request, "Balance due")): string {
  const number = fact(request, "Invoice number");
  const days = fact(request, "Days past due");
  const carrier = fact(request, "From (the carrier)");
  return JSON.stringify({
    subject: `Invoice ${number} is past due`,
    body: `Hello,\n\nThe balance of ${balance} on invoice ${number} is ${days} days past due. Please send payment or reply with a payment date.\n\nThank you,\n${carrier}`,
  });
}

const goodModel: CompleteFn = async (_target, request, session) => {
  seen.push(request);
  return result(request, session, goodText(request));
};

const draft = (complete: CompleteFn = goodModel, session?: Session) =>
  draftCollections(session ?? A.session, deadline(), { db: app, complete, clock, log: () => {} });

type DraftRow = {
  id: string;
  invoice_id: string;
  stage: string;
  tone: string;
  status: string;
  subject: string | null;
  body: string | null;
  refusal_category: string | null;
  verification: { found?: number[] } | null;
  model_call_id: string | null;
  trace_id: string;
  channel: string | null;
  sent_at: string | null;
};

async function rowsOf(f: Fixture): Promise<DraftRow[]> {
  return admin.withTenant(f.tenantId, (q) =>
    q.query<DraftRow>(
      `SELECT CAST(d.id AS text) AS id, CAST(d.invoice_id AS text) AS invoice_id, d.stage, d.tone, d.status,
              d.subject, d.body, d.refusal_category, d.verification, CAST(d.model_call_id AS text) AS model_call_id,
              CAST(d.trace_id AS text) AS trace_id, d.channel, CAST(d.sent_at AS text) AS sent_at
         FROM collection_drafts d WHERE d.tenant_id = current_tenant_id() ORDER BY d.stage DESC`,
    ),
  );
}
const rowFor = async (invoiceId: string) => (await rowsOf(A)).find((r) => r.invoice_id === invoiceId);

// One application of the fixture's unapplied payment to an invoice, as the app records one.
async function applyPayment(invoiceId: string, cents: number) {
  const id = randomUUID();
  await admin.withTenant(A.tenantId, (q) =>
    q.execute(
      `INSERT INTO payment_applications (id, tenant_id, payment_id, invoice_id, amount_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4)`,
      [id, A.paymentId, invoiceId, cents],
    ),
  );
  return id;
}

async function clearA() {
  await admin.withTenant(A.tenantId, async (q) => {
    await q.execute("DELETE FROM collection_drafts WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM payment_applications WHERE tenant_id = current_tenant_id()");
  });
}

describe("collections", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const slugA = `col-${letters(8)}`;
    A = await makeTenant(admin, slugA);
    B = await makeTenant(admin, `col-${letters(8)}`);
    address = `ar@${slugA}.example`;
    await seedInvoices(A, slugA);
  });

  beforeEach(async () => {
    Object.assign(flags, saved, {
      collectionsLimits: { ...saved.collectionsLimits },
      collectionsEmailAllowlist: [],
      collectionsEnabled: true,
      collectionsEmailEnabled: false,
      collectionsEmailFrom: "",
      aiEnabled: true,
    });
    seen = [];
    costCents = 0;
    await clearA();
  });

  afterEach(() => {
    Object.assign(flags, saved, {
      collectionsLimits: { ...saved.collectionsLimits },
      collectionsEmailAllowlist: [...saved.collectionsEmailAllowlist],
    });
  });

  afterAll(async () => {
    Object.assign(flags, saved);
    if (A) await clearA();
    await dropTenant(admin, A);
    await dropTenant(admin, B);
    await app?.close();
    await admin?.close();
  });

  it("drafts one reminder per late invoice at its stage and tone, from the pack's figures only", async () => {
    const out = await draft();
    expect(out).toMatchObject({ ok: true, drafted: 3, refused: 0, overCap: 0, skipped: 0, remaining: 0, stoppedBy: null, more: false });
    const rows = await rowsOf(A);
    expect(rows.map((r) => [r.invoice_id, r.stage, r.status])).toEqual([
      [INVOICES.L97.id, "90", "drafted"],
      [INVOICES.L62.id, "60", "drafted"],
      [INVOICES.L34.id, "30", "drafted"],
    ]);
    // A customer with two invoices open past 30 days is repeat_late: direct at 30, firm after.
    expect(rows.map((r) => r.tone)).toEqual(["firm", "firm", "direct"]);
    expect(rows[2].subject).toBe(`Invoice ${INVOICES.L34.number} is past due`);
    expect(rows[2].body).toContain("The balance of $500.00");
    // One run, one trace; every reminder names its own call of that run.
    expect(new Set(rows.map((r) => r.trace_id)).size).toBe(1);
    expect(rows.every((r) => r.model_call_id !== null)).toBe(true);
    // The model saw the names and the figures, never an id or an address.
    const pack = seen.map((r) => r.messages.map((m) => m.content).join("\n")).join("\n");
    expect(pack).toContain("To (the customer): Test Shipper");
    for (const inv of Object.values(INVOICES)) expect(pack).not.toContain(inv.id);
    expect(pack).not.toContain("@");
    expect(pack).not.toContain(INVOICES.L12.number);
  });

  it("the same invoice and stage never gets a second draft (unique key, and the planner skips it)", async () => {
    await draft();
    const second = await draft();
    expect(second).toMatchObject({ ok: true, drafted: 0, skipped: 3, remaining: 0, more: false });
    expect(seen).toHaveLength(3);
    expect(await rowsOf(A)).toHaveLength(3);
    // The key itself: a second reservation for the same invoice and stage is refused by the table.
    const state = await sqlStateOf(
      app.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO collection_drafts (id, tenant_id, invoice_id, customer_id, stage, tone, status, figures, trace_id)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), '30', 'direct', 'drafting',
             CAST('{}' AS jsonb), CAST($4 AS uuid))`,
          [randomUUID(), INVOICES.L34.id, A.customerId, randomUUID()],
        ),
      ),
    );
    expect(state).toBe("23505");
    // Two runs at once still make one reminder per invoice and stage.
    await clearA();
    seen = [];
    const [x, y] = await Promise.all([draft(), draft()]);
    expect((x.ok ? x.drafted : 0) + (y.ok ? y.drafted : 0)).toBe(3);
    expect(await rowsOf(A)).toHaveLength(3);
    expect(seen).toHaveLength(3);
  });

  it("a reminder with a figure not in the pack is refused as number_mismatch, and keeps no text", async () => {
    const wrong: CompleteFn = async (_t, request, session) => {
      seen.push(request);
      const balance = fact(request, "Balance due");
      return result(request, session, goodText(request, balance === "$500.00" ? "$550.00" : balance));
    };
    const out = await draft(wrong);
    expect(out).toMatchObject({ ok: true, drafted: 2, refused: 1 });
    const row = await rowFor(INVOICES.L34.id);
    expect(row).toMatchObject({ status: "refused", refusal_category: "number_mismatch", subject: null, body: null });
    expect(row!.verification?.found).toContain(55_000);
    expect(row!.model_call_id).not.toBeNull();
    // Refused is final for that stage: the next run does not draft it again.
    expect(await draft()).toMatchObject({ ok: true, drafted: 0, skipped: 3 });
  });

  it("a cut-short answer is refused as incomplete, and a failed call keeps its category only", async () => {
    let n = 0;
    const flaky: CompleteFn = async (_t, request, session) => {
      n += 1;
      if (n === 1) return result(request, session, '{"subject": "Invoice', "incomplete");
      throw new AiError("timeout");
    };
    const out = await draft(flaky);
    expect(out).toMatchObject({ ok: true, drafted: 0, refused: 2, stoppedBy: "model", more: true });
    const rows = await rowsOf(A);
    expect(rows.map((r) => [r.stage, r.status, r.refusal_category])).toEqual([
      ["90", "refused", "incomplete"],
      ["60", "refused", "timeout"],
    ]);
    expect(rows[1].model_call_id).toBeNull();
    expect(rows.every((r) => r.subject === null && r.body === null)).toBe(true);
  });

  it("a call turned down before any request leaves the reminder waiting, never refused", async () => {
    const capped: CompleteFn = async () => {
      throw new AiError("cap");
    };
    const out = await draft(capped);
    expect(out).toMatchObject({ ok: true, drafted: 0, refused: 0, overCap: 1, stoppedBy: "model", more: true });
    expect((await rowsOf(A)).map((r) => [r.stage, r.status, r.model_call_id])).toEqual([["90", "over_cap", null]]);
    // The next run picks it up with the rest.
    expect(await draft()).toMatchObject({ ok: true, drafted: 3, overCap: 0, more: false });
  });

  it("a run stops at maxRunCents and marks the rest over_cap", async () => {
    flags.collectionsLimits = { ...flags.collectionsLimits, maxDraftCents: 2, maxRunCents: 4 };
    costCents = 2;
    const first = await draft();
    // Two calls of 2 cents fill the 4-cent run; the third would pass it, so it is never made.
    expect(first).toMatchObject({ ok: true, drafted: 2, overCap: 1, stoppedBy: "cap", remaining: 0, more: true });
    expect(seen).toHaveLength(2);
    const waiting = await rowFor(INVOICES.L34.id);
    expect(waiting).toMatchObject({ status: "over_cap", model_call_id: null, subject: null });
    const view = await app.withTenant(A.tenantId, (q) => readCollectionsView(q, clock()));
    expect(view.toDraft.map((l) => l.invoiceId)).toEqual([INVOICES.L34.id]);
    expect(view.cards.map((c) => c.status)).toEqual(["drafted", "drafted"]);
    // The next run is a new trace with its own cap, and picks the waiting reminder up.
    const second = await draft();
    expect(second).toMatchObject({ ok: true, drafted: 1, overCap: 0, skipped: 2, more: false });
    const picked = await rowFor(INVOICES.L34.id);
    expect(picked!.status).toBe("drafted");
    expect(picked!.trace_id).not.toBe(waiting!.trace_id);
  });

  it("a reminder left drafting past its lease is refused as interrupted on the next run", async () => {
    const old = new Date(NOW - DRAFTING_LEASE_MS - 1_000).toISOString();
    await app.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO collection_drafts (id, tenant_id, invoice_id, customer_id, stage, tone, status, figures, trace_id,
           created_at, updated_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), '30', 'direct', 'drafting',
           CAST('{}' AS jsonb), CAST($4 AS uuid), CAST($5 AS timestamptz), CAST($5 AS timestamptz))`,
        [randomUUID(), INVOICES.L34.id, A.customerId, randomUUID(), old],
      ),
    );
    const out = await draft();
    expect(out).toMatchObject({ ok: true, drafted: 2, skipped: 1 });
    expect(await rowFor(INVOICES.L34.id)).toMatchObject({ status: "refused", refusal_category: "interrupted" });
  });

  it("approve refuses paid_since when the invoice was paid after drafting", async () => {
    await draft();
    const row = (await rowFor(INVOICES.L34.id))!;
    await applyPayment(INVOICES.L34.id, 10_000);
    expect(await approveReminder(A.session, row.id, { db: app, clock, log: () => {} })).toEqual({
      ok: false,
      category: "paid_since",
    });
    expect((await rowFor(INVOICES.L34.id))!.status).toBe("drafted");
    // A person can still clear it.
    expect(await rejectReminder(A.session, row.id, { db: app, clock })).toEqual({ ok: true, status: "rejected" });
    expect(await rejectReminder(A.session, row.id, { db: app, clock })).toEqual({ ok: false, category: "already_decided" });
  });

  it("approve logs would send with the category and never the address when email is off, the list is empty, the date is before from, or no sender is injected", async () => {
    await draft();
    const row = (await rowFor(INVOICES.L62.id))!;
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const sender = vi.fn<EmailSender>(async () => {});
    const deps = { db: app, clock, log };

    // Email off: approval records it, and nothing is sent.
    const approved = await approveReminder(A.session, row.id, { ...deps, send: sender });
    expect(approved).toEqual({ ok: true, status: "approved", channel: "logged", email: { sent: false, category: "disabled" } });
    expect(await rowFor(INVOICES.L62.id)).toMatchObject({ status: "approved", channel: "logged", sent_at: null });

    flags.collectionsEmailEnabled = true;
    // No start date set: off.
    expect(await sendReminder(A.session, row.id, { ...deps, send: sender })).toEqual({ sent: false, category: "disabled" });
    flags.collectionsEmailFrom = "2026-11-02";
    // An empty list refuses every address.
    expect(await sendReminder(A.session, row.id, { ...deps, send: sender })).toEqual({ sent: false, category: "not_allowlisted" });
    flags.collectionsEmailAllowlist = [address];
    // No sender handed in: production ships none.
    expect(await sendReminder(A.session, row.id, deps)).toEqual({ sent: false, category: "no_sender" });
    // Drafted the day before the start: never sent.
    flags.collectionsEmailFrom = "2026-11-03";
    expect(await sendReminder(A.session, row.id, { ...deps, send: sender })).toEqual({ sent: false, category: "before_start" });

    expect(sender).not.toHaveBeenCalled();
    expect(lines).toEqual(
      ["disabled", "disabled", "not_allowlisted", "no_sender", "before_start"].map(
        (c) => `collections: would send reminder ${row.id} (${c})`,
      ),
    );
    for (const line of lines) expect(line).not.toContain("@");
    expect(await rowFor(INVOICES.L62.id)).toMatchObject({ channel: "logged", sent_at: null });
  });

  it("the reservation flips channel to email once, a second call is a no-op", async () => {
    await draft();
    const row = (await rowFor(INVOICES.L97.id))!;
    flags.collectionsEmailEnabled = true;
    flags.collectionsEmailFrom = "2026-11-02";
    flags.collectionsEmailAllowlist = [address];
    const sender = vi.fn<EmailSender>(async () => {});
    const lines: string[] = [];
    const deps = { db: app, clock, log: (l: string) => lines.push(l), send: sender };

    const approved = await approveReminder(A.session, row.id, deps);
    expect(approved).toEqual({ ok: true, status: "approved", channel: "email", email: { sent: true } });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0]).toEqual({ noteId: row.id, to: address, subject: row.subject, text: row.body });
    const sent = (await rowFor(INVOICES.L97.id))!;
    expect(sent.channel).toBe("email");
    expect(sent.sent_at).not.toBeNull();

    expect(await sendReminder(A.session, row.id, deps)).toEqual({ sent: false, category: "already_sent" });
    expect(await approveReminder(A.session, row.id, deps)).toEqual({ ok: false, category: "already_decided" });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).not.toContain("@");

    // A send that throws may have gone out: unknown, and never sent again.
    const other = (await rowFor(INVOICES.L62.id))!;
    const failing = vi.fn(async () => {
      throw new Error(`provider refused ${address}`);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await approveReminder(A.session, other.id, { ...deps, send: failing })).toMatchObject({
      ok: true,
      email: { sent: false, category: "unknown" },
    });
    expect(await sendReminder(A.session, other.id, { ...deps, send: failing })).toEqual({ sent: false, category: "already_sent" });
    expect(failing).toHaveBeenCalledTimes(1);
    for (const args of errors.mock.calls) expect(args.join(" ")).not.toContain("@");
    errors.mockRestore();
  });

  it("an invoice paid after approval is not emailed", async () => {
    await draft();
    const row = (await rowFor(INVOICES.L34.id))!;
    expect(await approveReminder(A.session, row.id, { db: app, clock, log: () => {} })).toMatchObject({ ok: true, channel: "logged" });
    await applyPayment(INVOICES.L34.id, 50_000);
    flags.collectionsEmailEnabled = true;
    flags.collectionsEmailFrom = "2026-11-02";
    flags.collectionsEmailAllowlist = [address];
    const sender = vi.fn<EmailSender>(async () => {});
    expect(await sendReminder(A.session, row.id, { db: app, clock, log: () => {}, send: sender })).toEqual({
      sent: false,
      category: "stale",
    });
    expect(sender).not.toHaveBeenCalled();
  });

  it("another carrier cannot read or approve the draft", async () => {
    await draft();
    const row = (await rowFor(INVOICES.L97.id))!;
    // B's own login sees no reminder and finds none to decide.
    const seenByB = await app.withTenant(B.tenantId, (q) =>
      q.query<{ n: string }>("SELECT CAST(count(*) AS text) AS n FROM collection_drafts"),
    );
    expect(seenByB[0].n).toBe("0");
    const viewB = await app.withTenant(B.tenantId, (q) => readCollectionsView(q, clock()));
    expect(viewB.cards).toEqual([]);
    expect(await approveReminder(B.session, row.id, { db: app, clock, log: () => {} })).toEqual({ ok: false, category: "not_found" });
    expect(await rejectReminder(B.session, row.id, { db: app, clock })).toEqual({ ok: false, category: "not_found" });
    // B's login pointed at A's carrier is not a member there.
    const forged: Session = { ...B.session, tenantId: A.tenantId };
    await expect(approveReminder(forged, row.id, { db: app, clock, log: () => {} })).rejects.toThrow();
    await expect(draft(goodModel, forged)).rejects.toThrow();
    expect((await rowFor(INVOICES.L97.id))!.status).toBe("drafted");
    // The app role cannot write a reminder for another carrier either.
    const state = await sqlStateOf(
      app.withTenant(B.tenantId, (q) =>
        q.execute(
          `INSERT INTO collection_drafts (id, tenant_id, invoice_id, customer_id, stage, tone, status, figures, trace_id)
           VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), '60', 'firm', 'drafting',
             CAST('{}' AS jsonb), CAST($5 AS uuid))`,
          [randomUUID(), A.tenantId, INVOICES.L62.id, A.customerId, randomUUID()],
        ),
      ),
    );
    expect(state).toBe("42501");
  });

  it("the table refuses a reminder inserted already decided, an edited text, a backward step and a send time out of turn", async () => {
    await draft();
    const row = (await rowFor(INVOICES.L97.id))!;
    const asApp = (sql: string, params: Param[] = []) =>
      sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute(sql, params)));
    const byId = "WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";
    expect(
      await asApp(
        `INSERT INTO collection_drafts (id, tenant_id, invoice_id, customer_id, stage, tone, status, figures, trace_id,
           subject, body, decided_by, decided_at, channel)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), '30', 'direct', 'approved',
           CAST('{}' AS jsonb), CAST($4 AS uuid), 'Invoice x', 'Pay', 'sub', now(), 'logged')`,
        [randomUUID(), INVOICES.L12.id, A.customerId, randomUUID()],
      ),
    ).toBe("23514");
    expect(await asApp(`UPDATE collection_drafts SET body = 'Pay now.' ${byId}`, [row.id])).toBe("23514");
    expect(await asApp(`UPDATE collection_drafts SET status = 'drafting' ${byId}`, [row.id])).toBe("23514");
    expect(await asApp(`UPDATE collection_drafts SET tone = 'friendly' ${byId}`, [row.id])).toBe("23514");
    expect(await asApp(`UPDATE collection_drafts SET sent_at = now() ${byId}`, [row.id])).toBe("23514");
    expect(await asApp(`UPDATE collection_drafts SET stage = '60' ${byId}`, [row.id])).toBe("42501");
    expect(await approveReminder(A.session, row.id, { db: app, clock, log: () => {} })).toMatchObject({ ok: true });
    // Approved: the channel moves only to email, and the text still never changes.
    expect(await asApp(`UPDATE collection_drafts SET channel = NULL ${byId}`, [row.id])).toBe("23514");
    expect(await asApp(`UPDATE collection_drafts SET subject = 'Other' ${byId}`, [row.id])).toBe("23514");
    expect(await asApp(`UPDATE collection_drafts SET sent_at = now() ${byId}`, [row.id])).toBe("23514");
    expect(await asApp(`UPDATE collection_drafts SET status = 'rejected' ${byId}`, [row.id])).toBe("23514");
  });

  it("flag off: drafting and deciding refuse before any read, and nothing is written", async () => {
    await draft();
    const row = (await rowFor(INVOICES.L97.id))!;
    flags.collectionsEnabled = false;
    const complete = vi.fn();
    expect(await draft(complete)).toEqual({ ok: false, category: "disabled" });
    expect(complete).not.toHaveBeenCalled();
    expect(await approveReminder(A.session, row.id, { db: app, clock, log: () => {} })).toEqual({ ok: false, category: "disabled" });
    expect(await rejectReminder(A.session, row.id, { db: app, clock })).toEqual({ ok: false, category: "disabled" });
    expect((await rowFor(INVOICES.L97.id))!.status).toBe("drafted");
    // The models switched off: drafting refuses too.
    flags.collectionsEnabled = true;
    flags.aiEnabled = false;
    expect(await draft(complete)).toEqual({ ok: false, category: "ai_disabled" });
  });

  it("charges every call to the collections purpose and the run's trace", async () => {
    const out = await draft();
    if (!out.ok) throw new Error("not drafted");
    const calls = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ purpose: string; trace_id: string }>(
        "SELECT purpose, CAST(trace_id AS text) AS trace_id FROM model_calls WHERE tenant_id = current_tenant_id()",
      ),
    );
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c).toEqual({ purpose: REMINDER_PURPOSE, trace_id: out.traceId });
  });
});
