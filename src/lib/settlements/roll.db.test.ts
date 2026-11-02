import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { readCashFridayInput } from "../data/read";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { computeCashFriday } from "../rules-engine";
import { DEMO_ANCHOR } from "../seed/anchor";
import { HERO_OPEN_WEEK } from "../seed/assert-plan";
import { DEMO_CARRIERS } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { resetDemoInTransaction } from "../seed/reset";
import { clearTenantAgent, replaceTenantData } from "../seed/run";
import { startSweep } from "../sweep/run";
import { readSweepHome } from "../sweep/view";
import { rollPayWeek } from "./roll";
import { runPayPeriod } from "./run";

// The pay week roll (D-090) against the real database, as the app's role: the Blue Ridge demo
// carrier, seeded with its plan under its own slug (the demo reset runs only for a demo slug), and
// put back to the plan by the demo reset before each test. The sweep's start opens the week holding
// the carrier's today only with the switch on, once however many starts race, and leaves the
// seeded week and its stubs as they were. The start then sweeps the week paid next (D-093): the
// seeded week while it is open, the week the roll opened once the seeded week is paid. The tenant
// is removed after. Each test runs whole sweeps, so each has room for a slow runner: a test cut off
// at the default timeout would keep writing into the next one.

const CARRIER = DEMO_CARRIERS[0];
const plan = buildCarrierPlan(CARRIER, DEMO_ANCHOR);
const seededWeek = plan.rows.settlement_periods.find((p) => p.status === "open");
if (!seededWeek) throw new Error("the plan has no open week");
// The weeks the plan seeds: the history weeks and the one open week.
const SEEDED = plan.rows.settlement_periods.length;
const T = randomUUID();
const SESSION: Session = { sub: `sub-${T}`, email: "ops@pay-week-roll-test.example", tenantId: T };
// Monday November 2, 2026, 13:00 in New York (the carrier's zone): past the seeded week's end.
const MONDAY_NOON = new Date("2026-11-02T18:00:00.000Z");
const saved = structuredClone(flags);

let admin: Db;
let app: Db;

const start = async (at: Date, runId = randomUUID()) => {
  const s = await startSweep(SESSION, { runId, trigger: "button" }, { db: app, clock: () => at });
  if (!s.ok) throw new Error(`start refused: ${s.category}`);
  return s.runId;
};

const periods = () =>
  admin.withTenant(T, (q) =>
    q.query<{ id: string; period_start: string; period_end: string; status: string }>(
      `SELECT CAST(id AS text) AS id, CAST(period_start AS text) AS period_start, CAST(period_end AS text) AS period_end,
              status
         FROM settlement_periods WHERE tenant_id = current_tenant_id() ORDER BY period_start`,
    ),
  );

const runPeriod = async (runId: string) =>
  (
    await admin.withTenant(T, (q) =>
      q.query<{ period_id: string }>("SELECT CAST(period_id AS text) AS period_id FROM sweep_runs WHERE id = CAST($1 AS uuid)", [
        runId,
      ]),
    )
  )[0]?.period_id;

// The seeded week's stubs and their lines, whole rows, in a fixed order.
const seededRows = () =>
  admin.withTenant(T, async (q) => ({
    settlements: await q.query<{ row: unknown }>(
      `SELECT to_jsonb(s) AS row FROM settlements s
        WHERE s.tenant_id = current_tenant_id() AND s.period_id = CAST($1 AS uuid) ORDER BY s.id`,
      [seededWeek.id],
    ),
    lines: await q.query<{ row: unknown }>(
      `SELECT to_jsonb(l) AS row FROM settlement_lines l JOIN settlements s ON s.tenant_id = l.tenant_id AND s.id = l.settlement_id
        WHERE l.tenant_id = current_tenant_id() AND s.period_id = CAST($1 AS uuid) ORDER BY l.settlement_id, l.seq`,
      [seededWeek.id],
    ),
  }));

// The week the sweep home shows.
const homeWeek = async () => (await readSweepHome(SESSION, { db: app })).openPeriod?.id ?? null;

// "Run the week" on the seeded week, then its stubs set to the status given, as an approval or a
// confirmed payout would leave them; a paid week's period is closed too, as the roll-up does.
const settleSeededWeek = async (status: "approved" | "paid") => {
  expect((await runPayPeriod(app, SESSION, seededWeek.id, MONDAY_NOON)).ok).toBe(true);
  await admin.withTenant(T, async (q) => {
    const stubs = await q.query<{ id: string }>(
      "SELECT CAST(id AS text) AS id FROM settlements WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid)",
      [seededWeek.id],
    );
    expect(stubs.length).toBeGreaterThan(0);
    await q.execute(
      `UPDATE settlements SET status = $2, paid_at = CASE WHEN $2 = 'paid' THEN CAST('2026-11-06T15:00:00Z' AS timestamptz) END
        WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid)`,
      [seededWeek.id, status],
    );
    if (status === "paid") {
      await q.execute("UPDATE settlement_periods SET status = 'paid' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        seededWeek.id,
      ]);
    }
  });
};

const cashFriday = (today: string) =>
  app.withTenant(T, async (q) => computeCashFriday(await readCashFridayInput(q, CARRIER.timezone, flags.cashFridayLimits), today));

describe("the pay week roll at the sweep's start", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug = $1", [CARRIER.slug]),
    );
    if (leftover.length > 0) {
      throw new Error(`a tenant ${CARRIER.slug} already exists: the database tests need a fresh database`);
    }
    await admin.withTenant(T, (q) =>
      q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
        CARRIER.slug,
        CARRIER.name,
        CARRIER.timezone,
      ]),
    );
    await replaceTenantData(admin, T, plan);
    await admin.withTenant(T, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES
           (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@pay-week-roll-test.invalid', 'staff'),
           (current_tenant_id(), $1, $2, 'staff')`,
        [SESSION.sub, SESSION.email],
      ),
    );
  }, 120_000);

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    flags.sweepEnabled = true;
    await app.withTenant(T, (q) => resetDemoInTransaction(q, plan));
  }, 60_000);

  afterEach(() => {
    Object.assign(flags, structuredClone(saved));
  });

  afterAll(async () => {
    Object.assign(flags, structuredClone(saved));
    if (admin) {
      await clearTenantAgent(admin, T).catch(() => undefined);
      await admin.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("opens nothing with the switch off, and the sweep runs the seeded week", async () => {
    flags.payWeekRoll = { enabled: false };
    const runId = await start(MONDAY_NOON);
    expect((await periods()).length).toBe(SEEDED);
    expect(await runPeriod(runId)).toBe(seededWeek.id);
  }, 60_000);

  it("opens the week holding today with the switch on, sweeps the seeded week first, and leaves it and its stubs as they were", async () => {
    flags.payWeekRoll = { enabled: true };
    const before = await seededRows();
    const runId = await start(MONDAY_NOON);
    const after = await periods();
    expect(after.length).toBe(SEEDED + 1);
    const opened = after.filter((p) => p.period_start === "2026-11-02");
    expect(opened).toEqual([{ id: opened[0]?.id, period_start: "2026-11-02", period_end: "2026-11-08", status: "open" }]);
    expect(await runPeriod(runId)).toBe(seededWeek.id);
    expect(after.find((p) => p.id === seededWeek.id)?.status).toBe("open");
    expect(await seededRows()).toEqual(before);
  }, 60_000);

  it("opens the week once when two starts race", async () => {
    flags.payWeekRoll = { enabled: true };
    const [a, b] = await Promise.all([start(MONDAY_NOON), start(MONDAY_NOON)]);
    expect((await periods()).filter((p) => p.period_start === "2026-11-02").length).toBe(1);
    expect((await periods()).length).toBe(SEEDED + 1);
    expect(await runPeriod(a)).toBe(await runPeriod(b));
    expect(await runPeriod(a)).toBe(seededWeek.id);
  }, 60_000);

  it("sweeps the week the roll opened once the seeded week is paid, and the sweep home follows", async () => {
    flags.payWeekRoll = { enabled: true };
    await start(MONDAY_NOON);
    expect(await homeWeek()).toBe(seededWeek.id);
    await settleSeededWeek("paid");
    const opened = (await periods()).find((p) => p.period_start === "2026-11-02");
    expect(opened?.status).toBe("open");
    const runId = await start(new Date("2026-11-06T18:00:00.000Z"));
    expect(await runPeriod(runId)).toBe(opened?.id);
    expect(await homeWeek()).toBe(opened?.id);
  }, 60_000);

  it("still sweeps the seeded week while its stubs are approved but not paid", async () => {
    flags.payWeekRoll = { enabled: true };
    await settleSeededWeek("approved");
    const runId = await start(MONDAY_NOON);
    expect((await periods()).length).toBe(SEEDED + 1);
    expect((await periods()).find((p) => p.id === seededWeek.id)?.status).toBe("open");
    expect(await runPeriod(runId)).toBe(seededWeek.id);
    expect(await homeWeek()).toBe(seededWeek.id);
  }, 60_000);

  it("opens nothing more on a later day inside the opened week", async () => {
    flags.payWeekRoll = { enabled: true };
    await start(MONDAY_NOON);
    const later = await app.withTenant(T, (q) => rollPayWeek(q, new Date("2026-11-04T18:00:00.000Z")));
    expect(later).toEqual({ opened: false, periodStart: null, reason: "week_exists" });
    await start(new Date("2026-11-04T18:00:00.000Z"));
    expect((await periods()).length).toBe(SEEDED + 1);
  }, 60_000);

  it("opens nothing on Sunday evening in the carrier's zone, still the seeded week's last day", async () => {
    flags.payWeekRoll = { enabled: true };
    const runId = await start(new Date("2026-11-02T03:00:00.000Z"));
    expect((await periods()).length).toBe(SEEDED);
    expect(await runPeriod(runId)).toBe(seededWeek.id);
  }, 60_000);

  it("gives the same Cash Friday figures for the seeded week after the roll", async () => {
    const before = await cashFriday("2026-11-02");
    expect(before.ok).toBe(true);
    flags.payWeekRoll = { enabled: true };
    await start(MONDAY_NOON);
    expect(await cashFriday("2026-11-02")).toEqual(before);
  }, 60_000);

  it("passes over an older open week with no paystub, so Cash Friday still reports the seeded week and the sweep runs it", async () => {
    const before = await cashFriday("2026-11-02");
    expect(before.ok).toBe(true);
    // An open week nobody drew pay in never finishes (the roll-up closes a week from its stubs).
    await admin.withTenant(T, (q) =>
      q.execute(
        `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-09-28' AS date), CAST('2026-10-04' AS date), 'open')`,
        [randomUUID()],
      ),
    );
    expect(await cashFriday("2026-11-02")).toEqual(before);
    // With the roll on, three weeks are open: the empty one, the seeded week and today's.
    flags.payWeekRoll = { enabled: true };
    const runId = await start(MONDAY_NOON);
    expect((await periods()).filter((p) => p.status === "open").length).toBe(3);
    expect(await runPeriod(runId)).toBe(seededWeek.id);
  }, 60_000);

  it("is put back to the seeded weeks by the demo reset, the hero's net unchanged", async () => {
    flags.payWeekRoll = { enabled: true };
    await start(MONDAY_NOON);
    expect((await periods()).length).toBe(SEEDED + 1);
    const report = await app.withTenant(T, (q) => resetDemoInTransaction(q, plan));
    expect(report.heroNetCents).toBe(HERO_OPEN_WEEK.netCents);
    expect((await periods()).map((p) => p.period_start)).toEqual(plan.rows.settlement_periods.map((p) => p.period_start).sort());
  }, 60_000);
});
