import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { explainPaystub } from "../agent/gateway/tools/read/explain-paystub";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { instantAt } from "../seed/calendar";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { localDateOf } from "../time/local-date";
import { runPayPeriod } from "./run";
import { readSettlementRecord } from "./views";
import { readPaystubYear } from "./year";

// The paystub's year to date and escrow balance against a real database seeded with a demo carrier
// under its own slug, as the app's role. The hero's year to date is the sum of their seeded paid
// nets whose paid time falls in the year in the carrier's own zone (the year paid, or for a draft the
// year its week ends), on a paid stub only those paid up to and including it; a draft's escrow
// balance is the driver's balance plus its escrow line; a paid stub's is the balance its booking
// stored. Another carrier reads nothing. The clock is fixed. A moved paid time is put back in finally; both tenants
// made here are removed after.

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const saved = structuredClone(flags);

const CARRIER = {
  ...DEMO_CARRIERS[0],
  slug: "paystub-year-test",
  name: "Paystub Year Test Carrier",
} as unknown as DemoCarrier;
const ZONE = CARRIER.timezone;
const T = randomUUID();
const PLAN = buildCarrierPlan(CARRIER, golden.anchor);
const STAFF: Session = { sub: `paystub-year-admin-${T}`, email: "", tenantId: T };

const HERO = (() => {
  const code = DEMO_CARRIERS[0].heroCode;
  const d = PLAN.rows.drivers.find((x) => x.code === code);
  if (!d) throw new Error("no hero driver in the seed");
  return d;
})();
const OPEN = (() => {
  const p = PLAN.rows.settlement_periods.find((x) => x.status === "open");
  if (!p) throw new Error("no open period");
  return p;
})();
const YEAR = Number(OPEN.period_end.slice(0, 4));

// The hero's seeded paid stubs, and the nets of those paid in YEAR in the carrier's zone.
const HERO_PAID = PLAN.rows.settlements
  .filter((s) => s.driver_id === HERO.id && s.status === "paid" && s.paid_at !== null)
  .sort((a, b) => (a.paid_at! < b.paid_at! ? -1 : 1));
const inYear = HERO_PAID.filter((s) => Number(localDateOf(s.paid_at!, ZONE).slice(0, 4)) === YEAR);
const EXPECTED_YTD = inYear.reduce((n, s) => n + s.net_cents, 0);

let admin: Db;
let app: Db;
let other: Fixture | undefined;

const rows = <R extends object>(sql: string, params: Param[] = []) =>
  admin.withTenant(T, (q) => q.query<R>(sql, params));
const write = (sql: string, params: Param[] = []) => admin.withTenant(T, (q) => q.execute(sql, params));

async function heroDraft(): Promise<{ id: string; status: string }> {
  const [d] = await rows<{ id: string; status: string }>(
    `SELECT CAST(id AS text) AS id, status FROM settlements
      WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)`,
    [OPEN.id, HERO.id],
  );
  if (!d) throw new Error("the hero has no draft in the open week");
  return d;
}

describe("the paystub's year to date and escrow balance against a seeded database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug = $1", [CARRIER.slug]),
    );
    if (leftover.length > 0) throw new Error("a paystub-year-test tenant already exists: use a fresh database");
    await admin.withTenant(T, async (q) => {
      await q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
        CARRIER.slug,
        CARRIER.name,
        CARRIER.timezone,
      ]);
      await q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), $1, $2, 'admin')`,
        [STAFF.sub, `admin@${CARRIER.slug}.example`],
      );
    });
    await replaceTenantData(app, T, PLAN);
    other = await makeTenant(admin, "paystub-year-other");
    flags.settlementsEnabled = true;
    flags.payoutsEnabled = false;
    flags.accountingEnabled = false;
    flags.auditorEnabled = false;
    flags.auditorRequired = false;
    const r = await runPayPeriod(app, STAFF, OPEN.id, new Date(NOW));
    if (!r.ok) throw new Error(`the pay run refused: ${r.category}`);
  }, 120_000);

  afterAll(async () => {
    Object.assign(flags, saved);
    await admin?.withTenant(T, (q) => q.execute("DELETE FROM money_actions WHERE tenant_id = current_tenant_id()"));
    await admin?.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    await dropTenant(admin, other);
    await app?.close();
    await admin?.close();
  });

  it("shows the hero's draft the sum of their paid nets this year and the balance plus its escrow line", async () => {
    expect(inYear.length).toBeGreaterThan(0);
    const draft = await heroDraft();
    expect(draft.status).toBe("draft");
    const [{ balance }] = await rows<{ balance: string }>(
      "SELECT CAST(escrow_balance_cents AS text) AS balance FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [HERO.id],
    );
    const escrowLines = await rows<{ amount: string }>(
      `SELECT CAST(amount_cents AS text) AS amount FROM settlement_lines
        WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid) AND kind = 'escrow'`,
      [draft.id],
    );
    // The hero's open week withholds escrow: one line, taken from pay.
    expect(escrowLines).toHaveLength(1);
    const line = Number(escrowLines[0].amount);
    expect(line).toBeLessThan(0);

    const view = await app.withTenant(T, (q) => readPaystubYear(q, draft.id));
    expect(view?.yearToDate).toEqual({ year: YEAR, paidCents: EXPECTED_YTD, stubs: inYear.length, zone: ZONE });
    expect(view?.escrow).toEqual({ balanceCents: Number(balance) + Math.abs(line), asOf: "after_this_paystub" });
  });

  it("shows a paid stub the balance its booking stored, and counts the stub in the year it was paid", async () => {
    const last = HERO_PAID[HERO_PAID.length - 1];
    const view = await app.withTenant(T, (q) => readPaystubYear(q, last.id));
    expect(view?.escrow).toEqual({ balanceCents: last.escrow_closing_cents, asOf: "paid" });
    const year = Number(localDateOf(last.paid_at!, ZONE).slice(0, 4));
    expect(view?.yearToDate.year).toBe(year);
    const paidThatYear = HERO_PAID.filter((s) => Number(localDateOf(s.paid_at!, ZONE).slice(0, 4)) === year);
    expect(paidThatYear.map((s) => s.id)).toContain(last.id);
    expect(view?.yearToDate.paidCents).toBe(paidThatYear.reduce((n, s) => n + s.net_cents, 0));
    expect(view?.yearToDate.stubs).toBe(paidThatYear.length);
  });

  it("shows an older paid stub only what was paid up to and including it", async () => {
    // A stub paid in YEAR with at least one paid after it in YEAR.
    expect(inYear.length).toBeGreaterThan(1);
    const older = inYear[Math.floor((inYear.length - 1) / 2)];
    const upTo = inYear.filter((s) => s.paid_at! <= older.paid_at!);
    expect(upTo.length).toBeLessThan(inYear.length);
    const view = await app.withTenant(T, (q) => readPaystubYear(q, older.id));
    expect(view?.yearToDate).toEqual({
      year: YEAR,
      paidCents: upTo.reduce((n, s) => n + s.net_cents, 0),
      stubs: upTo.length,
      zone: ZONE,
    });
    expect(view!.yearToDate.paidCents).toBeLessThan(EXPECTED_YTD);
  });

  it("labels a paid stub with the year it was paid and counts it in that year, not the year its week ends", async () => {
    const last = HERO_PAID[HERO_PAID.length - 1];
    // The seeded last stub is paid in YEAR; moved into the next local year, its week still ends in YEAR.
    expect(Number(localDateOf(last.paid_at!, ZONE).slice(0, 4))).toBe(YEAR);
    try {
      await write("UPDATE settlements SET paid_at = CAST($2 AS timestamptz) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        last.id,
        instantAt(`${YEAR + 1}-01-01`, 0, 30, ZONE),
      ]);
      const view = await app.withTenant(T, (q) => readPaystubYear(q, last.id));
      expect(view?.yearToDate).toEqual({ year: YEAR + 1, paidCents: last.net_cents, stubs: 1, zone: ZONE });
    } finally {
      await write("UPDATE settlements SET paid_at = CAST($2 AS timestamptz) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        last.id,
        last.paid_at,
      ]);
    }
    expect((await app.withTenant(T, (q) => readPaystubYear(q, last.id)))?.yearToDate.year).toBe(YEAR);
  });

  it("reads the paid time in the carrier's zone, not in UTC", async () => {
    const moved = HERO_PAID[0];
    const draft = await heroDraft();
    const ytd = async () => (await app.withTenant(T, (q) => readPaystubYear(q, draft.id)))!.yearToDate;
    const wasCounted = inYear.some((s) => s.id === moved.id);
    try {
      // Late on Dec 31 in the carrier's zone is already Jan 1 in UTC: it still counts in YEAR.
      const lateLocal = instantAt(`${YEAR}-12-31`, 23, 30, ZONE);
      expect(new Date(lateLocal).getUTCFullYear()).toBe(YEAR + 1);
      await write("UPDATE settlements SET paid_at = CAST($2 AS timestamptz) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        moved.id,
        lateLocal,
      ]);
      const late = await ytd();
      expect(late.paidCents).toBe(EXPECTED_YTD + (wasCounted ? 0 : moved.net_cents));
      // Just after midnight in the carrier's zone it belongs to the next year.
      await write("UPDATE settlements SET paid_at = CAST($2 AS timestamptz) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        moved.id,
        instantAt(`${YEAR + 1}-01-01`, 0, 30, ZONE),
      ]);
      const early = await ytd();
      expect(early.paidCents).toBe(EXPECTED_YTD - (wasCounted ? moved.net_cents : 0));
    } finally {
      await write("UPDATE settlements SET paid_at = CAST($2 AS timestamptz) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        moved.id,
        moved.paid_at,
      ]);
    }
    expect((await ytd()).paidCents).toBe(EXPECTED_YTD);
  });

  it("gives the agent the same two figures in keys that end in Cents", async () => {
    const out = await app.withTenant(T, (q) =>
      explainPaystub.run(q, { timeZone: ZONE } as never, { driverId: HERO.id, periodId: OPEN.id }, {} as never),
    );
    const result = out.result as Record<string, unknown>;
    expect(result.ytdPaidCents).toBe(EXPECTED_YTD);
    const view = await app.withTenant(T, async (q) => readPaystubYear(q, (await heroDraft()).id));
    expect(result.escrowBalanceCents).toBe(view!.escrow.balanceCents);
    expect(result.escrowAsOf).toBe("after_this_paystub");
  });

  it("reads nothing for another carrier's stub", async () => {
    const draft = await heroDraft();
    expect(await app.withTenant(other!.tenantId, (q) => readPaystubYear(q, draft.id))).toBeNull();
    expect(await app.withTenant(other!.tenantId, (q) => readSettlementRecord(q, draft.id))).toBeNull();
  });
});
