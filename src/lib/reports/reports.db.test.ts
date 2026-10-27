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
import { replaceTenantData } from "../seed/run";
import { parseReportArgs } from "./args";
import { reportForSession } from "./for-session";
import { isRefCell, REPORT_NAMES, reportToolName, type ReportName, type ReportResult } from "./types";

// The five report tools against a real database, as the app's own role, on both seeded demo
// carriers: each report reads its own carrier's records only, the Blue Ridge figures match the
// reviewed golden numbers, an id from the other carrier is refused, the switch off hides the
// tools, the download path computes the same numbers, and a report step reads back from the turn
// store as its name and args only. Two tenant rows carry the demo slugs; the fresh test database
// has no others with those slugs, and both are removed after.

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
  });

  afterAll(async () => {
    flags.reportsEnabled = false;
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
});
