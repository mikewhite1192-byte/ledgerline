import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { callTool } from "../agent/gateway";
import type { GatewayContext } from "../agent/gateway/types";
import { dbTurnStore, openAgentTurn, readAgentTurn } from "../agent/gateway/store";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan, type CarrierPlan } from "../seed/plan";
import { localDateOf, quarterContaining } from "../time/local-date";
import { replaceTenantData } from "../seed/run";
import { parseReportArgs } from "./args";
import { reportForSession } from "./for-session";
import { isRefCell, REPORT_NAMES, reportToolName, type ReportName, type ReportResult } from "./types";

// The report tools against a real database, as the app's own role, on both seeded demo
// carriers: each report reads its own carrier's records only, the Blue Ridge figures match the
// reviewed golden numbers, an id from the other carrier is refused, the switch off hides the
// tools, the download path computes the same numbers, and a report step reads back from the turn
// store as its name and args only. The IFTA quarter also places an edge purchase and delivery by
// each carrier's own local day and lists a gap load, on throwaway rows removed after. Two tenant
// rows carry the demo slugs; the fresh test database has no others with those slugs, and both are
// removed after.

const [BR, PW] = DEMO_CARRIERS;
const ANCHOR = golden.anchor;
const NOW = Date.UTC(2026, 10, 2, 17, 0, 0);
const GOLDEN = golden.carriers["blue-ridge"];

type Seeded = { id: string; carrier: DemoCarrier; plan: CarrierPlan };
const tenants: Seeded[] = [BR, PW].map((carrier) => ({
  id: randomUUID(),
  carrier,
  plan: buildCarrierPlan(carrier, ANCHOR),
}));
const [A, B] = tenants;

let admin: Db;
let app: Db;

const session = (t: Seeded, sub = `sub-${t.id}`): Session => ({ sub, email: `ops@${t.carrier.slug}.example`, tenantId: t.id });

const ctx = (t: Seeded): GatewayContext => ({
  session: session(t),
  role: "operator",
  model: "spark",
  turnId: null,
  traceId: `trace-reports-${t.id.slice(0, 8)}`,
  now: new Date(NOW),
  deadlineAt: NOW + 60_000,
  timeZone: t.carrier.timezone,
});
const clock = () => NOW;
const call = (name: string, args: unknown) => ({ id: "c", name, argumentsJson: JSON.stringify(args) });

function weekOf(plan: CarrierPlan, status: "paid" | "open"): string {
  const starts = plan.rows.settlement_periods
    .filter((p) => p.status === status)
    .map((p) => p.period_start)
    .sort();
  const last = starts.at(-1);
  if (!last) throw new Error(`no ${status} week in the plan`);
  return last;
}

// Each report's args for one carrier: dates from its own plan, no ids.
function argsFor(plan: CarrierPlan): Record<ReportName, Record<string, string>> {
  return {
    ar_aging: { asOf: ANCHOR },
    driver_pay_summary: { periodStart: weekOf(plan, "paid") },
    advances_outstanding: { asOf: ANCHOR },
    cash_needed: { periodStart: weekOf(plan, "open") },
    margin_per_load: { periodStart: "2026-10-05", periodEnd: "2026-11-01" },
    ifta_quarter: { asOf: ANCHOR },
    year_end_contractors: { year: ANCHOR.slice(0, 4) },
    trust_meter: { asOf: ANCHOR },
    driver_insights: { from: "2026-10-06", to: ANCHOR },
  };
}

// Every record id the plan wrote, so a result can be checked for the other carrier's ids.
function idsOf(plan: CarrierPlan): Set<string> {
  const ids = new Set<string>();
  for (const rows of Object.values(plan.rows) as { id?: unknown }[][]) {
    for (const r of rows) if (typeof r.id === "string") ids.add(r.id);
  }
  return ids;
}

async function runReport(t: Seeded, name: ReportName, args: Record<string, string>) {
  const out = await callTool(ctx(t), call(reportToolName(name), args), { db: app, clock });
  expect(out.decision, `${t.carrier.slug} ${name}`).toBe("allowed");
  return out.result as unknown as ReportResult;
}

// The IFTA quarter holding asOf, and its totals with an absent total read as 0 for a before and
// after comparison (a quarter with no rows has no totals).
const ifta = (t: Seeded, asOf: string) => runReport(t, "ifta_quarter", { asOf });
const gallonsOf = (r: ReportResult) => r.totals?.taxPaidGallonsMilli ?? 0;
const milesOf = (r: ReportResult) => r.totals?.miles ?? 0;

// A throwaway delivered load on a tenant with the given state rows (none makes a gap load). Its
// load number and id come back for the checks and the cleanup.
async function insertLoad(
  t: Seeded,
  deliveredAt: string,
  loadedMiles: number,
  emptyMiles: number,
  stateMiles: [string, number][],
): Promise<{ id: string; loadNumber: string }> {
  const id = randomUUID();
  const loadNumber = `IFTA-T-${id.slice(0, 8)}`;
  const deliveredOn = localDateOf(deliveredAt, t.carrier.timezone);
  await admin.withTenant(t.id, async (q) => {
    await q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles, empty_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'delivered', 'Origin',
         'PA', 'Destination', 'OH', CAST($5 AS date), CAST($5 AS date), CAST($6 AS timestamptz), $7, $8, 150000)`,
      [id, loadNumber, t.plan.rows.customers[0].id, t.plan.rows.drivers[0].id, deliveredOn, deliveredAt, loadedMiles, emptyMiles],
    );
    for (const [state, miles] of stateMiles) {
      await q.execute(
        `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4)`,
        [randomUUID(), id, state, miles],
      );
    }
  });
  return { id, loadNumber };
}

async function deleteLoad(t: Seeded, id: string): Promise<void> {
  await admin.withTenant(t.id, async (q) => {
    await q.execute("DELETE FROM load_state_miles WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)", [id]);
    await q.execute("DELETE FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]);
  });
}

describe("reports on a seeded database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
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
    for (const t of tenants) {
      await admin.withTenant(t.id, (q) =>
        q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
          t.carrier.slug,
          t.carrier.name,
          t.carrier.timezone,
        ]),
      );
      await replaceTenantData(app, t.id, t.plan);
      await admin.withTenant(t.id, (q) =>
        q.execute(
          "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
          [`sub-${t.id}`, `ops@${t.carrier.slug}.example`],
        ),
      );
    }
    flags.reportsEnabled = true;
    flags.iftaEnabled = true;
    flags.yearEndEnabled = true;
    flags.trustMeterEnabled = true;
  });

  afterAll(async () => {
    flags.reportsEnabled = false;
    flags.iftaEnabled = false;
    flags.yearEndEnabled = false;
    flags.trustMeterEnabled = false;
    // Only what this file made: the two tenants (their rows, memberships, decisions and turns go
    // with them, by cascade).
    for (const t of tenants) {
      await admin?.withTenant(t.id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("builds every report from its own carrier's records only", async () => {
    for (const [own, other] of [
      [A, B],
      [B, A],
    ] as const) {
      const mine = idsOf(own.plan);
      const theirs = idsOf(other.plan);
      const args = argsFor(own.plan);
      for (const name of REPORT_NAMES) {
        const result = await runReport(own, name, args[name]);
        expect(result.report).toBe(name);
        const text = JSON.stringify(result);
        for (const id of theirs) expect(text.includes(id), `${own.carrier.slug} ${name} shows ${id}`).toBe(false);
        for (const row of result.rows) {
          for (const cell of Object.values(row)) {
            if (isRefCell(cell)) expect(mine.has(cell.id), `${own.carrier.slug} ${name}`).toBe(true);
          }
        }
      }
    }
  });

  it("matches the golden figures for Blue Ridge, read back through the real readers", async () => {
    const aging = await runReport(A, "ar_aging", { asOf: ANCHOR });
    const b = GOLDEN.receivables.openByBucket;
    expect(aging.totals).toMatchObject({
      currentCents: b.current.cents,
      days1To30Cents: b["1_30"].cents,
      days31To60Cents: b["31_60"].cents,
      days61To90Cents: b["61_90"].cents,
      over90Cents: b.over_90.cents,
    });
    for (const week of GOLDEN.settledNetCents) {
      const pay = await runReport(A, "driver_pay_summary", { periodStart: week.periodStart });
      expect(pay.totals?.netCents, week.periodStart).toBe(week.netCents);
    }
    const advances = await runReport(A, "advances_outstanding", { asOf: ANCHOR });
    expect(advances.totals?.outstandingCents).toBe(GOLDEN.advancesOutstandingCents);
    const cash = await runReport(A, "cash_needed", {});
    expect(cash.rows).toEqual([]);
    expect(cash.emptyReason).toBe("no_pay_run");
    const margin = await runReport(A, "margin_per_load", { periodStart: "2026-10-05", periodEnd: "2026-11-01" });
    expect(margin.rowsTotal).toBeGreaterThan(0);
  });

  it("refuses the other carrier's driver or customer as an unknown record", async () => {
    const driver = await callTool(
      ctx(A),
      call(reportToolName("driver_pay_summary"), { driverId: B.plan.rows.drivers[0].id }),
      { db: app, clock },
    );
    expect(driver).toMatchObject({ decision: "blocked", reason: "unknown_record" });
    const customer = await callTool(
      ctx(A),
      call(reportToolName("margin_per_load"), {
        periodStart: "2026-10-05",
        periodEnd: "2026-11-01",
        customerId: B.plan.rows.customers[0].id,
      }),
      { db: app, clock },
    );
    expect(customer).toMatchObject({ decision: "blocked", reason: "unknown_record" });
  });

  it("hides every report tool while the switch is off", async () => {
    flags.reportsEnabled = false;
    try {
      for (const name of REPORT_NAMES) {
        const out = await callTool(ctx(A), call(reportToolName(name), {}), { db: app, clock });
        expect(out.decision, name).toBe("unknown_tool");
      }
    } finally {
      flags.reportsEnabled = true;
    }
  });

  it("computes the same numbers for the download, and refuses a login with no membership", async () => {
    const request = parseReportArgs("ar_aging", { asOf: ANCHOR });
    if (!request) throw new Error("bad args");
    const fromTool = await runReport(A, "ar_aging", { asOf: ANCHOR });
    const fromRoute = await reportForSession(session(A), request, new Date(NOW), app);
    expect(fromRoute.totals).toEqual(fromTool.totals);
    expect(fromRoute.rowsTotal).toBe(fromTool.rowsTotal);
    await expect(reportForSession(session(A, "sub-nobody"), request, new Date(NOW), app)).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });

  it("reads a report step back from the turn store as its name and args only", async () => {
    const turnId = randomUUID();
    const opened = await openAgentTurn(
      session(A),
      { conversationId: null, turnId, text: "Who owes us money?", now: new Date(NOW), summaryChars: 10_000 },
      { db: app, clock: () => new Date(NOW) },
    );
    if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
    const store = dbTurnStore(session(A), { db: app, clock: () => new Date(NOW + 1_000) });
    const report = { name: "ar_aging", args: { asOf: ANCHOR } };
    const good = await store.startStep(turnId, { kind: "tool", label: "Building the receivables aging report" });
    await store.finishStep(turnId, good.id, {
      state: "done",
      detail: { tool: "report_ar_aging", decision: "allowed", reason: "ok", report },
    });
    // A detail that does not parse as a report is never shown as one.
    const bad = await store.startStep(turnId, { kind: "tool", label: "Building the receivables aging report" });
    await store.finishStep(turnId, bad.id, {
      state: "done",
      detail: { tool: "report_ar_aging", decision: "allowed", reason: "ok", report: { name: "payroll", args: {} } },
    });
    await store.finishTurn(turnId, {
      status: "done",
      endedReason: null,
      text: "The table is below.",
      summary: "The table is below.",
      stepCount: 2,
      modelCallCount: 1,
      costNanocents: 1,
    });
    const view = await readAgentTurn(session(A), turnId, { db: app });
    expect(view?.reports).toEqual([{ stepId: good.id, ...report }]);
    const fromB = await readAgentTurn(session(B), turnId, { db: app });
    expect(fromB).toBeNull();
  });

  it("sums each carrier's own IFTA quarter from its own loads and fuel, the tool and the download alike", async () => {
    const quarter = quarterContaining(ANCHOR);
    const inQuarter = (day: string | null) => day !== null && quarter.start <= day && day <= quarter.end;
    const request = parseReportArgs("ifta_quarter", { asOf: ANCHOR });
    if (!request) throw new Error("bad args");
    for (const t of tenants) {
      const r = await ifta(t, ANCHOR);
      expect(r.period).toEqual(quarter);
      const loads = t.plan.rows.loads.filter(
        (l) => (l.status === "delivered" || l.status === "invoiced") && inQuarter(l.delivered_on),
      );
      const fuel = t.plan.rows.fuel_purchases.filter((f) => inQuarter(f.purchased_on));
      expect(loads.length, t.carrier.slug).toBeGreaterThan(0);
      expect(fuel.length, t.carrier.slug).toBeGreaterThan(0);
      expect(r.totals?.miles, t.carrier.slug).toBe(loads.reduce((n, l) => n + l.loaded_miles + l.empty_miles, 0));
      expect(r.totals?.taxPaidGallonsMilli, t.carrier.slug).toBe(fuel.reduce((n, f) => n + f.gallons_milli, 0));
      expect(typeof r.totals?.taxDueCents, t.carrier.slug).toBe("number");
      expect(r.notes?.[0], t.carrier.slug).toMatch(/^SAMPLE rates: /);
      expect(r.notes?.at(-1), t.carrier.slug).toMatch(/^No data gaps: /);
      const fromRoute = await reportForSession(session(t), request, new Date(NOW), app);
      expect(fromRoute.totals, t.carrier.slug).toEqual(r.totals);
      expect(fromRoute.rowsTotal, t.carrier.slug).toBe(r.rowsTotal);
    }
  });

  it("puts a fuel purchase and a delivery in the quarter of the carrier's own local day", async () => {
    // One instant, two zones: 04:30 UTC on Oct 1 is Oct 1 in New York and still Sep 30 in Chicago.
    const at = "2026-10-01T04:30:00.000Z";
    expect([A.carrier.timezone, B.carrier.timezone]).toEqual(["America/New_York", "America/Chicago"]);
    expect([localDateOf(at, A.carrier.timezone), localDateOf(at, B.carrier.timezone)]).toEqual([
      "2026-10-01",
      "2026-09-30",
    ]);
    // Two deliveries on A whose UTC day is a day after their New York day: 23:00 on Sep 30, the
    // last local day of Q3, and 23:00 on Oct 1, the first local day of Q4.
    const lastOfQ3 = "2026-10-01T03:00:00.000Z";
    const firstOfQ4 = "2026-10-02T03:00:00.000Z";
    expect([localDateOf(lastOfQ3, A.carrier.timezone), localDateOf(firstOfQ4, A.carrier.timezone)]).toEqual([
      "2026-09-30",
      "2026-10-01",
    ]);
    const Q3 = "2026-09-30";
    const before = {
      aQ3: await ifta(A, Q3),
      aQ4: await ifta(A, ANCHOR),
      bQ3: await ifta(B, Q3),
      bQ4: await ifta(B, ANCHOR),
    };
    const GALLONS = 12_345;
    const fuelIds = new Map<string, string>();
    const loadIds: string[] = [];
    try {
      for (const t of tenants) {
        const id = randomUUID();
        fuelIds.set(t.id, id);
        await admin.withTenant(t.id, (q) =>
          q.execute(
            `INSERT INTO fuel_purchases (id, tenant_id, driver_id, purchased_at, purchased_on, state, gallons_milli,
               amount_cents, paid_with, purchase_ref)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS timestamptz), CAST($4 AS date),
               'PA', $5, 5000, 'company_card', $6)`,
            [id, t.plan.rows.drivers[0].id, at, localDateOf(at, t.carrier.timezone), GALLONS, `ifta-edge-${id}`],
          ),
        );
      }
      loadIds.push((await insertLoad(A, lastOfQ3, 300, 20, [["PA", 200], ["OH", 120]])).id);
      loadIds.push((await insertLoad(A, firstOfQ4, 410, 0, [["PA", 410]])).id);

      const after = {
        aQ3: await ifta(A, Q3),
        aQ4: await ifta(A, ANCHOR),
        bQ3: await ifta(B, Q3),
        bQ4: await ifta(B, ANCHOR),
      };
      // New York: the Oct 1 purchase and the Oct 1 delivery are Q4, the Sep 30 delivery Q3.
      expect(gallonsOf(after.aQ4) - gallonsOf(before.aQ4)).toBe(GALLONS);
      expect(gallonsOf(after.aQ3)).toBe(gallonsOf(before.aQ3));
      expect(milesOf(after.aQ4) - milesOf(before.aQ4)).toBe(410);
      expect(milesOf(after.aQ3) - milesOf(before.aQ3)).toBe(320);
      // Chicago: the same instant is Sep 30, so the purchase is Q3 and Q4 does not move.
      expect(gallonsOf(after.bQ3) - gallonsOf(before.bQ3)).toBe(GALLONS);
      expect(after.bQ4.totals).toEqual(before.bQ4.totals);
      expect(milesOf(after.bQ3)).toBe(milesOf(before.bQ3));
    } finally {
      for (const id of loadIds) await deleteLoad(A, id);
      for (const t of tenants) {
        const id = fuelIds.get(t.id);
        if (id) {
          await admin.withTenant(t.id, (q) =>
            q.execute("DELETE FROM fuel_purchases WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]),
          );
        }
      }
    }
  });

  it("lists a delivered load with no state split as a gap and leaves it out of the totals", async () => {
    const before = await ifta(B, ANCHOR);
    const aBefore = await ifta(A, ANCHOR);
    let made: { id: string; loadNumber: string } | null = null;
    try {
      made = await insertLoad(B, "2026-10-20T17:00:00.000Z", 275, 25, []);
      const r = await ifta(B, ANCHOR);
      expect(r.totals).toEqual(before.totals);
      expect(r.rows).toEqual(before.rows);
      expect(r.notes).toContain(`Excluded from the totals: 1 load with no state split (300 miles): ${made.loadNumber}.`);
      expect(r.notes?.some((n) => n.startsWith("No data gaps"))).toBe(false);
      // A's quarter never moves for B's rows.
      expect((await ifta(A, ANCHOR)).totals).toEqual(aBefore.totals);
    } finally {
      if (made) await deleteLoad(B, made.id);
    }
  });

  it("hides the IFTA tool while its own switch is off, and leaves the other reports on", async () => {
    flags.iftaEnabled = false;
    try {
      const off = await callTool(ctx(A), call(reportToolName("ifta_quarter"), { asOf: ANCHOR }), { db: app, clock });
      expect(off.decision).toBe("unknown_tool");
      const aging = await callTool(ctx(A), call(reportToolName("ar_aging"), { asOf: ANCHOR }), { db: app, clock });
      expect(aging.decision).toBe("allowed");
    } finally {
      flags.iftaEnabled = true;
    }
  });
});
