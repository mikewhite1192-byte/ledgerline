import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createMockPaymentAdapter } from "../adapters/payment/mock";
import type { Session } from "../auth/claims";
import { configForDay } from "../data/config-version";
import {
  countTenantRows,
  readAdvanceInput,
  readCheckInput,
  readPayConfigFor,
  readReceivablesInput,
  readSettlementInput,
  readTenantRows,
} from "../data/read";
import { customerOf, loadStopsOf, loadsOf, payConfigOf } from "../data/records";
import type { TenantRows } from "../data/rows";
import { TENANT_TABLES, type TenantTable } from "../data/tables";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable } from "../db/types";
import { executeMoneyAction, type MoneyHooks } from "../money/execute";
import {
  advanceEligibility,
  findPaymentOnWrongInvoice,
  findUnbilledDetention,
  lastFullMonthBefore,
  runAllChecks,
  settleDriver,
  sum,
} from "../rules-engine";
import { addDays } from "../time/local-date";
import { customerClassOf } from "./ar-plan";
import { DETENTION_TOTAL_CENTS, HERO_OPEN_WEEK, seededAdvanceDecision } from "./assert-plan";
import { DEMO_CARRIERS, type DemoCarrier } from "./carriers";
import golden from "./golden.json";
import { buildCarrierPlan, type CarrierPlan } from "./plan";
import { clearTenantLedger, findDemoTenant, replaceTenantData } from "./run";
import { countRows } from "./summary";

// The seed against a real database: plans written as payday_app, read back equal, the engine run
// on what came back, and the tenant walls held, including for a login that bypasses row-level
// security (as the cluster admin does on Aurora). Two tenant rows carry the demo slugs; the
// fresh test database has no others with those slugs.

const ANCHOR = golden.anchor;
const [BR, PW] = DEMO_CARRIERS;
const planA = buildCarrierPlan(BR, ANCHOR);
const planB = buildCarrierPlan(PW, ANCHOR);
const A = randomUUID();
const B = randomUUID();
const BYPASS_ROLE = `seed_bypass_${A.slice(0, 8)}`;

let admin: Db;
let app: Db;
let bypass: Db | undefined;

async function createTenant(id: string, carrier: DemoCarrier): Promise<void> {
  await admin.withTenant(id, (q) =>
    q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)",
      [carrier.slug, carrier.name, carrier.timezone],
    ),
  );
}

async function sqlStateOf(work: Promise<unknown>): Promise<string | undefined> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return (err as { sqlState?: string }).sqlState;
}

// Rows in a fixed order, so a plan and a read-back compare whatever order each came in.
function sorted(rows: TenantRows): TenantRows {
  const key = (r: object) => ("id" in r ? String(r.id) : JSON.stringify(r));
  return Object.fromEntries(
    TENANT_TABLES.map((t) => [t, [...rows[t]].sort((a, b) => (key(a) < key(b) ? -1 : 1))]),
  ) as TenantRows;
}

const countsOf = (db: Db, tenantId: string) => db.withTenant(tenantId, countTenantRows);
const rowsOf = (db: Db, tenantId: string) =>
  db.withTenant(tenantId, async (q) => sorted(await readTenantRows(q)));

const heroOf = (plan: CarrierPlan) =>
  plan.rows.drivers.find((d) => d.code === plan.carrier.heroCode) ?? plan.rows.drivers[0];
const openWeekOf = (plan: CarrierPlan) =>
  plan.rows.settlement_periods.find((p) => p.status === "open") ?? plan.rows.settlement_periods[0];

describe("seeding the demo carriers", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    // findDemoTenant needs exactly one tenant per demo slug, so a leftover one (from npm run
    // demo:users, say) would fail every test here with a confusing message.
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug IN ($1, $2) ORDER BY slug", [
        BR.slug,
        PW.slug,
      ]),
    );
    if (leftover.length > 0) {
      throw new Error(
        `a tenant ${leftover[0].slug} already exists: the database tests need a fresh database ` +
          "(npm run test:db:fresh)",
      );
    }
    await createTenant(A, BR);
    await createTenant(B, PW);
  });

  afterAll(async () => {
    await bypass?.close();
    // Only what this file made: the two tenants (their rows, memberships and ledger rows go with
    // them) and the role.
    for (const id of [A, B]) {
      await clearTenantLedger(admin, id);
      await admin.withTenant(id, (q) =>
        q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"),
      );
    }
    await admin.withoutTenant(async (q) => {
      const found = await q.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [BYPASS_ROLE]);
      if (found.length === 1) {
        await q.execute(`DROP OWNED BY ${BYPASS_ROLE}`);
        await q.execute(`DROP ROLE ${BYPASS_ROLE}`);
      }
    });
    await app?.close();
    await admin?.close();
  });

  it("finds each demo tenant by slug, and only one that matches the carrier", async () => {
    expect(await findDemoTenant(admin, BR)).toBe(A);
    expect(await findDemoTenant(admin, PW)).toBe(B);
    await expect(findDemoTenant(admin, { ...BR, timezone: "America/Chicago" })).rejects.toThrow(
      "does not match the demo carrier",
    );
    const unknown = { ...BR, slug: "prairie-ridge" } as unknown as DemoCarrier;
    await expect(findDemoTenant(admin, unknown)).rejects.toThrow("no tenant prairie-ridge");
  });

  it("writes each plan as the app role and reads the same rows back", async () => {
    for (const [id, plan] of [
      [A, planA],
      [B, planB],
    ] as const) {
      const report = await replaceTenantData(app, id, plan);
      expect(report.inserted).toEqual(countRows(plan.rows));
      expect(Object.values(report.deleted).every((n) => n === 0)).toBe(true);
      expect(await countsOf(app, id)).toEqual(golden.carriers[plan.carrier.slug].counts);
      expect(await rowsOf(app, id)).toEqual(sorted(plan.rows));
    }
  });

  it("replaces on a second run and ends with the same rows", async () => {
    const before = await rowsOf(app, A);
    const report = await replaceTenantData(app, A, planA);
    expect(report.deleted).toEqual(countRows(planA.rows));
    expect(report.inserted).toEqual(countRows(planA.rows));
    expect(await rowsOf(app, A)).toEqual(before);
    expect(await countsOf(app, B)).toEqual(countRows(planB.rows));
  });

  it("keeps each tenant's rows behind its wall for the app role", async () => {
    const loadA = planA.rows.loads[0];
    const customerB = planB.rows.customers[0];
    const seen = await app.withTenant(B, (q) =>
      q.query("SELECT id FROM loads WHERE id = CAST($1 AS uuid)", [loadA.id]),
    );
    expect(seen).toEqual([]);
    const writeIntoA = app.withTenant(B, (q) =>
      q.execute(
        "INSERT INTO customers (tenant_id, id, code, name, terms_days, city, state) " +
          "VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'X-1', 'Invented', 30, 'Salina', 'KS')",
        [A, randomUUID()],
      ),
    );
    expect(await sqlStateOf(writeIntoA)).toBe("42501");
    const borrowCustomer = app.withTenant(A, (q) =>
      q.execute(
        "UPDATE loads SET customer_id = CAST($1 AS uuid) " +
          "WHERE tenant_id = current_tenant_id() AND id = CAST($2 AS uuid)",
        [customerB.id, loadA.id],
      ),
    );
    expect(await sqlStateOf(borrowCustomer)).toBe("23503");
  });

  it("writes nothing when the tenant is not the plan's carrier", async () => {
    await expect(replaceTenantData(app, B, planA)).rejects.toThrow(
      "the current tenant is not blue-ridge",
    );
    expect(await countsOf(app, B)).toEqual(countRows(planB.rows));
  });

  it("rolls the whole replace back when a write fails partway", async () => {
    const before = await rowsOf(app, A);
    const broken: CarrierPlan = { ...planA, rows: { ...planA.rows } };
    // The last table: every delete and every other insert has run when this one fails.
    broken.rows.payment_applications = planA.rows.payment_applications.map((a, i) =>
      i === 0 ? { ...a, payment_id: randomUUID() } : a,
    );
    await expect(replaceTenantData(app, A, broken)).rejects.toMatchObject({ sqlState: "23503" });
    expect(await rowsOf(app, A)).toEqual(before);
  });

  it("gives the engine the same answers from rows read back", async () => {
    const hero = heroOf(planA);
    const open = openWeekOf(planA);
    const settlement = await app.withTenant(A, (q) => readSettlementInput(q, hero.id, open.id));
    const result = settleDriver(settlement);
    expect([result.grossCents, result.deductionsCents, result.netCents]).toEqual([
      HERO_OPEN_WEEK.grossCents,
      HERO_OPEN_WEEK.deductionsCents,
      HERO_OPEN_WEEK.netCents,
    ]);
    expect(result.lines.map((l) => [l.seq, l.kind, l.label, l.amountCents])).toEqual(
      golden.carriers["blue-ridge"].hero?.lines.map((l) => [l.seq, l.kind, l.label, l.amountCents]),
    );

    for (const [id, plan] of [
      [A, planA],
      [B, planB],
    ] as const) {
      const checks = runAllChecks(await app.withTenant(id, readCheckInput));
      const p = plan.planted;
      const hit = new Map(checks.map((f) => [f.check, f.sources[0].id]));
      expect(checks).toHaveLength(6);
      expect(hit.get("duplicate_advance")).toBe(p.duplicateAdvanceIds[1]);
      expect(hit.get("fuel_on_wrong_driver")).toBe(p.wrongDriverFuelItemId);
      expect(hit.get("insurance_day_not_driven")).toBe(p.dispatchDayId);
      expect(hit.get("missing_reimbursement")).toBe(p.unreimbursedLumperId);
      expect(hit.get("delivered_without_rate")).toBe(p.noRateLoadId);
      expect(hit.get("over_advance_limit")).toBe(
        plan.rows.drivers.find((d) => d.code === plan.victims.overLimit)?.id,
      );

      const receivables = await app.withTenant(id, (q) => readReceivablesInput(q, ANCHOR));
      const w = p.wrongInvoice;
      expect(findPaymentOnWrongInvoice(receivables)).toEqual([
        {
          check: "payment_on_wrong_invoice",
          category: "payment_on_wrong_invoice",
          amountCents: expect.any(Number),
          sources: [
            { table: "customer_payments", id: w.paymentId },
            { table: "payment_applications", id: w.applicationId },
            { table: "invoices", id: w.appliedToInvoiceId },
            { table: "invoices", id: w.meantForInvoiceId },
          ],
        },
      ]);
    }
  });

  it("finds the versioned rules and the planted cases by SQL over the seeded rows", async () => {
    for (const [id, plan] of [
      [A, planA],
      [B, planB],
    ] as const) {
      const p = plan.planted;
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      const sql = <T>(text: string, params: string[] = []) =>
        app.withTenant(id, (q) => q.query<T>(text, params));

      // Every settlement names the newest version dated on or before its period's start.
      const versions = await sql<{ effective_from: string; settled: number }>(
        `SELECT p.effective_from, count(s.id) AS settled
           FROM pay_configs p
           LEFT JOIN settlements s ON s.tenant_id = p.tenant_id AND s.pay_config_id = p.id
          WHERE p.tenant_id = current_tenant_id()
          GROUP BY p.effective_from
          ORDER BY p.effective_from`,
      );
      const settledUnder = (from: string) => {
        const version = plan.rows.pay_configs.find((v) => v.effective_from === from)!;
        return plan.rows.settlements.filter((s) => s.pay_config_id === version.id).length;
      };
      expect(versions.map((v) => [v.effective_from, Number(v.settled)])).toEqual(
        plan.carrier.slug === "blue-ridge"
          ? [
              ["2026-10-05", settledUnder("2026-10-05")],
              ["2026-10-19", settledUnder("2026-10-19")],
            ]
          : [["2026-10-04", plan.rows.settlements.length]],
      );
      const [{ wrong }] = await sql<{ wrong: number }>(
        `SELECT count(*) AS wrong
           FROM settlements s
           JOIN settlement_periods sp ON sp.tenant_id = s.tenant_id AND sp.id = s.period_id
           JOIN pay_configs p ON p.tenant_id = s.tenant_id AND p.id = s.pay_config_id
          WHERE s.tenant_id = current_tenant_id()
            AND p.effective_from IS DISTINCT FROM (
              SELECT max(v.effective_from) FROM pay_configs v
               WHERE v.tenant_id = s.tenant_id AND v.effective_from <= sp.period_start)`,
      );
      expect(Number(wrong)).toBe(0);

      const overTank = await sql<{ id: string }>(
        `SELECT f.id FROM fuel_purchases f
           JOIN drivers d ON d.tenant_id = f.tenant_id AND d.id = f.driver_id
          WHERE f.tenant_id = current_tenant_id() AND f.gallons_milli > d.tank_gallons * 1000`,
      );
      const offRoute = await sql<{ id: string }>(
        `SELECT f.id FROM fuel_purchases f
           JOIN loads l ON l.tenant_id = f.tenant_id AND l.id = f.load_id
          WHERE f.tenant_id = current_tenant_id()
            AND f.purchased_on BETWEEN l.pickup_on AND coalesce(l.delivered_on, f.purchased_on)
            AND NOT EXISTS (
              SELECT 1 FROM load_state_miles m
               WHERE m.tenant_id = l.tenant_id AND m.load_id = l.id AND m.state = f.state)`,
      );
      const parked = await sql<{ id: string }>(
        `SELECT f.id FROM fuel_purchases f
          WHERE f.tenant_id = current_tenant_id() AND f.paid_with = 'company_card'
            AND NOT EXISTS (
              SELECT 1 FROM loads l
               WHERE l.tenant_id = f.tenant_id AND l.driver_id = f.driver_id
                 AND l.pickup_on <= f.purchased_on
                 AND f.purchased_on <= coalesce(l.delivered_on, f.purchased_on))
            AND NOT EXISTS (
              SELECT 1 FROM driver_days d
               WHERE d.tenant_id = f.tenant_id AND d.driver_id = f.driver_id
                 AND d.day = f.purchased_on)`,
      );
      expect([ids(overTank), ids(offRoute), ids(parked)]).toEqual([
        [p.fuelOverTankId],
        [p.fuelOffRouteId],
        [p.fuelParkedId],
      ]);

      const rows = await app.withTenant(id, readTenantRows);
      const unbilled = findUnbilledDetention(
        rows.loads.map(loadStopsOf),
        rows.customers.map(customerOf),
        rows.load_accessorials.map((a) => ({ loadId: a.load_id, kind: a.kind })),
        lastFullMonthBefore(ANCHOR),
      );
      expect(unbilled.map((u) => u.loadId).sort()).toEqual([...p.detentionLoadIds].sort());
      expect(sum(unbilled.map((u) => u.amountCents))).toBe(DETENTION_TOTAL_CENTS);

      // Prompt payers never leave an invoice open more than 30 days; slow payers do.
      const pastDue = await sql<{ code: string }>(
        `SELECT DISTINCT c.code FROM invoices i
           JOIN customers c ON c.tenant_id = i.tenant_id AND c.id = i.customer_id
          WHERE i.tenant_id = current_tenant_id()
            AND i.status IN ('open', 'partially_paid') AND i.due_on < $1::date`,
        [addDays(ANCHOR, -30)],
      );
      const classes = pastDue.map((r) => customerClassOf(Number(r.code.slice(-2)) - 1));
      expect(classes).not.toContain("prompt");
      expect(classes).toContain("slow");
    }

    const blueRidge = await app.withTenant(A, async (q) => [
      await readPayConfigFor(q, "2026-10-12"),
      await readPayConfigFor(q, "2026-10-19"),
    ]);
    expect(blueRidge.map((v) => [v.effective_from, v.insurance_per_day_cents, v.source])).toEqual([
      ["2026-10-05", 1050, "seed"],
      ["2026-10-19", 1100, "seed"],
    ]);
    const prairieWind = await app.withTenant(B, (q) => readPayConfigFor(q, "2026-10-11"));
    expect(prairieWind.effective_from).toBe("2026-10-04");
  });

  it("answers an advance request from rows read back as the plan does", async () => {
    const hero = heroOf(planA);
    const at = "2026-11-01T14:30:00.000Z";
    const input = await app.withTenant(A, (q) => readAdvanceInput(q, hero.id, at, 5000));
    expect(input.requestedOn).toBe("2026-11-01");
    expect(advanceEligibility(input)).toEqual(
      seededAdvanceDecision({
        config: payConfigOf(configForDay(planA.rows.pay_configs, "2026-11-01")),
        driver: hero,
        loads: loadsOf(planA.rows.loads, planA.rows.load_state_miles, planA.rows.load_accessorials),
        periods: planA.periods,
        zone: BR.timezone,
        at,
        amountCents: 5000,
        prior: planA.rows.advances.filter((a) => a.driver_id === hero.id),
      }),
    );
  });

  it("stays on one tenant under a login that bypasses row-level security", async () => {
    const tables = ["tenants", ...TENANT_TABLES].join(", ");
    await admin.withoutTenant(async (q) => {
      await q.execute(`CREATE ROLE ${BYPASS_ROLE} LOGIN BYPASSRLS NOINHERIT`);
      await q.execute(`GRANT USAGE ON SCHEMA public TO ${BYPASS_ROLE}`);
      await q.execute(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO ${BYPASS_ROLE}`);
    });
    const url = new URL(adminUrl());
    url.username = BYPASS_ROLE;
    url.password = "";
    bypass = createPgDb({ connectionString: url.toString(), max: 1 });

    // The login really does see past the wall when a statement names no tenant.
    const [all] = await bypass.withTenant(A, (q) =>
      q.query<{ n: number }>("SELECT count(*) AS n FROM loads"),
    );
    const both = planA.rows.loads.length + planB.rows.loads.length;
    expect(Number(all.n)).toBeGreaterThanOrEqual(both);

    const rowsB = await rowsOf(app, B);
    const report = await replaceTenantData(bypass, A, planA);
    const expected: Record<TenantTable, number> = countRows(planA.rows);
    expect(report.deleted).toEqual(expected);
    expect(report.inserted).toEqual(expected);
    expect(await rowsOf(app, B)).toEqual(rowsB);
    expect(await countsOf(app, B)).toEqual(countRows(planB.rows));
    // Every read the seed and the app make names its tenant, so this login reads one only.
    expect(await rowsOf(bypass, A)).toEqual(sorted(planA.rows));
    expect(await countsOf(bypass, B)).toEqual(countRows(planB.rows));
  });

  // Last: it pays a seeded advance, so the rows no longer equal the plan afterwards.
  it("clears the tenant's ledger before a replace, so the re-created advance is paid once", async () => {
    const saved = { ...flags };
    flags.payoutsEnabled = true;
    flags.paymentProvider = "mock";
    try {
      const member = async (tenantId: string): Promise<Session> => {
        const sub = `seed-test-${tenantId}`;
        await admin.withTenant(tenantId, (q) =>
          q.execute(
            `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
             VALUES (current_tenant_id(), $1, 'ops@carrier.example', 'staff')`,
            [sub],
          ),
        );
        return { sub, email: "", tenantId };
      };
      // A driver's pending request for a seeded advance (the plan writes them all paid).
      const requested = (tenantId: string, advanceId: string) =>
        app.withTenant(tenantId, (q) =>
          q.execute(
            `UPDATE advances SET status = 'requested', paid_at = NULL
             WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
            [advanceId],
          ),
        );
      const ledgerRows = async (tenantId: string) => {
        const [row] = await admin.withoutTenant((q) =>
          q.query<{ n: number }>(
            "SELECT count(*) AS n FROM money_actions WHERE tenant_id = CAST($1 AS uuid)",
            [tenantId],
          ),
        );
        return Number(row.n);
      };
      const one = async (q: Queryable, sql: string, id: string) => {
        if ((await q.execute(sql, [id])) !== 1) throw new Error("expected one advance row");
      };
      const hooks: MoneyHooks = {
        onReserved: (q, a) =>
          one(
            q,
            `UPDATE advances SET status = 'approved'
             WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
               AND status = 'requested'`,
            a.subjectId,
          ),
        onConfirmed: (q, a) =>
          one(
            q,
            `UPDATE advances SET status = 'paid', paid_at = now()
             WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
               AND status = 'approved'`,
            a.subjectId,
          ),
      };
      const mock = createMockPaymentAdapter({ log: () => {} });
      const pay = (session: Session, advance: CarrierPlan["rows"]["advances"][number]) =>
        executeMoneyAction(
          app,
          session,
          {
            kind: "advance_payout",
            subjectId: advance.id,
            counterpartyId: advance.driver_id,
            amountCents: advance.amount_cents,
            proposedBy: "person",
            subjectStatuses: ["requested"],
          },
          hooks,
          { payment: mock, log: () => {} },
        );

      const [sessionA, sessionB] = [await member(A), await member(B)];
      const [advanceA] = planA.rows.advances;
      const [advanceB] = planB.rows.advances;
      expect(await requested(A, advanceA.id)).toBe(1);
      expect(await requested(B, advanceB.id)).toBe(1);
      const paid = await pay(sessionA, advanceA);
      expect(paid.action.state).toBe("confirmed");
      expect((await pay(sessionB, advanceB)).action.state).toBe("confirmed");

      // What npm run seed does for blue-ridge: its ledger rows, then the replace.
      expect(await clearTenantLedger(admin, A)).toBe(1);
      await replaceTenantData(app, A, planA);
      expect(await ledgerRows(A)).toBe(0);
      // The admin login ignores row-level security; the tenant filter kept the other carrier's.
      expect(await ledgerRows(B)).toBe(1);

      expect(await requested(A, advanceA.id)).toBe(1);
      const again = await pay(sessionA, advanceA);
      expect(again).toMatchObject({ created: true, sent: true });
      expect(again.action.state).toBe("confirmed");
      expect(again.action.id).not.toBe(paid.action.id);
      expect(again.action.idempotencyKey).toBe(`advance_payout:${advanceA.id}:1`);
      // A second approval replays that row and sends nothing.
      const replay = await pay(sessionA, advanceA);
      expect(replay).toMatchObject({ created: false, sent: false });
      expect(replay.action.id).toBe(again.action.id);
      expect(mock.createdCount).toBe(3);
      expect(await ledgerRows(A)).toBe(1);
    } finally {
      Object.assign(flags, saved);
    }
  });
});
