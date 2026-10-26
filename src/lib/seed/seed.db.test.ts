import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countTenantRows,
  readAdvanceInput,
  readCheckInput,
  readReceivablesInput,
  readSettlementInput,
  readTenantRows,
} from "../data/read";
import { loadsOf, payConfigOf } from "../data/records";
import type { TenantRows } from "../data/rows";
import { TENANT_TABLES, type TenantTable } from "../data/tables";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import {
  advanceEligibility,
  findPaymentOnWrongInvoice,
  runAllChecks,
  settleDriver,
} from "../rules-engine";
import { HERO_OPEN_WEEK, seededAdvanceDecision } from "./assert-plan";
import { DEMO_CARRIERS, type DemoCarrier } from "./carriers";
import golden from "./golden.json";
import { buildCarrierPlan, type CarrierPlan } from "./plan";
import { findDemoTenant, replaceTenantData } from "./run";
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
    await createTenant(A, BR);
    await createTenant(B, PW);
  });

  afterAll(async () => {
    await bypass?.close();
    // Only what this file made: the two tenants (their rows go with them) and the role.
    for (const id of [A, B]) {
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

  it("answers an advance request from rows read back as the plan does", async () => {
    const hero = heroOf(planA);
    const at = "2026-11-01T14:30:00.000Z";
    const input = await app.withTenant(A, (q) => readAdvanceInput(q, hero.id, at, 5000));
    expect(input.requestedOn).toBe("2026-11-01");
    expect(advanceEligibility(input)).toEqual(
      seededAdvanceDecision({
        config: payConfigOf(planA.rows.pay_configs[0]),
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
});
