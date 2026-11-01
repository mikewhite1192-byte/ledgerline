import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter } from "../adapters/payment/mock";
import type { AccountingAdapter } from "../adapters/types";
import type { Session } from "../auth/claims";
import { explainPaystub } from "../agent/gateway/tools/read/explain-paystub";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { addJudge, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { EXECUTORS, executeProposal, type ExecutorRegistry } from "../proposals/execute";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { cents } from "../rules-engine";
import { ForbiddenError } from "../tenant/context";
import { settlementApproveExecutor } from "./approve";
import { findContradictions, readSourceFacts } from "./contradiction";
import { linesHash } from "./hash";
import type { SettlementMoneyDeps } from "./legs";
import { addNamedLine } from "./named-line";
import { runPayPeriod } from "./run";
import { readStoredLines } from "./stored";
import { POST } from "../../app/api/settlements/[id]/lines/route";

// The route reads its session and database from here: no one is signed in unless a case sets one,
// and the staff check runs on the app's role.
const holder = vi.hoisted(() => ({ db: undefined as unknown, session: null as unknown }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getSession: async () => holder.session,
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => holder.db,
}));

// Named stub lines (0084) against a real database seeded with a demo carrier under its own slug,
// as the app's role. A staff member names one reimbursement on a driver's open draft that cites a
// lumper the driver paid; the engine makes the line, and the pre-pay recheck parks a stub whose
// typed line no longer matches its record, or whose insurance days were raised without day rows.
// The payout rail reports not connected, so an approval that passes the recheck reserves and sends
// nothing. The clock is fixed. Both tenants made here are removed after, ledger rows first.

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const clock = () => new Date(NOW);
const saved = structuredClone(flags);

const CARRIER = {
  ...DEMO_CARRIERS[0],
  slug: "named-lines-test",
  name: "Named Lines Test Carrier",
} as unknown as DemoCarrier;
const T = randomUUID();
const PLAN = buildCarrierPlan(CARRIER, golden.anchor);
const STAFF: Session = { sub: `named-lines-admin-${T}`, email: "", tenantId: T };

let admin: Db;
let app: Db;
let other: Fixture | undefined;
let judge: Session;
let staffId: string;

const rows = <R extends object>(sql: string, params: Param[] = []) =>
  admin.withTenant(T, (q) => q.query<R>(sql, params));
const write = (sql: string, params: Param[] = []) => admin.withTenant(T, (q) => q.execute(sql, params));
const countOf = async (sql: string, params: Param[] = []) => Number((await rows<{ n: string }>(sql, params))[0].n);

const OPEN = (() => {
  const p = PLAN.rows.settlement_periods.find((x) => x.status === "open");
  if (!p) throw new Error("no open period");
  return p;
})();

// The planted lumper: paid by the driver on a load delivered in the open week, with no pay item
// citing it.
const LUMPER = (() => {
  const cited = new Set(PLAN.rows.pay_items.map((i) => i.ref_id));
  for (const a of PLAN.rows.load_accessorials) {
    if (!a.paid_by_driver || a.kind !== "lumper" || cited.has(a.id)) continue;
    const load = PLAN.rows.loads.find((l) => l.id === a.load_id);
    if (!load?.driver_id || !load.delivered_on) continue;
    if (load.delivered_on < OPEN.period_start || load.delivered_on > OPEN.period_end) continue;
    return { id: a.id, cents: Number(a.amount_cents), driverId: load.driver_id };
  }
  throw new Error("no uncited lumper in the open week");
})();
const LUMPER_REF = `load_accessorials:${LUMPER.id}`;

// A fuel purchase of the same driver that a fuel pay item already cites.
const CITED_FUEL = (() => {
  const item = PLAN.rows.pay_items.find(
    (i) => i.ref_table === "fuel_purchases" && i.driver_id === LUMPER.driverId && i.ref_id,
  );
  if (!item?.ref_id) throw new Error("no cited fuel purchase");
  const purchase = PLAN.rows.fuel_purchases.find((f) => f.id === item.ref_id);
  if (!purchase) throw new Error("the cited purchase is missing");
  return { id: purchase.id, cents: Number(purchase.amount_cents), paidWith: purchase.paid_with };
})();

type Stub = { id: string; status: string; gross_cents: string; net_cents: string; parked_reason: string | null };
const stubOf = async (driverId: string): Promise<Stub> => {
  const [s] = await rows<Stub>(
    `SELECT CAST(id AS text) AS id, status, CAST(gross_cents AS text) AS gross_cents, CAST(net_cents AS text) AS net_cents,
            parked_reason FROM settlements
      WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)`,
    [OPEN.id, driverId],
  );
  if (!s) throw new Error("no draft for that driver");
  return s;
};

const stubById = async (id: string): Promise<Stub> => {
  const [s] = await rows<Stub>(
    `SELECT CAST(id AS text) AS id, status, CAST(gross_cents AS text) AS gross_cents, CAST(net_cents AS text) AS net_cents,
            parked_reason FROM settlements
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [id],
  );
  if (!s) throw new Error("no such stub");
  return s;
};

type Card = { id: string; status: string; decision_note: string | null; lines_hash: string };
const cardsOf = (settlementId: string) =>
  rows<Card>(
    `SELECT CAST(id AS text) AS id, status, decision_note, args->>'linesHash' AS lines_hash FROM proposals
      WHERE tenant_id = current_tenant_id() AND kind = 'settlement_approve' AND subject_id = CAST($1 AS uuid)`,
    [settlementId],
  );
const openCard = async (settlementId: string): Promise<Card> => {
  const live = (await cardsOf(settlementId)).filter((c) => c.status === "proposed");
  if (live.length !== 1) throw new Error(`${live.length} waiting cards`);
  return live[0];
};
const cardById = async (id: string): Promise<Card | undefined> =>
  (
    await rows<Card>(
      `SELECT CAST(id AS text) AS id, status, decision_note, args->>'linesHash' AS lines_hash FROM proposals
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    )
  )[0];

const namedItems = () =>
  rows<{ id: string; amount_cents: string; entered_by: string | null; settlement_id: string | null }>(
    `SELECT CAST(id AS text) AS id, CAST(amount_cents AS text) AS amount_cents,
            CAST(entered_by AS text) AS entered_by, CAST(settlement_id AS text) AS settlement_id
       FROM pay_items WHERE tenant_id = current_tenant_id() AND item_ref LIKE 'named:%' ORDER BY item_ref`,
  );
const ledgerCount = (settlementId: string) =>
  countOf("SELECT count(*) AS n FROM money_actions WHERE tenant_id = current_tenant_id() AND subject_id = CAST($1 AS uuid)", [
    settlementId,
  ]);

// The payout rail is not connected: an approval that passes the recheck ends failed before anything
// is reserved, and the stub stays approved.
const payment = createMockPaymentAdapter({ log: () => {} });
const unused = async (): Promise<never> => {
  throw new Error("not used here");
};
const books: AccountingAdapter = {
  system: "qbo_sandbox",
  ready: async () => ({ ok: false, category: "not_connected" }),
  ensureCustomer: unused,
  ensureVendor: unused,
  createInvoice: unused,
  createBill: unused,
  payBill: unused,
  createExpense: unused,
  recordCustomerPayment: unused,
  readBack: async () => ({ found: false }),
};
const money: SettlementMoneyDeps = {
  payment: { ...payment, ready: async () => ({ ok: false, category: "not_connected" }) },
  accounting: books,
  waitMs: 2_000,
  pollMs: 10,
  log: () => {},
  nowMs: () => 0,
};
const executors: ExecutorRegistry = { ...EXECUTORS, settlement_approve: settlementApproveExecutor(money) };

async function approve(cardId: string): Promise<void> {
  flags.payoutsEnabled = true;
  flags.accountingEnabled = true;
  try {
    await executeProposal(STAFF, cardId, { confirmed: true }, { db: app, clock, executors });
  } finally {
    flags.payoutsEnabled = false;
    flags.accountingEnabled = false;
  }
}

const run = async () => {
  const r = await runPayPeriod(app, STAFF, OPEN.id, clock());
  if (!r.ok) throw new Error(`the pay run refused: ${r.category}`);
};
const name = (body: unknown, settlementId: string, session: Session = STAFF) =>
  addNamedLine(app, session, settlementId, body, clock());
const lumperBody = (amountCents = LUMPER.cents) => ({ kind: "reimbursement", sourceRef: LUMPER_REF, amountCents });

// A fuel purchase of the lumper's driver that no pay item cites, paid as given.
async function plantFuel(paidWith: "company_card" | "driver_own", amountCents: number): Promise<string> {
  const id = randomUUID();
  await write(
    `INSERT INTO fuel_purchases (id, tenant_id, driver_id, purchased_at, purchased_on, state, gallons_milli,
       amount_cents, paid_with, purchase_ref)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS timestamptz), CAST($4 AS date),
       'IL', 100000, $5, $6, $7)`,
    [id, LUMPER.driverId, `${OPEN.period_end}T15:00:00Z`, OPEN.period_end, amountCents, paidWith, `NL-DIR-${id}`],
  );
  return id;
}

// Another draft with an insurance line and pay to send, of a driver none of the other cases touches.
async function insuredStub(skip: readonly string[]): Promise<{ stub: Stub; seq: number }> {
  const found = await rows<{ settlement_id: string; driver_id: string; seq: number }>(
    `SELECT CAST(s.id AS text) AS settlement_id, CAST(s.driver_id AS text) AS driver_id, l.seq
       FROM settlements s JOIN settlement_lines l ON l.tenant_id = s.tenant_id AND l.settlement_id = s.id
      WHERE s.tenant_id = current_tenant_id() AND s.period_id = CAST($1 AS uuid) AND s.status = 'draft'
        AND s.parked_reason IS NULL AND s.net_cents > 0 AND l.kind = 'insurance'
      ORDER BY s.id`,
    [OPEN.id],
  );
  const pick = found.find((f) => f.driver_id !== LUMPER.driverId && !skip.includes(f.settlement_id));
  if (!pick) throw new Error("no other draft with insurance");
  return { stub: await stubById(pick.settlement_id), seq: pick.seq };
}

// Raises the insurance line's days by one, amount and sources unchanged: the fingerprint and the
// reconcile pairing read neither, so only the contradiction check can see it.
const raiseDays = (settlementId: string, seq: number) =>
  write(
    `UPDATE settlement_lines SET meta = jsonb_set(meta, '{days}', to_jsonb((meta->>'days')::int + 1))
      WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid) AND seq = $2`,
    [settlementId, seq],
  );

const post = (settlementId: string, body: unknown) =>
  POST(
    new Request(`http://localhost/api/settlements/${settlementId}/lines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: settlementId }) },
  );

describe("named stub lines against a seeded database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    holder.db = app;
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug = $1", [CARRIER.slug]),
    );
    if (leftover.length > 0) throw new Error("a named-lines-test tenant already exists: use a fresh database");
    staffId = await admin.withTenant(T, async (q) => {
      await q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
        CARRIER.slug,
        CARRIER.name,
        CARRIER.timezone,
      ]);
      const [m] = await q.query<{ id: string }>(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), $1, $2, 'admin') RETURNING CAST(id AS text) AS id`,
        [STAFF.sub, `admin@${CARRIER.slug}.example`],
      );
      return m.id;
    });
    await replaceTenantData(app, T, PLAN);
    judge = await addJudge(admin, { tenantId: T } as Fixture);
    other = await makeTenant(admin, "named-lines-other");
    flags.settlementsEnabled = true;
    flags.namedLines.enabled = true;
    flags.payoutsEnabled = false;
    flags.accountingEnabled = false;
    flags.auditorEnabled = false;
    flags.auditorRequired = false;
    await run();
  }, 120_000);

  afterAll(async () => {
    Object.assign(flags, saved);
    await admin?.withTenant(T, (q) => q.execute("DELETE FROM money_actions WHERE tenant_id = current_tenant_id()"));
    await admin?.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    if (other) {
      await admin?.withTenant(other.tenantId, (q) =>
        q.execute("DELETE FROM money_actions WHERE tenant_id = current_tenant_id()"),
      );
    }
    await dropTenant(admin, other);
    await app?.close();
    await admin?.close();
  });

  it("0084 validated its five constraints against the rows already there, and an unnamed line still inserts", async () => {
    const checks = await admin.withoutTenant((q) =>
      q.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
          WHERE conname IN ('pay_items_entered_by_fk', 'pay_items_named_has_ref', 'settlement_lines_entered_by_fk',
                            'settlement_lines_source_ref_form', 'settlement_lines_named_pair')
          ORDER BY conname`,
      ),
    );
    expect(checks).toEqual([
      { conname: "pay_items_entered_by_fk", convalidated: true },
      { conname: "pay_items_named_has_ref", convalidated: true },
      { conname: "settlement_lines_entered_by_fk", convalidated: true },
      { conname: "settlement_lines_named_pair", convalidated: true },
      { conname: "settlement_lines_source_ref_form", convalidated: true },
    ]);
    // Every line the seed and the pay run wrote names no person.
    expect(await countOf("SELECT count(*) AS n FROM settlement_lines WHERE tenant_id = current_tenant_id() AND entered_by IS NOT NULL")).toBe(0);

    const { stub } = await insuredStub([]);
    const insert = (lineId: string, enteredBy: string | null, sourceRef: string | null) =>
      write(
        `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources,
           entered_by, source_ref)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 900, 'other_deduction', 'probe', -1,
           CAST('[]' AS jsonb), CAST($3 AS uuid), $4)`,
        [lineId, stub.id, enteredBy, sourceRef],
      );
    const plain = randomUUID();
    try {
      expect(await insert(plain, null, null)).toBe(1);
    } finally {
      await write("DELETE FROM settlement_lines WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [plain]);
    }
    expect(await sqlStateOf(insert(randomUUID(), null, LUMPER_REF))).toBe("23514");
    expect(await sqlStateOf(insert(randomUUID(), staffId, null))).toBe("23514");
    expect(await sqlStateOf(insert(randomUUID(), staffId, `loads:${LUMPER.id}`))).toBe("23514");
    // A typed pay item must name a record of the two tables.
    expect(
      await sqlStateOf(
        write(
          `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date, item_ref,
             description, entered_by)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'reimbursement', 'named', 100,
             CAST($3 AS date), $4, 'probe', CAST($5 AS uuid))`,
          [randomUUID(), LUMPER.driverId, OPEN.period_end, `probe:${randomUUID()}`, staffId],
        ),
      ),
    ).toBe("23514");
  });

  it("refuses a judge and a signed-out caller, writing nothing", async () => {
    const s = await stubOf(LUMPER.driverId);
    await expect(name(lumperBody(), s.id, judge)).rejects.toBeInstanceOf(ForbiddenError);
    const res = await post(s.id, lumperBody());
    expect(res.status).toBe(401);
    expect(await namedItems()).toEqual([]);
  });

  it("refuses at entry an amount that differs from the record, and writes nothing", async () => {
    const s = await stubOf(LUMPER.driverId);
    const card = await openCard(s.id);
    expect(await name(lumperBody(LUMPER.cents + 1), s.id)).toEqual({
      ok: false,
      category: "contradicting_line",
      retryable: false,
    });
    expect(await namedItems()).toEqual([]);
    expect((await openCard(s.id)).id).toBe(card.id);
  });

  it("refuses another carrier's fuel purchase as source_missing and writes nothing", async () => {
    if (!other) throw new Error("no second carrier");
    const theirs = randomUUID();
    await admin.withTenant(other.tenantId, (q) =>
      q.execute(
        `INSERT INTO fuel_purchases (id, tenant_id, driver_id, purchased_at, purchased_on, state, gallons_milli,
           amount_cents, paid_with, purchase_ref)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST('2026-10-28T15:00:00Z' AS timestamptz),
           CAST('2026-10-28' AS date), 'IL', 100000, 40000, 'driver_own', 'NL-OTHER-1')`,
        [theirs, other?.driverId ?? null],
      ),
    );
    const s = await stubOf(LUMPER.driverId);
    const body = { kind: "reimbursement", sourceRef: `fuel_purchases:${theirs}`, amountCents: 40_000 };
    expect(await name(body, s.id)).toMatchObject({ ok: false, category: "source_missing" });
    expect(await namedItems()).toEqual([]);
  });

  it("refuses a record another pay item already cites", async () => {
    const s = await stubOf(LUMPER.driverId);
    // Named the way its money ran, so the cite is what refuses it.
    const kind = CITED_FUEL.paidWith === "driver_own" ? "reimbursement" : "other_deduction";
    const body = { kind, sourceRef: `fuel_purchases:${CITED_FUEL.id}`, amountCents: CITED_FUEL.cents };
    expect(await name(body, s.id)).toMatchObject({ ok: false, category: "already_cited" });
    expect(await namedItems()).toEqual([]);
  });

  it("refuses a line that runs against the way its record's money ran as source_missing, and writes nothing", async () => {
    const s = await stubOf(LUMPER.driverId);
    const card = await openCard(s.id);
    const company = await plantFuel("company_card", 41_000);
    const own = await plantFuel("driver_own", 42_000);
    // Company fuel is never paid back to the driver, and fuel the driver paid is never taken again.
    const companyBack = { kind: "reimbursement", sourceRef: `fuel_purchases:${company}`, amountCents: 41_000 };
    expect(await name(companyBack, s.id)).toMatchObject({ ok: false, category: "source_missing" });
    const ownTaken = { kind: "other_deduction", sourceRef: `fuel_purchases:${own}`, amountCents: 42_000 };
    expect(await name(ownTaken, s.id)).toMatchObject({ ok: false, category: "source_missing" });
    // A lumper the driver paid is a reimbursement only.
    const lumperTaken = { kind: "other_deduction", sourceRef: LUMPER_REF, amountCents: LUMPER.cents };
    expect(await name(lumperTaken, s.id)).toMatchObject({ ok: false, category: "source_missing" });
    expect(await namedItems()).toEqual([]);
    expect((await openCard(s.id)).id).toBe(card.id);
  });

  it("refuses at entry a record of another driver of the same carrier as source_missing", async () => {
    const { stub } = await insuredStub([]);
    expect(await name(lumperBody(), stub.id)).toMatchObject({ ok: false, category: "source_missing" });
    expect(await namedItems()).toEqual([]);
  });

  it("reads another driver's record as missing in the recheck, so the line is a contradiction", async () => {
    const { stub } = await insuredStub([]);
    const [theirs] = await rows<{ driver_id: string }>(
      "SELECT CAST(driver_id AS text) AS driver_id FROM settlements WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [stub.id],
    );
    const line = {
      kind: "reimbursement" as const,
      amountCents: cents(LUMPER.cents, "lumper"),
      sources: [],
      enteredBy: staffId,
      sourceRef: LUMPER_REF,
    };
    const facts = await app.withTenant(T, (q) => readSourceFacts(q, [line], theirs.driver_id));
    expect(facts.amounts.has(LUMPER_REF)).toBe(false);
    expect(findContradictions([line], facts, stub.id)).toEqual([
      { category: "contradicting_line", source: { table: "load_accessorials", id: LUMPER.id } },
    ]);
    // The driver who paid it reads it, and the same line passes.
    const own = await app.withTenant(T, (q) => readSourceFacts(q, [line], LUMPER.driverId));
    expect(own.amounts.get(LUMPER_REF)).toBe(LUMPER.cents);
    expect(findContradictions([line], own, stub.id)).toEqual([]);
  });

  it("reports not_rerun when the run's cap leaves the stub's driver out, and the stub takes no line", async () => {
    const s = await stubOf(LUMPER.driverId);
    const card = await openCard(s.id);
    flags.settlementLimits.driversPerRun = 0;
    try {
      expect(await name(lumperBody(), s.id)).toEqual({ ok: false, category: "not_rerun", retryable: false });
    } finally {
      flags.settlementLimits.driversPerRun = saved.settlementLimits.driversPerRun;
    }
    // The item stays for the next run to adopt (the next case's run does); the stub and card are as they were.
    expect(await namedItems()).toEqual([
      { id: expect.any(String), amount_cents: String(LUMPER.cents), entered_by: staffId, settlement_id: null },
    ]);
    const lines = await app.withTenant(T, (q) => readStoredLines(q, s.id));
    expect(lines.filter((l) => l.enteredBy)).toEqual([]);
    expect(await stubOf(LUMPER.driverId)).toEqual(s);
    expect((await openCard(s.id)).id).toBe(card.id);
  }, 60_000);

  it("adds a named reimbursement for a lumper the driver paid: one item, one named line, the gross up, a new card", async () => {
    const before = await stubOf(LUMPER.driverId);
    const oldCard = await openCard(before.id);
    const added = await name({ ...lumperBody(), label: "Lumper at the receiver" }, before.id);
    expect(added).toMatchObject({ ok: true, settlementId: before.id });

    const items = await namedItems();
    expect(items).toEqual([
      { id: expect.any(String), amount_cents: String(LUMPER.cents), entered_by: staffId, settlement_id: null },
    ]);
    const after = await stubOf(LUMPER.driverId);
    expect(after.id).toBe(before.id);
    // Earnings: the gross goes up by the record's amount (this driver's week nets to zero either way).
    expect(Number(after.gross_cents) - Number(before.gross_cents)).toBe(LUMPER.cents);
    const lines = await app.withTenant(T, (q) => readStoredLines(q, after.id));
    const typed = lines.filter((l) => l.enteredBy);
    expect(typed).toEqual([
      expect.objectContaining({
        kind: "reimbursement",
        amountCents: LUMPER.cents,
        sources: [{ table: "pay_items", id: items[0].id }],
        enteredBy: staffId,
        sourceRef: LUMPER_REF,
      }),
    ]);
    const fresh = await openCard(after.id);
    expect(fresh.id).not.toBe(oldCard.id);
    expect(fresh.lines_hash).toBe(linesHash(lines));
    expect((await cardById(oldCard.id))?.status).toBe("expired");

    // The agent sees that a person typed it and the record it cites, never who.
    const told = await app.withTenant(T, (q) =>
      explainPaystub.run(q, {} as never, { driverId: LUMPER.driverId, periodId: OPEN.id }, {} as never),
    );
    const seen = told.result as { contradictions: unknown[]; rows: Record<string, unknown>[] };
    expect(seen.contradictions).toEqual([]);
    const shown = seen.rows.filter((r) => r.namedByPerson === true);
    expect(shown).toEqual([expect.objectContaining({ sourceRef: LUMPER_REF })]);
    expect(JSON.stringify(told.result)).not.toContain(staffId);
  }, 60_000);

  it("writes one item and one line for the same request twice", async () => {
    const s = await stubOf(LUMPER.driverId);
    const card = await openCard(s.id);
    expect(await name(lumperBody(), s.id)).toMatchObject({ ok: true });
    expect(await namedItems()).toHaveLength(1);
    const lines = await app.withTenant(T, (q) => readStoredLines(q, s.id));
    expect(lines.filter((l) => l.enteredBy)).toHaveLength(1);
    // Nothing changed, so the rerun keeps the same card.
    expect((await openCard(s.id)).id).toBe(card.id);
  }, 60_000);

  it("reports not_rerun for a new amount the capped run left off, while the stub still shows the old line", async () => {
    const s = await stubOf(LUMPER.driverId);
    const card = await openCard(s.id);
    const bump = (by: number) =>
      write(
        "UPDATE load_accessorials SET amount_cents = amount_cents + $2 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [LUMPER.id, by],
      );
    expect(await bump(50)).toBe(1);
    flags.settlementLimits.driversPerRun = 0;
    try {
      expect(await name(lumperBody(LUMPER.cents + 50), s.id)).toEqual({
        ok: false,
        category: "not_rerun",
        retryable: false,
      });
    } finally {
      flags.settlementLimits.driversPerRun = saved.settlementLimits.driversPerRun;
    }
    // The item took the new amount; the old line for the same record does not count as redone.
    expect((await namedItems()).map((i) => i.amount_cents)).toEqual([String(LUMPER.cents + 50)]);
    const lines = await app.withTenant(T, (q) => readStoredLines(q, s.id));
    expect(lines.filter((l) => l.enteredBy).map((l) => l.amountCents)).toEqual([LUMPER.cents]);
    expect(await stubOf(LUMPER.driverId)).toEqual(s);
    expect((await openCard(s.id)).id).toBe(card.id);

    // Put the record and the item back as the next case expects them.
    expect(await bump(-50)).toBe(1);
    expect(await name(lumperBody(), s.id)).toMatchObject({ ok: true });
    expect((await namedItems()).map((i) => i.amount_cents)).toEqual([String(LUMPER.cents)]);
  }, 60_000);

  it("parks the stub when the record changed after entry, then retyping the amount and running the week clears it", async () => {
    const s = await stubOf(LUMPER.driverId);
    const card = await openCard(s.id);
    const moved = await write(
      "UPDATE load_accessorials SET amount_cents = amount_cents + 100 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [LUMPER.id],
    );
    expect(moved).toBe(1);
    // With the switch off too: a rollback stops new lines, never the check on a typed line there.
    flags.namedLines.enabled = false;
    try {
      await approve(card.id);
    } finally {
      flags.namedLines.enabled = true;
    }
    expect((await stubOf(LUMPER.driverId)).parked_reason).toBe("contradicting_line");
    expect(await cardById(card.id)).toMatchObject({ status: "failed", decision_note: "contradicting_line" });
    expect(await ledgerCount(s.id)).toBe(0);
    // The agent reads the same verdict the approval found.
    const told = await app.withTenant(T, (q) =>
      explainPaystub.run(q, {} as never, { driverId: LUMPER.driverId, periodId: OPEN.id }, {} as never),
    );
    expect((told.result as { contradictions: unknown[] }).contradictions).toEqual([
      { category: "contradicting_line", source: { table: "load_accessorials", id: LUMPER.id } },
    ]);

    // A parked draft takes no new line; running the week clears the park, then the new amount goes in.
    expect(await name(lumperBody(LUMPER.cents + 100), s.id)).toMatchObject({ ok: false, category: "parked" });
    await run();
    expect((await stubOf(LUMPER.driverId)).parked_reason).toBeNull();
    expect(await name(lumperBody(LUMPER.cents + 100), s.id)).toMatchObject({ ok: true });
    expect((await namedItems()).map((i) => i.amount_cents)).toEqual([String(LUMPER.cents + 100)]);
    const fixed = await openCard(s.id);
    await approve(fixed.id);
    // The recheck passes. This driver's week nets to zero, so it books as paid with no payout.
    expect(await stubOf(LUMPER.driverId)).toMatchObject({ status: "paid", net_cents: "0", parked_reason: null });
    expect(await cardById(fixed.id)).toMatchObject({ status: "done", decision_note: "no_payout" });
    expect(await ledgerCount(s.id)).toBe(0);
  }, 60_000);

  it("parks an insurance line whose days were raised without day rows, with nothing sent", async () => {
    const { stub, seq } = await insuredStub([]);
    const card = await openCard(stub.id);
    await raiseDays(stub.id, seq);
    await approve(card.id);
    expect((await stubById(stub.id)).parked_reason).toBe("contradicting_line");
    expect(await cardById(card.id)).toMatchObject({ status: "failed", decision_note: "contradicting_line" });
    expect(await ledgerCount(stub.id)).toBe(0);
  }, 60_000);

  it("with the switch off, the route is 404, the service writes nothing and a raised insurance line is not checked", async () => {
    const parked = await rows<{ id: string }>(
      "SELECT CAST(id AS text) AS id FROM settlements WHERE tenant_id = current_tenant_id() AND parked_reason IS NOT NULL",
    );
    const { stub, seq } = await insuredStub(parked.map((p) => p.id));
    const card = await openCard(stub.id);
    await raiseDays(stub.id, seq);
    flags.namedLines.enabled = false;
    try {
      // A signed-out caller is refused before the switch is asked, so the answer says nothing of it.
      const signedOut = await post(stub.id, lumperBody());
      expect(signedOut.status).toBe(401);
      holder.session = STAFF;
      const res = await post(stub.id, lumperBody());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "disabled" });
      expect(await name(lumperBody(), stub.id)).toMatchObject({ ok: false, category: "disabled" });
      // The agent is told the check did not run, not that it found nothing.
      const told = await app.withTenant(T, (q) =>
        explainPaystub.run(q, {} as never, { driverId: LUMPER.driverId, periodId: OPEN.id }, {} as never),
      );
      expect((told.result as { contradictions: unknown }).contradictions).toBeNull();
      await approve(card.id);
    } finally {
      holder.session = null;
      flags.namedLines.enabled = true;
    }
    expect(await stubById(stub.id)).toMatchObject({ status: "approved", parked_reason: null });
    expect(await cardById(card.id)).toMatchObject({ status: "failed", decision_note: "not_connected" });
    expect(await ledgerCount(stub.id)).toBe(0);
  }, 60_000);
});
