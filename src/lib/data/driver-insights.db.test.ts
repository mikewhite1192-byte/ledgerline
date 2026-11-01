import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { callTool } from "../agent/gateway";
import { toolNamed } from "../agent/gateway/registry";
import type { GatewayContext } from "../agent/gateway/types";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable } from "../db/types";
import { computeReport } from "../reports/run";
import type { ReportResult } from "../reports/types";
import { readCardedDrivers, readDeficitsOwed, readDriverInsightInput, readDriverInsightRows } from "./driver-insights";
import { ReadLimitError } from "./read";

// The driver insights' reads against a real database, as the app's own role, on two hand-built
// carriers: each carrier reads its own rows only, paid paystubs only, pay weeks by the day they
// end, loads and miles by delivered date, advances owed whatever their date, deficits less what was
// recovered and only while unsettled, and the report tool answers through the gateway for the
// operator alone. A fixed clock; both carriers are made before each test and removed after it.

const NOW = new Date("2026-11-03T03:30:00Z"); // 10:30 PM on Nov 2 in New York, already Nov 3 in UTC
const WINDOW = { start: "2026-10-06", end: "2026-11-02" };

let admin: Db;
let app: Db;

type Carrier = {
  tenant: string;
  sub: string;
  drivers: { first: string; second: string; gone: string };
  stubs: { paidIn: string; approvedIn: string; paidBefore: string };
};

let A: Carrier;
let B: Carrier;

const ins = (q: Queryable, sql: string, params: unknown[] = []) => q.execute(sql, params as never);

async function carrier(tag: string, timezone: string, scale: number): Promise<Carrier> {
  const tenant = randomUUID();
  const sub = `sub-insights-${tag}-${tenant.slice(0, 8)}`;
  const drivers = { first: randomUUID(), second: randomUUID(), gone: randomUUID() };
  const stubs = { paidIn: randomUUID(), approvedIn: randomUUID(), paidBefore: randomUUID() };
  const customer = randomUUID();
  const payConfig = randomUUID();
  await admin.withTenant(tenant, async (q) => {
    await ins(q, "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
      `insights-${tag}-${tenant.slice(0, 8)}`,
      `Insights ${tag}`,
      timezone,
    ]);
    await ins(q, "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')", [
      sub,
      `ops@${tag}.example`,
    ]);
    await ins(
      q,
      `INSERT INTO customers (id, tenant_id, code, name, terms_days, city, state)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'IN-1', 'Lakeside Supply', 30, 'Dayton', 'OH')`,
      [customer],
    );
    const driver = (id: string, code: string, first: string, activeTo: string | null) =>
      ins(
        q,
        `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
           per_mile_cents, active_from, active_to)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, 'Tester', $4, 'company', 'per_mile', 60,
           CAST('2026-01-05' AS date), CAST($5 AS date))`,
        [id, code, first, `${code.toLowerCase()}@${tag}.example`, activeTo],
      );
    await driver(drivers.first, `${tag.toUpperCase()}-D01`, "Avery", null);
    await driver(drivers.second, `${tag.toUpperCase()}-D02`, "Blair", null);
    await driver(drivers.gone, `${tag.toUpperCase()}-D03`, "Casey", "2026-09-30");
    await ins(
      q,
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 0, 0, 0, 0)`,
      [payConfig],
    );
    // Pay weeks ending the day before the window, on its first day, on its last day and after it.
    const periods = new Map<string, string>();
    for (const end of ["2026-10-05", "2026-10-06", "2026-11-02", "2026-11-03"]) {
      const id = randomUUID();
      periods.set(end, id);
      await ins(
        q,
        `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date) - 6, CAST($2 AS date), 'open')`,
        [id, end],
      );
    }
    const stub = (id: string, end: string, driverId: string, status: "paid" | "approved", net: number) =>
      ins(
        q,
        `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
           deductions_cents, net_cents, paid_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5,
           $6 + 1000, 1000, $6, CAST($7 AS timestamptz))`,
        [id, periods.get(end), driverId, payConfig, status, net, status === "paid" ? "2026-11-01T15:00:00Z" : null],
      );
    await stub(stubs.paidIn, "2026-10-06", drivers.first, "paid", 50_000 * scale);
    await stub(randomUUID(), "2026-11-02", drivers.first, "paid", 7_000 * scale);
    await stub(stubs.approvedIn, "2026-11-02", drivers.second, "approved", 99_000 * scale);
    await stub(stubs.paidBefore, "2026-10-05", drivers.second, "paid", 88_000 * scale);
    await stub(randomUUID(), "2026-11-03", drivers.second, "paid", 77_000 * scale);
    const line = (settlement: string, seq: number, kind: string, cents: number) =>
      ins(
        q,
        `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, 'Line', $5, CAST('[]' AS jsonb))`,
        [randomUUID(), settlement, seq, kind, cents],
      );
    await line(stubs.paidIn, 1, "fuel", 4_000 * scale);
    await line(stubs.paidIn, 2, "insurance", 3_000 * scale);
    await line(stubs.approvedIn, 1, "fuel", 6_000 * scale);
    await line(stubs.paidBefore, 1, "fuel", 5_000 * scale);
    let n = 0;
    const load = (driverId: string | null, status: string, deliveredOn: string | null, loaded: number, empty: number) =>
      ins(
        q,
        `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
           dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles, empty_miles, linehaul_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), $5, 'Dayton', 'OH',
           'Toledo', 'OH', CAST('2026-09-01' AS date), CAST($6 AS date),
           CASE WHEN $6 IS NULL THEN NULL ELSE CAST($6 AS date) + TIME '12:00' END, $7, $8, 100000)`,
        [randomUUID(), `${tag.toUpperCase()}-L${(n += 1)}`, customer, driverId, status, deliveredOn, loaded, empty],
      );
    await load(drivers.second, "delivered", "2026-10-05", 900 * scale, 9);
    await load(drivers.second, "delivered", "2026-10-06", 400 * scale, 20);
    await load(drivers.second, "invoiced", "2026-11-02", 600 * scale, 30);
    await load(drivers.second, "delivered", "2026-11-03", 900 * scale, 9);
    await load(drivers.first, "in_transit", null, 700, 0);
    const adv = (driverId: string, on: string, status: string, amount: number, recovered: number) =>
      ins(
        q,
        `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on, amount_cents,
           status, recovered_cents, source, paid_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS date) + TIME '15:00',
           CAST($4 AS date), $5, $6, $7, 'seed', CASE WHEN $6 = 'paid' THEN CAST($4 AS date) + TIME '16:00' END)`,
        [randomUUID(), driverId, `req-${randomUUID().slice(0, 8)}`, on, amount, status, recovered],
      );
    // Taken before the window and still partly owed; taken in it; requested only; rejected.
    await adv(drivers.first, "2026-09-01", "paid", 30_000 * scale, 10_000 * scale);
    await adv(drivers.first, "2026-10-06", "paid", 20_000 * scale, 0);
    await adv(drivers.first, "2026-10-20", "requested", 9_000, 0);
    await adv(drivers.second, "2026-10-21", "rejected", 9_000, 0);
    const membership = (await q.query<{ id: string }>("SELECT CAST(id AS text) AS id FROM memberships WHERE cognito_sub = $1", [sub]))[0].id;
    const deficit = (driverId: string, amount: number, recovered: number, settledIn: string | null) =>
      ins(
        q,
        `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, recovered_cents, note, source_kind,
           source_id, named_by, settled_in)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, 'Owed back', 'ruling',
           CAST($5 AS uuid), CAST($6 AS uuid), CAST($7 AS uuid))`,
        [randomUUID(), driverId, amount, recovered, randomUUID(), membership, settledIn],
      );
    // Open and partly recovered, open whole, and settled (all of it taken back).
    await deficit(drivers.gone, 12_000 * scale, 2_000 * scale, null);
    await deficit(drivers.gone, 1_000 * scale, 0, null);
    await deficit(drivers.second, 5_000, 5_000, stubs.paidBefore);
    const card = (driverId: string, status: "active" | "closed") =>
      ins(
        q,
        `INSERT INTO driver_cards (id, tenant_id, driver_id, provider, provider_token, last4, status, source, closed_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'fuel_card_sim', $3, '4242', $4, 'seed',
           CASE WHEN $4 = 'closed' THEN now() END)`,
        [randomUUID(), driverId, `fcs_card_${randomBytes(12).toString("hex")}`, status],
      );
    await card(drivers.first, "active");
    await card(drivers.second, "closed");
  });
  return { tenant, sub, drivers, stubs };
}

const ctx = (c: Carrier, role: GatewayContext["role"] = "operator"): GatewayContext => ({
  session: { sub: c.sub, email: "ops@insights.example", tenantId: c.tenant },
  role,
  model: "spark",
  turnId: null,
  traceId: `trace-insights-${c.tenant.slice(0, 8)}`,
  now: NOW,
  deadlineAt: NOW.getTime() + 60_000,
  timeZone: "America/New_York",
});
const call = (args: unknown) => ({ id: "c", name: "report_driver_insights", argumentsJson: JSON.stringify(args) });

const rowOf = (r: ReportResult, id: string) => r.rows.find((row) => (row.driver as { id: string }).id === id);

describe("driver insights reads", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    flags.reportsEnabled = true;
  });

  beforeEach(async () => {
    A = await carrier("ia", "America/New_York", 1);
    B = await carrier("ib", "America/Chicago", 3);
  });

  afterEach(async () => {
    try {
      if (A) await admin.withTenant(A.tenant, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    } finally {
      if (B) await admin.withTenant(B.tenant, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
  });

  afterAll(async () => {
    flags.reportsEnabled = false;
    await app?.close();
    await admin?.close();
  });

  it("reads the window's paid stubs by the day their week ends, and their fuel lines alone", async () => {
    const rows = await app.withTenant(A.tenant, (q) => readDriverInsightRows(q, WINDOW));
    expect(rows.settlement_periods.map((p) => p.period_end).sort()).toEqual(["2026-10-06", "2026-11-02"]);
    expect(rows.settlements.every((s) => s.status === "paid")).toBe(true);
    expect(rows.settlements.map((s) => s.net_cents).sort((x, y) => x - y)).toEqual([7_000, 50_000]);
    expect(rows.settlement_lines.map((l) => [l.settlement_id, l.kind, l.amount_cents])).toEqual([[A.stubs.paidIn, "fuel", 4_000]]);
  });

  it("reads loads by delivered date inside the window, delivered or invoiced only", async () => {
    const rows = await app.withTenant(A.tenant, (q) => readDriverInsightRows(q, WINDOW));
    expect(rows.loads.map((l) => [l.delivered_on, l.status]).sort()).toEqual([
      ["2026-10-06", "delivered"],
      ["2026-11-02", "invoiced"],
    ]);
  });

  it("reads every approved or paid advance, and deficits less what was recovered while unsettled", async () => {
    const input = await app.withTenant(A.tenant, (q) => readDriverInsightInput(q, WINDOW));
    expect(input.advances.map((a) => a.status).sort()).toEqual(["paid", "paid"]);
    expect(input.deficits).toEqual([{ driverId: A.drivers.gone, owedCents: 11_000 }]);
    expect(input.drivers).toHaveLength(3);
  });

  it("reads each carrier's own rows only", async () => {
    const a = await app.withTenant(A.tenant, (q) => readDriverInsightRows(q, WINDOW));
    const b = await app.withTenant(B.tenant, (q) => readDriverInsightRows(q, WINDOW));
    const aIds = new Set(Object.values(A.drivers));
    const bIds = new Set(Object.values(B.drivers));
    for (const rows of [a.settlements, a.loads, a.advances]) for (const r of rows) expect(aIds.has(r.driver_id as string)).toBe(true);
    for (const rows of [b.settlements, b.loads, b.advances]) for (const r of rows) expect(bIds.has(r.driver_id as string)).toBe(true);
    expect(a.drivers.map((d) => d.id).sort()).toEqual([...aIds].sort());
    expect(b.deficits).toEqual([{ driverId: B.drivers.gone, owedCents: 33_000 }]);
    expect(await app.withTenant(A.tenant, (q) => readCardedDrivers(q))).toEqual(new Set([A.drivers.first]));
    expect(await app.withTenant(B.tenant, (q) => readCardedDrivers(q))).toEqual(new Set([B.drivers.first]));
  });

  it("fails a read past its page bound whole, and refuses a backward or too-long window before any read", async () => {
    await expect(app.withTenant(A.tenant, (q) => readDriverInsightRows(q, WINDOW, { pageSize: 1, maxPages: 1 }))).rejects.toBeInstanceOf(
      ReadLimitError,
    );
    await expect(app.withTenant(A.tenant, (q) => readDriverInsightRows(q, { start: "2026-11-02", end: "2026-11-01" }))).rejects.toThrow(
      RangeError,
    );
    await expect(app.withTenant(A.tenant, (q) => readDriverInsightRows(q, { start: "2025-11-01", end: "2026-11-02" }))).rejects.toThrow(
      RangeError,
    );
    expect(await app.withTenant(A.tenant, (q) => readDeficitsOwed(q))).toHaveLength(1);
  });

  it("computes the report for the carrier's own today, in its own zone", async () => {
    // 3:30 AM UTC on Nov 3 is still Nov 2 in New York: the default window ends Nov 2.
    const r = await app.withTenant(A.tenant, (q) =>
      computeReport(q, { name: "driver_insights", args: {} }, { now: NOW, timeZone: "America/New_York" }),
    );
    expect(r.period).toEqual(WINDOW);
    expect(rowOf(r, A.drivers.first)).toMatchObject({
      netCents: 57_000,
      fuelCents: 4_000,
      loads: 0,
      advancesTaken: 1,
      advancesTakenCents: 20_000,
      advancesOwedCents: 40_000,
      owedCents: 40_000,
    });
    expect(rowOf(r, A.drivers.second)).toMatchObject({ netCents: 0, loads: 2, loadedMiles: 1_000, emptyMiles: 50 });
    expect(rowOf(r, A.drivers.gone)).toMatchObject({ status: "Departed", deficitsOwedCents: 11_000, owedCents: 11_000 });
    expect(r.leaders?.topNet).toEqual({ driver: expect.objectContaining({ id: A.drivers.first }), valueCents: 57_000 });
    expect(r.leaders?.mostOwed).toEqual({ driver: expect.objectContaining({ id: A.drivers.first }), valueCents: 40_000 });
  });

  it("answers the report tool through the gateway for the operator, with a read tier, and for no other role", async () => {
    const out = await callTool(ctx(B), call({ from: WINDOW.start, to: WINDOW.end }), { db: app, clock: () => NOW.getTime() });
    expect(out.decision).toBe("allowed");
    expect(toolNamed("report_driver_insights")).toMatchObject({ tier: "read", roles: ["operator"] });
    const r = out.result as unknown as ReportResult;
    expect(rowOf(r, B.drivers.first)).toMatchObject({ netCents: 171_000, fuelCents: 12_000 });
    expect(rowOf(r, A.drivers.first)).toBeUndefined();
    for (const role of ["auditor", "triage"] as const) {
      const other = await callTool(ctx(B, role), call({}), { db: app, clock: () => NOW.getTime() });
      expect(other.decision, role).toBe("denied");
    }
    const bad = await callTool(ctx(B), call({ from: "2025-01-01", to: "2026-11-02" }), { db: app, clock: () => NOW.getTime() });
    expect(bad.decision).not.toBe("allowed");
  });
});
