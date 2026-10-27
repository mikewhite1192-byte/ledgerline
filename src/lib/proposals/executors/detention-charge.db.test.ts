import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../../config/flags";
import { chargeArgsOf, detentionChargeOf, readDetentionChargeRows } from "../../data/detention-charge";
import { ReadLimitError, readDeliveredBetween } from "../../data/read";
import { createPgDb } from "../../db/pg";
import { adminUrl, appUrl } from "../../db/test-urls";
import type { Db, Param, Queryable } from "../../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../../money/test-db";
import { context } from "../../agent/gateway/__tests__/fake-db";
import { readTurnView } from "../../agent/gateway/store/views";
import { findUnbilledDetentionTool } from "../../agent/gateway/tools/read/find-unbilled-detention";
import { EXECUTORS, executeProposal, type ProposalRow } from "../execute";
import { executeDetentionCharge } from "./detention-charge";

// A person's approval of a detention_charge against the real database, as the app's role: one
// approval adds one detention accessorial and raises the load's open invoice by exactly the
// engine's cents, in one transaction; the same approval again, or two at once, writes once; an
// invoice posted to accounting or paid is refused; anything that moved since the proposal (stop
// times, the invoice amount) is refused as stale; the switch off refuses before anything is
// written; another carrier reads and writes nothing. Finding the charge reads only the month's
// delivered loads and those loads' own rows. Only this file's two tenants are made, and they are
// removed after.

const saved = { ...flags, approverRole: { ...flags.approverRole }, gatewayLimits: { ...flags.gatewayLimits } };
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let loads = 0;

// The fixture customer keeps the default terms: 120 minutes free, $50.00 an hour per started
// quarter. Pickup 13:00 to 20:00 UTC is 7 h, 5 h over, 20 quarters: 25,000 cents. Delivery is 1 h.
const CHARGE_CENTS = 25_000;
const LINEHAUL = 150_000;
const FUEL = 20_000;
const BEFORE = LINEHAUL + FUEL;

type Load = { loadId: string; invoiceId: string };

async function addLoad(f: Fixture): Promise<Load> {
  loads += 1;
  const [loadId, invoiceId] = [randomUUID(), randomUUID()];
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
         origin_state, dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles,
         linehaul_cents, fuel_surcharge_cents, pickup_arrived_at, pickup_departed_at,
         delivery_arrived_at, delivery_departed_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid),
         'delivered', 'Springfield', 'IL', 'Dayton', 'OH', CAST('2026-10-05' AS date),
         CAST('2026-10-06' AS date), CAST('2026-10-06T16:00:00Z' AS timestamptz), 480, $5, $6,
         CAST('2026-10-05T13:00:00Z' AS timestamptz), CAST('2026-10-05T20:00:00Z' AS timestamptz),
         CAST('2026-10-06T15:00:00Z' AS timestamptz), CAST('2026-10-06T16:00:00Z' AS timestamptz))`,
      [loadId, `L-${loads}`, f.customerId, f.driverId, LINEHAUL, FUEL],
    );
    await q.execute(
      `INSERT INTO invoices (id, tenant_id, source, load_id, customer_id, invoice_number, amount_cents,
         issued_on, due_on, status)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'load', CAST($2 AS uuid), CAST($3 AS uuid), $4, $5,
         CAST('2026-10-06' AS date), CAST('2026-11-05' AS date), 'open')`,
      [invoiceId, loadId, f.customerId, `INV-${loads}`, BEFORE],
    );
  });
  return { loadId, invoiceId };
}

// A waiting detention_charge proposal for the load, its args the engine's figures read through the
// app role exactly as the propose tool reads them, with the conversation, turn and gateway
// decision a real one hangs from. Written by the admin login so created_at and the verdict can be
// set.
async function addProposal(f: Fixture, load: Load): Promise<{ id: string; turnId: string }> {
  const check = await app.withTenant(f.tenantId, async (q) => {
    const rows = await readDetentionChargeRows(q, load.loadId);
    return rows ? detentionChargeOf(rows) : null;
  });
  if (!check?.ok) throw new Error("the test load has no charge");
  const args = chargeArgsOf(check.charge);
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - HOUR).toISOString();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)`,
      [conversation, f.session.sub],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Find detention we never billed', 'done',
         $3, CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
      [turn, conversation, trace, created],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark',
         'propose_detention_charge', 'propose', 'allowed', 'ok', 1)`,
      [decision, turn, trace],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, sources, args, operator_verdict, gateway_decision_id, dedupe_key,
         trace_id, created_at, updated_at, auditor_verdict, auditor_agrees, auditor_concerns, auditor_checked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'detention_charge',
         'loads', CAST($4 AS uuid), $5, 'in', 'Bill unbilled detention', CAST($6 AS jsonb), CAST($7 AS jsonb),
         'not_given', CAST($8 AS uuid), $9, $10, CAST($11 AS timestamptz), CAST($11 AS timestamptz), 'pass',
         true, '[]', CAST($11 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        load.loadId,
        check.charge.amountCents,
        JSON.stringify(check.charge.sources),
        JSON.stringify(args),
        decision,
        `detention_charge:${load.loadId}:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
        trace,
        created,
      ],
    );
  });
  return { id, turnId: turn };
}

const approve = (f: Fixture, id: string) => executeProposal(f.session, id, { confirmed: false }, { db: app, clock, executors: EXECUTORS });

type State = {
  status: string;
  note: string | null;
  invoiceCents: number;
  accessorials: { kind: string; seq: number; amount_cents: number; description: string; proposal_id: string | null }[];
};

async function stateOf(f: Fixture, load: Load, proposalId: string): Promise<State> {
  return admin.withTenant(f.tenantId, async (q) => {
    const [p] = await q.query<{ status: string; decision_note: string | null }>(
      "SELECT status, decision_note FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [proposalId],
    );
    const [inv] = await q.query<{ amount_cents: number | string }>(
      "SELECT amount_cents FROM invoices WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [load.invoiceId],
    );
    const accessorials = await q.query<State["accessorials"][number]>(
      `SELECT kind, seq, amount_cents, description, CAST(proposal_id AS text) AS proposal_id FROM load_accessorials
        WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid) ORDER BY seq`,
      [load.loadId],
    );
    return {
      status: p.status,
      note: p.decision_note,
      invoiceCents: Number(inv.amount_cents),
      accessorials: accessorials.map((a) => ({ ...a, amount_cents: Number(a.amount_cents) })),
    };
  });
}

const untouched = (status: string, note: string | null = null): State => ({
  status,
  note,
  invoiceCents: BEFORE,
  accessorials: [],
});

describe("approving a detention charge", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `detention-a-${randomUUID().slice(0, 8)}`);
    B = await makeTenant(admin, `detention-b-${randomUUID().slice(0, 8)}`);
  });

  afterEach(() => {
    Object.assign(flags, saved, {
      approverRole: { ...saved.approverRole },
      gatewayLimits: { ...saved.gatewayLimits },
      detentionEnabled: true,
    });
    vi.restoreAllMocks();
  });

  beforeAll(() => {
    flags.detentionEnabled = true;
  });

  afterAll(async () => {
    Object.assign(flags, saved);
    await dropTenant(admin, A);
    await dropTenant(admin, B);
    await app?.close();
    await admin?.close();
  });

  it("adds one detention line and raises the open invoice by exactly the engine's cents, once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const load = await addLoad(A);
    const p = await addProposal(A, load);
    expect(await approve(A, p.id)).toEqual({ ok: true, proposalId: p.id, status: "done", moneyActionId: null });
    const after = await stateOf(A, load, p.id);
    expect(after).toEqual({
      status: "done",
      note: null,
      invoiceCents: BEFORE + CHARGE_CENTS,
      accessorials: [
        {
          kind: "detention",
          seq: 1,
          amount_cents: CHARGE_CENTS,
          description: "Detention at shipper, 5 h 0 min over free time",
          proposal_id: p.id,
        },
      ],
    });

    // The same approval again is already decided, and the executor run again finds it done.
    expect(await approve(A, p.id)).toMatchObject({ ok: false, category: "already_decided" });
    const row: ProposalRow = {
      id: p.id,
      conversationId: randomUUID(),
      turnId: p.turnId,
      kind: "detention_charge",
      subjectTable: "loads",
      subjectId: load.loadId,
      amountCents: CHARGE_CENTS,
      direction: "in",
      args: {},
      status: "approved",
      flaggedInputId: null,
      auditorVerdict: "pass",
      auditorAgrees: true,
      moneyActionId: null,
      traceId: "t",
    };
    expect(await executeDetentionCharge(app, A.session, row, { confirmed: false }, { clock })).toMatchObject({
      ok: true,
      status: "done",
    });
    expect(await stateOf(A, load, p.id)).toEqual(after);

    // The partial unique index holds one accessorial per proposal even for a direct write.
    const again = app.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, paid_by_driver, description, proposal_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'detention', 2, 100, false, 'x', CAST($3 AS uuid))`,
        [randomUUID(), load.loadId, p.id],
      ),
    );
    expect(await sqlStateOf(again)).toBe("23505");

    // The card reads its figures from the stored args.
    const view = await app.withTenant(A.tenantId, (q) => readTurnView(q, A.session.sub, p.turnId));
    const card = view?.proposals.find((x) => x.id === p.id);
    expect(card).toMatchObject({
      kind: "detention_charge",
      subjectLabel: `L-${loads}`,
      detention: {
        freeMinutes: 120,
        hourlyCents: 5_000,
        invoiceAmountBeforeCents: BEFORE,
        stops: [{ stop: "pickup", dwellMinutes: 420, overMinutes: 300, quarters: 20, cents: CHARGE_CENTS }],
      },
    });
  });

  it("writes once when two approvals of the same proposal land together", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const load = await addLoad(A);
    const p = await addProposal(A, load);
    const results = await Promise.all([approve(A, p.id), approve(A, p.id)]);
    expect(results.filter((r) => r.ok)).not.toHaveLength(0);
    for (const r of results) if (!r.ok) expect(r.category).toBe("already_decided");
    const after = await stateOf(A, load, p.id);
    expect(after.status).toBe("done");
    expect(after.invoiceCents).toBe(BEFORE + CHARGE_CENTS);
    expect(after.accessorials).toHaveLength(1);
  });

  it("keeps one live detention proposal per load", async () => {
    const load = await addLoad(A);
    await addProposal(A, load);
    expect(await sqlStateOf(addProposal(A, load))).toBe("23505");
  });

  it("refuses an invoice posted to accounting or no longer open, and writes nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const change of [
      // A posted invoice carries the accounting system's amount with its id (0028's qbo pair).
      `UPDATE invoices SET qbo_id = '1042', qbo_amount_cents = amount_cents
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      "UPDATE invoices SET status = 'partially_paid' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    ]) {
      const load = await addLoad(A);
      const p = await addProposal(A, load);
      await admin.withTenant(A.tenantId, (q) => q.execute(change, [load.invoiceId]));
      expect(await approve(A, p.id)).toEqual({ ok: false, category: "invoice_posted", retryable: false });
      expect(await stateOf(A, load, p.id)).toEqual(untouched("failed", "invoice_posted"));
    }
  });

  it("refuses as stale when the stop times or the invoice moved since the proposal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const moves = [
      `UPDATE loads SET pickup_departed_at = pickup_departed_at + interval '15 minutes'
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      `UPDATE loads SET pickup_arrived_at = pickup_arrived_at - interval '1 minute',
                        pickup_departed_at = pickup_departed_at - interval '1 minute'
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    ];
    for (const move of moves) {
      const load = await addLoad(A);
      const p = await addProposal(A, load);
      await admin.withTenant(A.tenantId, (q) => q.execute(move, [load.loadId]));
      expect(await approve(A, p.id)).toEqual({ ok: false, category: "stale", retryable: false });
      expect(await stateOf(A, load, p.id)).toEqual(untouched("failed", "stale"));
    }
    // The invoice amount changed by hand: the engine's total no longer matches it.
    const load = await addLoad(A);
    const p = await addProposal(A, load);
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE invoices SET amount_cents = amount_cents + 500 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [load.invoiceId],
      ),
    );
    expect(await approve(A, p.id)).toEqual({ ok: false, category: "stale", retryable: false });
    expect(await stateOf(A, load, p.id)).toEqual({ ...untouched("failed", "stale"), invoiceCents: BEFORE + 500 });
  });

  it("refuses while switched off, before the approval is recorded or anything is written", async () => {
    const load = await addLoad(A);
    const p = await addProposal(A, load);
    flags.detentionEnabled = false;
    expect(await approve(A, p.id)).toEqual({ ok: false, category: "not_executable", retryable: false });
    expect(await stateOf(A, load, p.id)).toEqual(untouched("proposed"));
    // Called directly, the executor refuses too.
    const row = { id: p.id, kind: "detention_charge", subjectId: load.loadId, status: "approved" } as ProposalRow;
    expect(await executeDetentionCharge(app, A.session, row, { confirmed: false }, { clock })).toMatchObject({
      ok: false,
      category: "not_executable",
    });
    expect(await stateOf(A, load, p.id)).toEqual(untouched("proposed"));
  });

  it("lets another carrier read and write nothing of this carrier's charge", async () => {
    const load = await addLoad(A);
    const p = await addProposal(A, load);
    // B's approval of A's proposal: not found, nothing changed.
    expect(await approve(B, p.id)).toMatchObject({ ok: false, category: "not_found" });
    // B's executor run on A's proposal row: not found under B's tenant.
    const row = { id: p.id, kind: "detention_charge", subjectId: load.loadId, status: "approved" } as ProposalRow;
    expect(await executeDetentionCharge(app, B.session, row, { confirmed: false }, { clock })).toMatchObject({
      ok: false,
      category: "not_found",
    });
    // B cannot read A's load through the shared reader.
    expect(await app.withTenant(B.tenantId, (q) => readDetentionChargeRows(q, load.loadId))).toBeNull();
    expect(await stateOf(A, load, p.id)).toEqual(untouched("proposed"));
  });

  it("finds detention by reading only the month's delivered loads and those loads' own rows", async () => {
    const october = await addLoad(A);
    const september = await addLoad(A);
    const [septemberCustomer, septemberMiles, septemberLumper, octoberMiles] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    // Move the second load, with its own customer, miles and a lumper line, to the last day of
    // September; the first stays delivered on October 6.
    await admin.withTenant(A.tenantId, async (q) => {
      await q.execute(
        `INSERT INTO customers (id, tenant_id, code, name, terms_days, city, state)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'CUST-SEPT', 'September Shipper', 30, 'Dayton', 'OH')`,
        [septemberCustomer],
      );
      await q.execute(
        `UPDATE loads SET customer_id = CAST($2 AS uuid), pickup_on = CAST('2026-09-29' AS date),
           delivered_on = CAST('2026-09-30' AS date),
           delivered_at = CAST('2026-09-30T16:00:00Z' AS timestamptz),
           pickup_arrived_at = CAST('2026-09-29T13:00:00Z' AS timestamptz),
           pickup_departed_at = CAST('2026-09-29T20:00:00Z' AS timestamptz),
           delivery_arrived_at = CAST('2026-09-30T15:00:00Z' AS timestamptz),
           delivery_departed_at = CAST('2026-09-30T16:00:00Z' AS timestamptz)
         WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [september.loadId, septemberCustomer],
      );
      await q.execute(
        `UPDATE invoices SET customer_id = CAST($2 AS uuid), issued_on = CAST('2026-09-30' AS date),
           due_on = CAST('2026-10-30' AS date)
         WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [september.invoiceId, septemberCustomer],
      );
      await q.execute(
        `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'OH', 480),
                (CAST($3 AS uuid), current_tenant_id(), CAST($4 AS uuid), 'OH', 480)`,
        [octoberMiles, october.loadId, septemberMiles, september.loadId],
      );
      await q.execute(
        `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, description)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'lumper', 1, 7500, 'Lumper at delivery')`,
        [septemberLumper, september.loadId],
      );
    });

    // Every statement the reader and the tool send, through the app role.
    const sent: string[] = [];
    const out = await app.withTenant(A.tenantId, async (q) => {
      const recorder: Queryable = {
        query: <T>(sql: string, params?: Param[]) => {
          sent.push(sql);
          return q.query<T>(sql, params);
        },
        execute: (sql: string, params?: Param[]) => {
          sent.push(sql);
          return q.execute(sql, params);
        },
      };
      const octoberRows = await readDeliveredBetween(recorder, { start: "2026-10-01", end: "2026-10-31" });
      const septemberRows = await readDeliveredBetween(recorder, { start: "2026-09-01", end: "2026-09-30" });
      const ctx = { ...context({ now: new Date(NOW), timeZone: "America/Chicago" }), session: A.session };
      const found = await findUnbilledDetentionTool.run(recorder, ctx, { month: "2026-10" }, { screen: null, limit: null });
      return { octoberRows, septemberRows, found: found.result as { rows: { loadId: string }[] } };
    });

    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const loadIds = (rows: { load_id: string | null }[]) => rows.map((r) => r.load_id);
    // October: the October load and its rows; nothing of the September load or its customer.
    const oct = out.octoberRows;
    expect(ids(oct.loads)).toContain(october.loadId);
    expect(ids(oct.loads)).not.toContain(september.loadId);
    expect(ids(oct.customers)).toEqual([A.customerId]);
    expect(ids(oct.load_state_miles)).toContain(octoberMiles);
    expect(ids(oct.load_state_miles)).not.toContain(septemberMiles);
    expect(ids(oct.load_accessorials)).not.toContain(septemberLumper);
    expect(ids(oct.invoices)).toContain(october.invoiceId);
    expect(ids(oct.invoices)).not.toContain(september.invoiceId);
    for (const r of [...oct.load_state_miles, ...oct.load_accessorials, ...oct.invoices]) {
      expect(ids(oct.loads)).toContain(r.load_id);
    }
    // September: the same filter finds the September load and only its rows.
    const sep = out.septemberRows;
    expect(ids(sep.loads)).toEqual([september.loadId]);
    expect(ids(sep.customers)).toEqual([septemberCustomer]);
    expect(ids(sep.load_state_miles)).toEqual([septemberMiles]);
    expect(ids(sep.load_accessorials)).toEqual([septemberLumper]);
    expect(ids(sep.invoices)).toEqual([september.invoiceId]);
    expect(new Set([...loadIds(sep.load_state_miles), ...loadIds(sep.invoices)])).toEqual(new Set([september.loadId]));
    // The tool finds the October load's detention and not the September load's.
    const foundIds = out.found.rows.map((r) => r.loadId);
    expect(foundIds).toContain(october.loadId);
    expect(foundIds).not.toContain(september.loadId);
    // Two reads of five tables, then the tool's five: every one filtered by the delivered date.
    expect(sent).toHaveLength(15);
    for (const sql of sent) expect(sql).toContain("delivered_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)");
  });

  it("reads a month in pages: every row once, in key order, and never part of a month", async () => {
    // Five loads with their invoices, moved to August so the month holds only this test's rows,
    // and four state-mile rows (an exact multiple of the page of two).
    const august = [await addLoad(B), await addLoad(B), await addLoad(B), await addLoad(B), await addLoad(B)];
    const miles = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await admin.withTenant(B.tenantId, async (q) => {
      for (const load of august) {
        await q.execute(
          `UPDATE loads SET pickup_on = CAST('2026-08-13' AS date), delivered_on = CAST('2026-08-14' AS date),
             delivered_at = CAST('2026-08-14T16:00:00Z' AS timestamptz),
             pickup_arrived_at = CAST('2026-08-13T13:00:00Z' AS timestamptz),
             pickup_departed_at = CAST('2026-08-13T20:00:00Z' AS timestamptz),
             delivery_arrived_at = CAST('2026-08-14T15:00:00Z' AS timestamptz),
             delivery_departed_at = CAST('2026-08-14T16:00:00Z' AS timestamptz)
           WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [load.loadId],
        );
      }
      for (const [i, id] of miles.entries()) {
        await q.execute(
          `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'OH', 120)`,
          [id, august[i].loadId],
        );
      }
    });

    const month = { start: "2026-08-01", end: "2026-08-31" };
    const sent: string[] = [];
    const out = await app.withTenant(B.tenantId, async (q) => {
      const recorder: Queryable = {
        query: <T>(sql: string, params?: Param[]) => {
          sent.push(sql);
          return q.query<T>(sql, params);
        },
        execute: () => Promise.reject(new Error("the reader never writes")),
      };
      const paged = await readDeliveredBetween(recorder, month, { pageSize: 2, maxPages: 3 });
      const pages = sent.length;
      const whole = await readDeliveredBetween(q, month);
      const bounded = await readDeliveredBetween(q, month, { pageSize: 2, maxPages: 2 }).then(
        () => "returned",
        (err: unknown) => (err instanceof ReadLimitError ? err.category : "other error"),
      );
      return { paged, pages, whole, bounded };
    });

    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const sorted = (values: string[]) => [...values].sort();
    // Every row, once, in key order, and the same rows a single page reads.
    expect(ids(out.paged.loads)).toEqual(sorted(august.map((l) => l.loadId)));
    expect(ids(out.paged.invoices)).toEqual(sorted(august.map((l) => l.invoiceId)));
    expect(ids(out.paged.load_state_miles)).toEqual(sorted(miles));
    expect(ids(out.paged.customers)).toEqual([B.customerId]);
    expect(out.paged.load_accessorials).toEqual([]);
    expect(out.paged).toEqual(out.whole);
    // Loads and invoices take three pages (2, 2, 1), miles three (2, 2, then an empty page), the
    // customer and the empty accessorials one each.
    expect(out.pages).toBe(11);
    // Five loads need three pages of two: a bound of two throws instead of returning four.
    expect(out.bounded).toBe("too_many_rows");
  });
});
