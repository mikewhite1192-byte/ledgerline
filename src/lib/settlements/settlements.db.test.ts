import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter } from "../adapters/payment/mock";
import type { AccountingAdapter, SendOutcome } from "../adapters/types";
import type { Session } from "../auth/claims";
import { readSettlementInput } from "../data/read";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { sqlStateOf } from "../money/test-db";
import { EXECUTORS, executeProposal, type ExecutorRegistry } from "../proposals/execute";
import { cents, settleDriver } from "../rules-engine";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan, type CarrierPlan } from "../seed/plan";
import { resetDemoTenant } from "../seed/reset";
import { replaceTenantData } from "../seed/run";
import { settlementApproveExecutor } from "./approve";
import { confirmBatch, type BatchRequest } from "./batch";
import { readCleanSet } from "./clean";
import { drainBatch } from "./drain";
import { LEG_NOT_SENT, legFailureLabel } from "./labels";
import type { SettlementMoneyDeps } from "./legs";
import { nameOf, readPaystubAsk, readSettlementRows } from "./list";
import { paidWritesOf } from "./paid";
import { retryPayout } from "./post";
import { runPayPeriod } from "./run";
import { readStoredLines, readStoredSettlement } from "./stored";
import { readSettlementRecord } from "./views";

// The weekly pay run, the pre-pay recheck and its parking, the single approve and the batch
// approve with its drain, against a real database seeded with both demo carriers, as the app's
// role. The payout rail is the in-process mock and the accounting system a test double; nothing
// here calls a model, a processor, QuickBooks or the network. The clock is fixed. Two tenant rows
// carry the demo slugs; the fresh test database has no others with those slugs, and both are
// removed after (their ledger rows first, by the admin login).

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const clock = () => new Date(NOW);
const saved = {
  ...flags,
  settlementLimits: { ...flags.settlementLimits },
  batchLimits: { ...flags.batchLimits },
  approverRole: { ...flags.approverRole },
};

type Carrier = { carrier: DemoCarrier; id: string; plan: CarrierPlan; session: Session };

const tenants: Carrier[] = DEMO_CARRIERS.map((carrier) => {
  const id = randomUUID();
  return {
    carrier,
    id,
    plan: buildCarrierPlan(carrier, golden.anchor),
    session: { sub: `settlements-admin-${carrier.slug}`, email: "", tenantId: id },
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
const countOf = async (t: Carrier, sql: string, params: Param[] = []) =>
  Number((await adminRows<{ n: string }>(t, sql, params))[0].n);

function driverOf(t: Carrier, code: string): string {
  const d = t.plan.rows.drivers.find((x) => x.code === code);
  if (!d) throw new Error(`no driver ${code}`);
  return d.id;
}
function openPeriodOf(t: Carrier) {
  const p = t.plan.rows.settlement_periods.find((x) => x.status === "open");
  if (!p) throw new Error("no open period");
  return p;
}

type SettlementRow = {
  id: string;
  code: string;
  driver_id: string;
  status: string;
  gross_cents: string;
  deductions_cents: string;
  net_cents: string;
  carry_forward_cents: string;
  parked_reason: string | null;
  escrow_opening_cents: string;
  escrow_charges_cents: string;
  escrow_withheld_cents: string;
  escrow_closing_cents: string;
};

const SETTLEMENT_SQL = `SELECT s.id, d.code, s.driver_id, s.status, s.gross_cents::text, s.deductions_cents::text,
        s.net_cents::text, s.carry_forward_cents::text, s.parked_reason, s.escrow_opening_cents::text,
        s.escrow_charges_cents::text, s.escrow_withheld_cents::text, s.escrow_closing_cents::text
   FROM settlements s JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
  WHERE s.tenant_id = $1 AND s.period_id = CAST($2 AS uuid)`;

const draftsOf = (t: Carrier) =>
  adminRows<SettlementRow>(t, `${SETTLEMENT_SQL} ORDER BY d.code`, [t.id, openPeriodOf(t).id]);

async function settlementOf(t: Carrier, code: string): Promise<SettlementRow> {
  const [row] = await adminRows<SettlementRow>(t, `${SETTLEMENT_SQL} AND s.driver_id = CAST($3 AS uuid)`, [
    t.id,
    openPeriodOf(t).id,
    driverOf(t, code),
  ]);
  if (!row) throw new Error(`no settlement for ${code}`);
  return row;
}

type CardRow = {
  id: string;
  subject_id: string;
  status: string;
  decision_note: string | null;
  batch_id: string | null;
  exceptions: string;
  flagged_input_id: string | null;
};

const cardsOf = (t: Carrier, settlementId: string) =>
  adminRows<CardRow>(
    t,
    `SELECT id, subject_id, status, decision_note, CAST(batch_id AS text) AS batch_id,
            CAST(exceptions AS text) AS exceptions, CAST(flagged_input_id AS text) AS flagged_input_id
       FROM proposals
      WHERE tenant_id = $1 AND kind = 'settlement_approve' AND subject_id = CAST($2 AS uuid)`,
    [t.id, settlementId],
  );

async function cardById(t: Carrier, id: string): Promise<CardRow> {
  const [row] = await adminRows<CardRow>(
    t,
    `SELECT id, subject_id, status, decision_note, CAST(batch_id AS text) AS batch_id,
            CAST(exceptions AS text) AS exceptions, CAST(flagged_input_id AS text) AS flagged_input_id
       FROM proposals WHERE tenant_id = $1 AND id = CAST($2 AS uuid)`,
    [t.id, id],
  );
  if (!row) throw new Error("no such card");
  return row;
}

// The one waiting card of a driver's draft.
async function openCard(t: Carrier, code: string): Promise<CardRow> {
  const s = await settlementOf(t, code);
  const live = (await cardsOf(t, s.id)).filter((c) => c.status === "proposed");
  if (live.length !== 1) throw new Error(`${code} has ${live.length} waiting cards`);
  return live[0];
}

type LedgerRow = { id: string; kind: string; state: string; attempt: number; batch_id: string | null };

const ledgerOf = (t: Carrier, settlementId: string) =>
  adminRows<LedgerRow>(
    t,
    `SELECT id, kind, state, attempt, CAST(batch_id AS text) AS batch_id FROM money_actions
      WHERE tenant_id = $1 AND subject_id = CAST($2 AS uuid) ORDER BY kind, attempt`,
    [t.id, settlementId],
  );
const ledgerCount = (t: Carrier) => countOf(t, "SELECT count(*) AS n FROM money_actions WHERE tenant_id = $1", [t.id]);
const batchCount = (t: Carrier) =>
  countOf(t, "SELECT count(*) AS n FROM approval_batches WHERE tenant_id = $1", [t.id]);

// The auditor's pass on every waiting card with nothing against it. No model is called.
const passAudit = (t: Carrier) =>
  adminWrite(
    t,
    `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true,
            auditor_checked_at = CAST($2 AS timestamptz)
      WHERE tenant_id = $1 AND kind = 'settlement_approve' AND status = 'proposed'
        AND jsonb_array_length(exceptions) = 0 AND flagged_input_id IS NULL AND auditor_verdict IS NULL`,
    [t.id, new Date(NOW).toISOString()],
  );

const run = (t: Carrier) => runPayPeriod(app, t.session, openPeriodOf(t).id, clock());
const cleanOf = (t: Carrier) => app.withTenant(t.id, (q) => readCleanSet(q, openPeriodOf(t).id));

// A raise on the first load a driver's paystub cites: an owner-operator's pay moves with it.
async function raiseLoad(t: Carrier, code: string, by = 10_000): Promise<void> {
  const s = await settlementOf(t, code);
  const lines = await app.withTenant(t.id, (q) => readStoredLines(q, s.id));
  const load = lines.flatMap((l) => l.sources).find((x) => x.table === "loads");
  if (!load) throw new Error(`${code} cites no load`);
  const moved = await adminWrite(
    t,
    "UPDATE loads SET linehaul_cents = linehaul_cents + $2 WHERE tenant_id = $1 AND id = CAST($3 AS uuid)",
    [t.id, by, load.id],
  );
  if (moved !== 1) throw new Error("the load did not move");
}

// An accounting system double: it confirms every bill and bill payment. Nothing else is used.
function testBooks() {
  const seen = { vendors: 0, bills: 0, payments: 0 };
  const unused = async (): Promise<never> => {
    throw new Error("not used by settlements");
  };
  const adapter: AccountingAdapter = {
    system: "qbo_sandbox",
    ready: async () => ({ ok: true }),
    ensureCustomer: unused,
    ensureVendor: async (_q, d) => {
      seen.vendors += 1;
      return { outsideId: `V-${d.code}` };
    },
    createInvoice: unused,
    createBill: async (_q, bill): Promise<SendOutcome> => {
      seen.bills += 1;
      return {
        kind: "confirmed",
        system: "qbo_sandbox",
        type: "Bill",
        id: `QB-${seen.bills}`,
        amountCents: bill.lines.reduce((s, l) => s + l.amountCents, 0),
      };
    },
    payBill: async (_q, p): Promise<SendOutcome> => {
      seen.payments += 1;
      return { kind: "confirmed", system: "qbo_sandbox", type: "BillPayment", id: `QBP-${seen.payments}`, amountCents: p.amountCents };
    },
    createExpense: unused,
    recordCustomerPayment: unused,
    readBack: async () => ({ found: false }),
  };
  return { adapter, seen };
}

const moneyLog: string[] = [];
const payment = createMockPaymentAdapter({ log: () => {} });
const books = testBooks();
// The request clock stands still, so every approve has its whole budget for the bill legs.
const money: SettlementMoneyDeps = {
  payment,
  accounting: books.adapter,
  waitMs: 2_000,
  pollMs: 10,
  log: (l) => moneyLog.push(l),
  nowMs: () => 0,
};
const executors: ExecutorRegistry = { ...EXECUTORS, settlement_approve: settlementApproveExecutor(money) };

// The person's approval with the second confirm (the auditor is off here and not required).
const approve = (t: Carrier, id: string, db: Db = app) =>
  executeProposal(t.session, id, { confirmed: true }, { db, clock, executors });

async function withSwitches<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  flags.payoutsEnabled = on;
  flags.accountingEnabled = on;
  try {
    return await fn();
  } finally {
    flags.payoutsEnabled = false;
    flags.accountingEnabled = false;
  }
}

// The clean items for these drivers, as a confirm request.
async function requestFor(t: Carrier, codes: string[]): Promise<BatchRequest> {
  const clean = await cleanOf(t);
  const items = clean.items.filter((i) => codes.includes(i.driverCode));
  if (items.length !== codes.length) throw new Error(`not all clean: ${codes.join(", ")}`);
  return {
    periodId: openPeriodOf(t).id,
    proposalIds: items.map((i) => i.proposalId),
    totalCents: items.reduce((s, i) => s + i.netCents, 0),
  };
}

describe("settlements against a seeded database", () => {
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
    flags.settlementsEnabled = true;
    flags.batchApproveEnabled = true;
    flags.payoutsEnabled = false;
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

  it("starts with every driver paying for their own insurance off, and escrow never below zero", async () => {
    for (const t of tenants) {
      expect(await countOf(t, "SELECT count(*) AS n FROM drivers WHERE tenant_id = $1 AND own_insurance", [t.id])).toBe(0);
    }
    // The engine refuses a negative escrow balance, so the schema does too (no row changes).
    const [driver] = await adminRows<{ id: string }>(
      BR,
      "SELECT id FROM drivers WHERE tenant_id = $1 ORDER BY id LIMIT 1",
      [BR.id],
    );
    expect(
      await sqlStateOf(
        adminWrite(BR, "UPDATE drivers SET escrow_balance_cents = -1 WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
          BR.id,
          driver.id,
        ]),
      ),
    ).toBe("23514");
  });

  it("runs the open week for both carriers: every draft is the engine's own result, and nothing is clean before the auditor", async () => {
    for (const t of tenants) {
      const r = await run(t);
      expect(r.ok, t.carrier.slug).toBe(true);
      const drafts = await draftsOf(t);
      expect(drafts.length, t.carrier.slug).toBeGreaterThan(10);
      if (r.ok) expect(r.counts.drafts).toBe(drafts.length);
      for (const d of drafts) {
        expect(d.status).toBe("draft");
        const { stored, lines, engine } = await app.withTenant(t.id, async (q) => ({
          stored: await readStoredSettlement(q, d.id, false),
          lines: await readStoredLines(q, d.id),
          engine: settleDriver(await readSettlementInput(q, d.driver_id, openPeriodOf(t).id)),
        }));
        expect(stored, d.code).not.toBeNull();
        expect(
          [stored?.grossCents, stored?.deductionsCents, stored?.netCents, stored?.carryForwardCents],
          d.code,
        ).toEqual([engine.grossCents, engine.deductionsCents, engine.netCents, engine.carryForwardCents]);
        expect(
          lines.map((l) => [l.kind, l.label, l.amountCents, l.sources]),
          d.code,
        ).toEqual(engine.lines.map((l) => [l.kind, l.label, l.amountCents, l.sources]));
        // Exactly one waiting card per draft.
        expect((await cardsOf(t, d.id)).filter((c) => c.status === "proposed"), d.code).toHaveLength(1);
      }
      expect((await cleanOf(t)).items, t.carrier.slug).toEqual([]);
    }

    // The hero paystub is the golden one.
    const hero = golden.carriers["blue-ridge"].hero;
    const heroRow = await settlementOf(BR, hero.code);
    expect([heroRow.gross_cents, heroRow.deductions_cents, heroRow.net_cents].map(Number)).toEqual([
      hero.grossCents,
      hero.deductionsCents,
      hero.netCents,
    ]);
    const heroLines = await app.withTenant(BR.id, (q) => readStoredLines(q, heroRow.id));
    expect(heroLines.map((l) => [l.seq, l.kind, l.label, l.amountCents])).toEqual(
      hero.lines.map((l) => [l.seq, l.kind, l.label, l.amountCents]),
    );

    // The planted load with no rate belongs to a per-mile company driver: the engine pays the miles,
    // and the card carries the finding.
    const victim = await openCard(BR, BR.plan.victims.noRate);
    expect(JSON.parse(victim.exceptions)).toContain("rate_missing");

    // The auditor's pass makes exactly the drafts with nothing against them and money to send clean.
    for (const t of tenants) {
      await passAudit(t);
      const expected: string[] = [];
      for (const d of await draftsOf(t)) {
        const card = await openCard(t, d.code);
        if (JSON.parse(card.exceptions).length === 0 && card.flagged_input_id === null && Number(d.net_cents) > 0) {
          expected.push(d.id);
        }
      }
      const clean = await cleanOf(t);
      expect(expected.length, t.carrier.slug).toBeGreaterThan(5);
      expect(clean.items.map((i) => i.settlementId).sort(), t.carrier.slug).toEqual(expected.sort());
      expect(clean.totalCents).toBe(clean.items.reduce((s, i) => s + i.netCents, 0));
    }
  }, 120_000);

  it("keeps the same drafts and cards on a rerun, and replaces the card of a draft that changed", async () => {
    const before = new Map<string, [string, string]>();
    for (const d of await draftsOf(BR)) before.set(d.code, [d.id, (await openCard(BR, d.code)).id]);
    expect((await run(BR)).ok).toBe(true);
    for (const d of await draftsOf(BR)) {
      expect([d.id, (await openCard(BR, d.code)).id], d.code).toEqual(before.get(d.code));
    }

    const old = await openCard(BR, "BR-D11");
    await raiseLoad(BR, "BR-D11");
    expect((await run(BR)).ok).toBe(true);
    const fresh = await openCard(BR, "BR-D11");
    expect(fresh.id).not.toBe(old.id);
    expect((await cardById(BR, old.id)).status).toBe("expired");
    expect((await settlementOf(BR, "BR-D11")).id).toBe(before.get("BR-D11")?.[0]);
  }, 60_000);

  it("parks a paystub whose load changed after the card, before anything is paid, and a rerun clears the park", async () => {
    const card = await openCard(BR, "BR-D11");
    const s = await settlementOf(BR, "BR-D11");
    await raiseLoad(BR, "BR-D11");
    await withSwitches(true, () => approve(BR, card.id));
    expect((await settlementOf(BR, "BR-D11")).parked_reason).toBe("line_amount_changed");
    expect(await cardById(BR, card.id)).toMatchObject({ status: "failed", decision_note: "parked" });
    expect(await ledgerOf(BR, s.id)).toEqual([]);
    expect((await cleanOf(BR)).items.some((i) => i.settlementId === s.id)).toBe(false);

    expect((await run(BR)).ok).toBe(true);
    expect((await settlementOf(BR, "BR-D11")).parked_reason).toBeNull();
    const fresh = await openCard(BR, "BR-D11");
    expect(fresh.id).not.toBe(card.id);
    expect((await cardById(BR, card.id)).status).toBe("failed");
  }, 60_000);

  it("pays a paystub once when two approvals race, with its bill, its advance recovery and its escrow", async () => {
    const s = await settlementOf(BR, "BR-D14");
    const card = await openCard(BR, "BR-D14");
    const period = openPeriodOf(BR);
    const lines = await app.withTenant(BR.id, (q) => readStoredLines(q, s.id));
    const [driver] = await adminRows<{ escrow_balance_cents: string }>(
      BR,
      "SELECT escrow_balance_cents::text FROM drivers WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
      [BR.id, s.driver_id],
    );
    const expected = paidWritesOf({
      settlementId: s.id,
      lines,
      carryForwardCents: cents(Number(s.carry_forward_cents), "carry"),
      openingCents: Number(driver.escrow_balance_cents),
      periodEnd: period.period_end,
    });
    expect(expected.recoveries.length).toBeGreaterThan(0);
    const recoveredOf = async () =>
      adminRows<{ id: string; recovered_cents: string }>(
        BR,
        "SELECT id, recovered_cents::text FROM advances WHERE tenant_id = $1 AND id = ANY(CAST($2 AS uuid[])) ORDER BY id",
        [BR.id, `{${expected.recoveries.map((r) => r.advanceId).join(",")}}`],
      );
    const recoveredBefore = new Map((await recoveredOf()).map((r) => [r.id, Number(r.recovered_cents)]));
    const createdBefore = payment.createdCount;
    const billsBefore = books.seen.bills;

    await withSwitches(true, () => Promise.all([approve(BR, card.id, app), approve(BR, card.id, app2)]));

    const ledger = await ledgerOf(BR, s.id);
    expect(ledger.map((r) => [r.kind, r.state, r.attempt])).toEqual([
      ["settlement_bill", "confirmed", 1],
      ["settlement_bill_payment", "confirmed", 1],
      ["settlement_payout", "confirmed", 1],
    ]);
    expect(payment.createdCount - createdBefore).toBe(1);
    expect(books.seen.bills - billsBefore).toBe(1);
    const after = await settlementOf(BR, "BR-D14");
    expect(after.status).toBe("paid");
    expect(await cardById(BR, card.id)).toMatchObject({ status: "done", decision_note: null });
    for (const r of await recoveredOf()) {
      const taken = expected.recoveries.filter((x) => x.advanceId === r.id).reduce((n, x) => n + x.cents, 0);
      expect(Number(r.recovered_cents) - (recoveredBefore.get(r.id) ?? 0)).toBe(taken);
    }
    expect(
      await countOf(BR, "SELECT count(*) AS n FROM pay_items WHERE tenant_id = $1 AND ref_table = 'settlements' AND ref_id = CAST($2 AS uuid)", [
        BR.id,
        s.id,
      ]),
    ).toBe(0);
    if (expected.stampItemIds.length > 0) {
      expect(
        await countOf(
          BR,
          "SELECT count(*) AS n FROM pay_items WHERE tenant_id = $1 AND id = ANY(CAST($2 AS uuid[])) AND settlement_id = CAST($3 AS uuid)",
          [BR.id, `{${expected.stampItemIds.join(",")}}`, s.id],
        ),
      ).toBe(expected.stampItemIds.length);
    }
    expect(
      [after.escrow_opening_cents, after.escrow_charges_cents, after.escrow_withheld_cents, after.escrow_closing_cents].map(Number),
    ).toEqual([
      expected.escrow.openingCents,
      expected.escrow.chargesCents,
      expected.escrow.withheldCents,
      expected.escrow.closingCents,
    ]);
    const [balance] = await adminRows<{ escrow_balance_cents: string }>(
      BR,
      "SELECT escrow_balance_cents::text FROM drivers WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
      [BR.id, s.driver_id],
    );
    expect(Number(balance.escrow_balance_cents)).toBe(expected.escrow.closingCents);
  }, 60_000);

  it("parks a paystub that cites a pay item another settlement already paid", async () => {
    const s = await settlementOf(BR, "BR-D01");
    const card = await openCard(BR, "BR-D01");
    const lines = await app.withTenant(BR.id, (q) => readStoredLines(q, s.id));
    const item = lines.flatMap((l) => l.sources).find((x) => x.table === "pay_items");
    if (!item) throw new Error("BR-D01 cites no pay item");
    const [paid] = await adminRows<{ id: string }>(
      BR,
      "SELECT id FROM settlements WHERE tenant_id = $1 AND status = 'paid' AND id <> CAST($2 AS uuid) ORDER BY id LIMIT 1",
      [BR.id, s.id],
    );
    const stamp = (to: string | null) =>
      adminWrite(BR, "UPDATE pay_items SET settlement_id = CAST($3 AS uuid) WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
        BR.id,
        item.id,
        to,
      ]);
    expect(await stamp(paid.id)).toBe(1);
    try {
      await withSwitches(true, () => approve(BR, card.id));
      expect((await settlementOf(BR, "BR-D01")).parked_reason).toBe("source_settled_elsewhere");
      expect(await cardById(BR, card.id)).toMatchObject({ status: "failed", decision_note: "parked" });
      expect(await ledgerOf(BR, s.id)).toEqual([]);
      // The other carrier sees neither the parked paystub nor its card.
      const seen = await app.withTenant(PW.id, async (q) => [
        ...(await q.query<{ id: string }>("SELECT id FROM settlements WHERE id = CAST($1 AS uuid)", [s.id])),
        ...(await q.query<{ id: string }>("SELECT id FROM proposals WHERE id = CAST($1 AS uuid)", [card.id])),
      ]);
      expect(seen).toEqual([]);
    } finally {
      expect(await stamp(null)).toBe(1);
    }
  }, 60_000);

  it("books a net-zero week as paid with no payout, carrying the shortfall once", async () => {
    const s = await settlementOf(BR, "BR-D04");
    expect(Number(s.net_cents)).toBe(0);
    const carry = Number(s.carry_forward_cents);
    expect(carry).toBeGreaterThan(0);
    const card = await openCard(BR, "BR-D04");
    await withSwitches(true, () => Promise.all([approve(BR, card.id, app), approve(BR, card.id, app2)]));
    expect(await ledgerOf(BR, s.id)).toEqual([]);
    expect((await settlementOf(BR, "BR-D04")).status).toBe("paid");
    const carried = await adminRows<{ amount_cents: string; kind: string }>(
      BR,
      "SELECT amount_cents::text, kind FROM pay_items WHERE tenant_id = $1 AND ref_table = 'settlements' AND ref_id = CAST($2 AS uuid)",
      [BR.id, s.id],
    );
    expect(carried.map((c) => [c.kind, Number(c.amount_cents)])).toEqual([["carried_shortfall", carry]]);
    expect(await cardById(BR, card.id)).toMatchObject({ status: "done", decision_note: "no_payout" });
  }, 60_000);

  it("ends a single approve failed when the payout rail is not connected, and the payout can be retried", async () => {
    const s = await settlementOf(BR, "BR-D08");
    expect(Number(s.net_cents)).toBeGreaterThan(0);
    const card = await openCard(BR, "BR-D08");
    const unplugged: SettlementMoneyDeps = {
      ...money,
      payment: { ...payment, ready: async () => ({ ok: false, category: "not_connected" }) },
    };
    const notConnected: ExecutorRegistry = { ...EXECUTORS, settlement_approve: settlementApproveExecutor(unplugged) };
    const createdBefore = payment.createdCount;
    await withSwitches(true, () => executeProposal(BR.session, card.id, { confirmed: true }, { db: app, clock, executors: notConnected }));

    // Refused before anything was reserved: the driver was not paid, so the card failed, and the
    // paystub stays approved for "Retry payout".
    expect(await cardById(BR, card.id)).toMatchObject({ status: "failed", decision_note: "not_connected" });
    expect((await settlementOf(BR, "BR-D08")).status).toBe("approved");
    expect(await ledgerOf(BR, s.id)).toEqual([]);
    expect(payment.createdCount).toBe(createdBefore);
    // The list and the record page read the same card.
    const listed = await app.withTenant(BR.id, (q) => readSettlementRows(q, openPeriodOf(BR).id));
    expect(listed.rows.find((r) => r.id === s.id)).toMatchObject({ status: "approved", proposalId: card.id, proposalStatus: "failed" });
    const record = await app.withTenant(BR.id, (q) => readSettlementRecord(q, s.id));
    expect(record?.proposal).toMatchObject({ id: card.id, status: "failed", note: "not_connected" });
    expect(record?.latest.settlement_payout).toBeNull();

    const retried = await withSwitches(true, () => retryPayout(app, BR.session, s.id, money, clock));
    expect(retried).toMatchObject({ ok: true, state: "confirmed" });
    expect(payment.createdCount - createdBefore).toBe(1);
    expect((await settlementOf(BR, "BR-D08")).status).toBe("paid");
    expect((await ledgerOf(BR, s.id)).map((r) => [r.kind, r.state, r.attempt])).toEqual([["settlement_payout", "confirmed", 1]]);
    // The card ended failed before the retry paid the driver, and 0014 keeps an ended card's
    // status, so it stays failed but no longer says the rail was not connected.
    expect(await cardById(BR, card.id)).toMatchObject({ status: "failed", decision_note: null });
    const after = await app.withTenant(BR.id, (q) => readSettlementRecord(q, s.id));
    expect(after?.proposal).toMatchObject({ id: card.id, status: "failed", note: null });
  }, 60_000);

  it("leaves insurance off the paystub of a driver who carries their own", async () => {
    const before = await settlementOf(PW, "PW-D17");
    const beforeLines = await app.withTenant(PW.id, (q) => readStoredLines(q, before.id));
    const insurance = beforeLines.filter((l) => l.kind === "insurance");
    expect(insurance.map((l) => l.amountCents)).toEqual([-1800]);
    await adminWrite(PW, "UPDATE drivers SET own_insurance = true WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
      PW.id,
      before.driver_id,
    ]);
    expect((await run(PW)).ok).toBe(true);
    const after = await settlementOf(PW, "PW-D17");
    const afterLines = await app.withTenant(PW.id, (q) => readStoredLines(q, after.id));
    expect(afterLines.some((l) => l.kind === "insurance")).toBe(false);
    expect(Number(after.deductions_cents)).toBe(Number(before.deductions_cents) - 1800);
    expect(Number(after.net_cents)).toBe(Number(before.net_cents) + 1800);
    await passAudit(PW);
  }, 60_000);

  it("refuses a batch whose paystub changed, parks that one, and writes nothing", async () => {
    const req = await requestFor(BR, ["BR-D02", "BR-D03", "BR-D05"]);
    const ledgerBefore = await ledgerCount(BR);
    const card = await openCard(BR, "BR-D02");
    await raiseLoad(BR, "BR-D02");
    const out = await withSwitches(true, () => confirmBatch(app, BR.session, req, clock(), money));
    expect(out).toMatchObject({ ok: false, category: "stale" });
    expect((await settlementOf(BR, "BR-D02")).parked_reason).toBe("line_amount_changed");
    expect(await cardById(BR, card.id)).toMatchObject({ status: "expired", decision_note: "parked" });
    expect(await batchCount(BR)).toBe(0);
    expect(await ledgerCount(BR)).toBe(ledgerBefore);
    if (!out.ok && out.category === "stale") {
      expect(out.current.items.some((i) => i.driverCode === "BR-D02")).toBe(false);
    }
    expect((await run(BR)).ok).toBe(true);
    await passAudit(BR);
    expect((await settlementOf(BR, "BR-D02")).parked_reason).toBeNull();
  }, 60_000);

  let brBatch = "";

  it("approves exactly the confirmed list, reserves every leg on the batch, and drains it", async () => {
    const req = await requestFor(BR, ["BR-D03", "BR-D05", "BR-D10"]);
    const ledgerBefore = await ledgerCount(BR);
    await withSwitches(true, async () => {
      // A total that does not add up, or an id not on the clean list: refused, nothing written.
      expect(await confirmBatch(app, BR.session, { ...req, totalCents: req.totalCents + 1 }, clock(), money)).toMatchObject({
        ok: false,
        category: "stale",
      });
      const swapped = { ...req, proposalIds: [...req.proposalIds.slice(1), randomUUID()] };
      expect(await confirmBatch(app, BR.session, swapped, clock(), money)).toMatchObject({ ok: false, category: "stale" });
      expect(await batchCount(BR)).toBe(0);
      expect(await ledgerCount(BR)).toBe(ledgerBefore);

      const out = await confirmBatch(app, BR.session, req, clock(), money);
      expect(out).toMatchObject({ ok: true, itemCount: 3, totalCents: req.totalCents, legsReserved: 9, status: "confirmed" });
      if (!out.ok) return;
      brBatch = out.batchId;
      expect(await batchCount(BR)).toBe(1);
      for (const id of req.proposalIds) {
        expect(await cardById(BR, id)).toMatchObject({ status: "executing", batch_id: out.batchId });
      }
      const rows = await adminRows<LedgerRow>(
        BR,
        `SELECT id, kind, state, attempt, CAST(batch_id AS text) AS batch_id FROM money_actions
          WHERE tenant_id = $1 AND batch_id = CAST($2 AS uuid)`,
        [BR.id, out.batchId],
      );
      expect(rows).toHaveLength(9);
      expect(rows.every((r) => r.state === "reserved" && r.attempt === 1)).toBe(true);

      // The batch a ledger row was reserved under never changes.
      expect(
        await sqlStateOf(
          adminWrite(BR, "UPDATE money_actions SET batch_id = NULL WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
            BR.id,
            rows[0].id,
          ]),
        ),
      ).toBe("23514");

      // The same list again: those cards are no longer waiting.
      expect(await confirmBatch(app, BR.session, req, clock(), money)).toMatchObject({ ok: false, category: "stale" });
      expect(await batchCount(BR)).toBe(1);

      const drained = await drainBatch(app, BR.session, out.batchId, 100_000, { ...money, nowMs: () => 0, clock });
      expect(drained).toMatchObject({ ok: true, status: "done", confirmed: 9, failed: 0, unknown: 0, remaining: 0 });
    });
    for (const code of ["BR-D03", "BR-D05", "BR-D10"]) {
      expect((await settlementOf(BR, code)).status, code).toBe("paid");
    }
    for (const id of req.proposalIds) expect((await cardById(BR, id)).status).toBe("done");
    const [batch] = await adminRows<{ status: string; finished_at: string | null }>(
      BR,
      "SELECT status, CAST(finished_at AS text) AS finished_at FROM approval_batches WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
      [BR.id, brBatch],
    );
    expect(batch.status).toBe("done");
    expect(batch.finished_at).not.toBeNull();
  }, 60_000);

  it("approves a batch with the switches off as not paid: nothing reserved, each leg logged as held", async () => {
    const req = await requestFor(BR, ["BR-D12", "BR-D13"]);
    const ledgerBefore = await ledgerCount(BR);
    const logBefore = moneyLog.length;
    const out = await confirmBatch(app, BR.session, req, clock(), money);
    expect(out).toMatchObject({ ok: true, status: "done", legsReserved: 0 });
    expect(await ledgerCount(BR)).toBe(ledgerBefore);
    const held = moneyLog.slice(logBefore).filter((l) => l.startsWith("money: would send settlement_"));
    expect(held).toHaveLength(6);
    expect(held.every((l) => l.includes("(payoutsEnabled off)"))).toBe(true);
    for (const id of req.proposalIds) {
      expect(await cardById(BR, id)).toMatchObject({ status: "done", decision_note: "not_paid" });
    }
  }, 60_000);

  it("lets only one of two racing confirms of the same list through", async () => {
    const req = await requestFor(PW, ["PW-D02", "PW-D04"]);
    const results = await Promise.all([
      confirmBatch(app, PW.session, req, clock(), money),
      confirmBatch(app2, PW.session, req, clock(), money),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.category === "stale")).toHaveLength(1);
    expect(await batchCount(PW)).toBe(1);
  }, 60_000);

  let pwBatch = "";

  it("drains a batch across calls: out of time, then a failed payout refuses its bill legs, then nothing new", async () => {
    const req = await requestFor(PW, ["PW-D07", "PW-D09", "PW-D10"]);
    const d09 = await settlementOf(PW, "PW-D09");
    await withSwitches(true, async () => {
      const out = await confirmBatch(app, PW.session, req, clock(), money);
      expect(out).toMatchObject({ ok: true, legsReserved: 9, status: "confirmed" });
      if (!out.ok) return;
      pwBatch = out.batchId;

      // The first call has time for one send only.
      let calls = 0;
      const tight = () => (calls++ === 0 ? 0 : 99_000);
      const first = await drainBatch(app, PW.session, pwBatch, 100_000, { ...money, nowMs: tight, clock });
      expect(first).toMatchObject({ ok: true, status: "draining", sent: 1, confirmed: 1, remaining: 8 });

      payment.failNext("validation");
      const second = await drainBatch(app, PW.session, pwBatch, 100_000, { ...money, nowMs: () => 0, clock });
      expect(second).toMatchObject({ ok: true, status: "partial", confirmed: 6, failed: 3, unknown: 0, remaining: 0 });
      expect((await ledgerOf(PW, d09.id)).map((r) => [r.kind, r.state])).toEqual([
        ["settlement_bill", "failed"],
        ["settlement_bill_payment", "failed"],
        ["settlement_payout", "failed"],
      ]);
      // The bill legs were refused, not tried, and the record page says why in words.
      const refused = await adminRows<{ kind: string; failure_category: string; settled_via: string }>(
        PW,
        `SELECT kind, failure_category, settled_via FROM money_actions
          WHERE tenant_id = $1 AND subject_id = CAST($2 AS uuid) AND kind <> 'settlement_payout' ORDER BY kind`,
        [PW.id, d09.id],
      );
      expect(refused).toEqual([
        { kind: "settlement_bill", failure_category: "validation", settled_via: "refused" },
        { kind: "settlement_bill_payment", failure_category: "validation", settled_via: "refused" },
      ]);
      const view = await app.withTenant(PW.id, (q) => readSettlementRecord(q, d09.id));
      const legs = view?.legs ?? [];
      expect(legs.map((l) => [l.kind, legFailureLabel(l, legs)]).sort()).toEqual([
        ["settlement_bill", LEG_NOT_SENT],
        ["settlement_bill_payment", LEG_NOT_SENT],
        ["settlement_payout", null],
      ]);
      expect((await settlementOf(PW, "PW-D09")).status).toBe("approved");
      const d09Card = req.proposalIds[1];
      expect(await cardById(PW, d09Card)).toMatchObject({ status: "failed", decision_note: "validation" });

      const sends = payment.sendCount;
      const bills = books.seen.bills;
      const third = await drainBatch(app, PW.session, pwBatch, 100_000, { ...money, nowMs: () => 0, clock });
      expect(third).toMatchObject({ ok: true, status: "partial", confirmed: 6, failed: 3, remaining: 0 });
      expect([payment.sendCount, books.seen.bills]).toEqual([sends, bills]);
    });
    for (const code of ["PW-D07", "PW-D10"]) expect((await settlementOf(PW, code)).status, code).toBe("paid");
  }, 60_000);

  it("names the paystub's driver and week for the question box, inside its own carrier only", async () => {
    const s = await settlementOf(BR, "BR-D08");
    const [driver] = await adminRows<{ first_name: string; last_name: string }>(
      BR,
      "SELECT first_name, last_name FROM drivers WHERE tenant_id = $1 AND id = CAST($2 AS uuid)",
      [BR.id, s.driver_id],
    );
    const asked = await app.withTenant(BR.id, (q) => readPaystubAsk(q, s.id));
    expect(asked).toEqual({ driverName: nameOf(driver.first_name, driver.last_name), periodEnd: openPeriodOf(BR).period_end });
    expect(asked?.driverName).toMatch(/^\S.* .*\S$/);
    expect(await app.withTenant(PW.id, (q) => readPaystubAsk(q, s.id))).toBeNull();
    expect(await app.withTenant(BR.id, (q) => readPaystubAsk(q, randomUUID()))).toBeNull();
  });

  it("retires a waiting card whose paystub an interrupted run removed, and the rerun makes a new one", async () => {
    const s = await settlementOf(BR, "BR-D16");
    const card = await openCard(BR, "BR-D16");
    // What a run that stopped after removing the draft and before retiring its card leaves.
    await adminWrite(BR, "DELETE FROM settlement_lines WHERE tenant_id = $1 AND settlement_id = CAST($2 AS uuid)", [BR.id, s.id]);
    expect(await adminWrite(BR, "DELETE FROM settlements WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [BR.id, s.id])).toBe(1);
    expect((await cardById(BR, card.id)).status).toBe("proposed");

    expect((await run(BR)).ok).toBe(true);
    expect((await cardById(BR, card.id)).status).toBe("expired");
    const fresh = await openCard(BR, "BR-D16");
    expect(fresh.id).not.toBe(card.id);
    expect(fresh.subject_id).toBe((await settlementOf(BR, "BR-D16")).id);
    expect(fresh.subject_id).not.toBe(s.id);
  }, 60_000);

  it("keeps a confirmed payout recorded when booking its paystub fails, and Retry books it without paying again", async () => {
    const s = await settlementOf(BR, "BR-D21");
    expect(Number(s.net_cents)).toBeGreaterThan(0);
    const card = await openCard(BR, "BR-D21");
    const lines = await app.withTenant(BR.id, (q) => readStoredLines(q, s.id));
    const item = lines.flatMap((l) => l.sources).find((x) => x.table === "pay_items");
    if (!item) throw new Error("BR-D21 cites no pay item");
    const [paid] = await adminRows<{ id: string }>(
      BR,
      "SELECT id FROM settlements WHERE tenant_id = $1 AND status = 'paid' AND id <> CAST($2 AS uuid) ORDER BY id LIMIT 1",
      [BR.id, s.id],
    );
    const stamp = (to: string | null) =>
      adminWrite(BR, "UPDATE pay_items SET settlement_id = CAST($3 AS uuid) WHERE tenant_id = $1 AND id = CAST($2 AS uuid)", [
        BR.id,
        item.id,
        to,
      ]);
    // The rail pays the driver, then one of the week's pay items is settled elsewhere before the
    // paystub is booked: the booking cannot write whole.
    const breaksBooking: SettlementMoneyDeps = {
      ...money,
      payment: {
        ...payment,
        sendPayout: async (p, ctx) => {
          const out = await payment.sendPayout(p, ctx);
          expect(await stamp(paid.id)).toBe(1);
          return out;
        },
      },
    };
    const breaking: ExecutorRegistry = { ...EXECUTORS, settlement_approve: settlementApproveExecutor(breaksBooking) };
    const createdBefore = payment.createdCount;
    const sendsBefore = payment.sendCount;
    const billsBefore = books.seen.bills;
    try {
      await withSwitches(true, () => executeProposal(BR.session, card.id, { confirmed: true }, { db: app, clock, executors: breaking }));

      // The money went out and its record stands; the paystub is not booked, the bill legs did
      // not start, and the card says why while it waits.
      expect(payment.createdCount - createdBefore).toBe(1);
      expect((await ledgerOf(BR, s.id)).map((r) => [r.kind, r.state, r.attempt])).toEqual([["settlement_payout", "confirmed", 1]]);
      expect((await settlementOf(BR, "BR-D21")).status).toBe("approved");
      expect(books.seen.bills).toBe(billsBefore);
      expect(await cardById(BR, card.id)).toMatchObject({ status: "executing", decision_note: "not_booked" });
      const record = await app.withTenant(BR.id, (q) => readSettlementRecord(q, s.id));
      expect(record?.proposal).toMatchObject({ id: card.id, status: "executing", note: "not_booked" });
      expect(record?.latest.settlement_payout).toBe("confirmed");

      // Still unbookable: Retry says so and sends nothing.
      expect(await withSwitches(true, () => retryPayout(app, BR.session, s.id, money, clock))).toEqual({
        ok: false,
        category: "not_booked",
      });
    } finally {
      expect(await stamp(null)).toBe(1);
    }
    expect([payment.createdCount - createdBefore, payment.sendCount - sendsBefore]).toEqual([1, 1]);

    const retried = await withSwitches(true, () => retryPayout(app, BR.session, s.id, money, clock));
    expect(retried).toMatchObject({ ok: true, state: "confirmed" });
    expect([payment.createdCount - createdBefore, payment.sendCount - sendsBefore]).toEqual([1, 1]);
    expect((await settlementOf(BR, "BR-D21")).status).toBe("paid");
    expect((await ledgerOf(BR, s.id)).map((r) => [r.kind, r.state, r.attempt])).toEqual([["settlement_payout", "confirmed", 1]]);
    expect(await cardById(BR, card.id)).toMatchObject({ status: "done", decision_note: null });
    // Booked once: a second Retry finds a paid paystub and changes nothing.
    expect(await withSwitches(true, () => retryPayout(app, BR.session, s.id, money, clock))).toMatchObject({ ok: false });
    expect(payment.sendCount - sendsBefore).toBe(1);
  }, 60_000);

  it("refuses Retry payout on an approved paystub whose records changed, with nothing sent", async () => {
    const s = await settlementOf(BR, "BR-D07");
    expect(Number(s.net_cents)).toBeGreaterThan(0);
    const card = await openCard(BR, "BR-D07");
    // Approved with the switch off: nothing reserved, the paystub waits for Retry payout.
    await approve(BR, card.id);
    expect((await settlementOf(BR, "BR-D07")).status).toBe("approved");
    expect(await cardById(BR, card.id)).toMatchObject({ status: "done", decision_note: "not_paid" });

    await raiseLoad(BR, "BR-D07");
    const sendsBefore = payment.sendCount;
    const createdBefore = payment.createdCount;
    expect(await withSwitches(true, () => retryPayout(app, BR.session, s.id, money, clock))).toEqual({
      ok: false,
      category: "records_changed",
    });
    expect([payment.sendCount, payment.createdCount]).toEqual([sendsBefore, createdBefore]);
    expect(await ledgerOf(BR, s.id)).toEqual([]);
    expect((await settlementOf(BR, "BR-D07")).status).toBe("approved");
    expect(await cardById(BR, card.id)).toMatchObject({ status: "done", decision_note: "records_changed" });

    // The records back as approved: Retry pays once and the card's note clears.
    await raiseLoad(BR, "BR-D07", -10_000);
    expect(await withSwitches(true, () => retryPayout(app, BR.session, s.id, money, clock))).toMatchObject({
      ok: true,
      state: "confirmed",
    });
    expect(payment.createdCount - createdBefore).toBe(1);
    expect((await settlementOf(BR, "BR-D07")).status).toBe("paid");
    expect(await cardById(BR, card.id)).toMatchObject({ status: "done", decision_note: null });
  }, 60_000);

  it("refuses a batch paystub whose records changed after the confirm, in the drain, with nothing sent for it", async () => {
    const req = await requestFor(BR, ["BR-D02", "BR-D19"]);
    const d02 = await settlementOf(BR, "BR-D02");
    const createdBefore = payment.createdCount;
    const billsBefore = books.seen.bills;
    await withSwitches(true, async () => {
      const out = await confirmBatch(app, BR.session, req, clock(), money);
      expect(out).toMatchObject({ ok: true, legsReserved: 6, status: "confirmed" });
      if (!out.ok) return;
      await raiseLoad(BR, "BR-D02");
      const drained = await drainBatch(app, BR.session, out.batchId, 100_000, { ...money, nowMs: () => 0, clock });
      expect(drained).toMatchObject({ ok: true, status: "partial", confirmed: 3, failed: 3, unknown: 0, remaining: 0 });
    });
    expect(payment.createdCount - createdBefore).toBe(1);
    expect(books.seen.bills - billsBefore).toBe(1);
    const refused = await adminRows<{ kind: string; state: string; failure_category: string; settled_via: string }>(
      BR,
      `SELECT kind, state, failure_category, settled_via FROM money_actions
        WHERE tenant_id = $1 AND subject_id = CAST($2 AS uuid) ORDER BY kind`,
      [BR.id, d02.id],
    );
    expect(refused).toEqual([
      { kind: "settlement_bill", state: "failed", failure_category: "validation", settled_via: "refused" },
      { kind: "settlement_bill_payment", state: "failed", failure_category: "validation", settled_via: "refused" },
      { kind: "settlement_payout", state: "failed", failure_category: "validation", settled_via: "refused" },
    ]);
    expect((await settlementOf(BR, "BR-D02")).status).toBe("approved");
    const d02Cards = (await cardsOf(BR, d02.id)).filter((c) => req.proposalIds.includes(c.id));
    expect(d02Cards).toMatchObject([{ status: "failed", decision_note: "records_changed" }]);
    expect((await settlementOf(BR, "BR-D19")).status).toBe("paid");
  }, 60_000);

  it("keeps each carrier's batches and their ledger rows to itself", async () => {
    expect(await drainBatch(app, BR.session, pwBatch, 100_000, { ...money, clock })).toEqual({
      ok: false,
      category: "not_found",
    });
    const seen = await app.withTenant(PW.id, async (q) => ({
      batches: await q.query<{ id: string }>("SELECT id FROM approval_batches WHERE id = CAST($1 AS uuid)", [brBatch]),
      ledger: await q.query<{ id: string }>("SELECT id FROM money_actions WHERE batch_id = CAST($1 AS uuid)", [brBatch]),
    }));
    expect(seen).toEqual({ batches: [], ledger: [] });
    expect(await countOf(PW, "SELECT count(*) AS n FROM approval_batches WHERE tenant_id = $1", [PW.id])).toBe(2);
  });

  it("resets the demo carrier after paid, parked and batch-paid weeks, ledger rows on a batch included", async () => {
    // One more paystub parked, beside the paid ones and the three settlements batches above.
    const card = await openCard(BR, "BR-D11");
    await raiseLoad(BR, "BR-D11");
    await withSwitches(true, () => approve(BR, card.id));
    expect((await settlementOf(BR, "BR-D11")).parked_reason).toBe("line_amount_changed");
    const statuses = (await draftsOf(BR)).map((d) => d.status);
    expect(statuses).toContain("paid");
    expect(statuses).toContain("approved");
    const onBatch = await countOf(BR, "SELECT count(*) AS n FROM money_actions WHERE tenant_id = $1 AND batch_id IS NOT NULL", [BR.id]);
    expect(onBatch).toBeGreaterThan(0);
    expect(
      await countOf(BR, "SELECT count(*) AS n FROM approval_batches WHERE tenant_id = $1 AND scope = 'settlements'", [BR.id]),
    ).toBe(3);
    const ledger = await ledgerCount(BR);
    const pwLedger = await ledgerCount(PW);

    const report = await resetDemoTenant(app, BR.id, BR.plan);
    expect(report.cleared.money_actions).toBe(ledger);
    expect(report.cleared.approval_batches).toBe(3);
    expect([await ledgerCount(BR), await batchCount(BR)]).toEqual([0, 0]);
    // resetDemoTenant read every seeded table back against the plan before it returned.
    expect(await countOf(BR, "SELECT count(*) AS n FROM settlements WHERE tenant_id = $1", [BR.id])).toBe(
      BR.plan.rows.settlements.length,
    );
    // The other carrier is untouched.
    expect(await ledgerCount(PW)).toBe(pwLedger);
  }, 60_000);
});
