import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgDb } from "@/lib/db/pg";
import { adminUrl, appUrl } from "@/lib/db/test-urls";
import type { Db, Queryable } from "@/lib/db/types";
import { loaded } from "./loaded";
import { readMoneyFlow } from "./money-flow";

// Home's money in and out against a real database, as the app's role: the last four pay weeks
// that have started, oldest first, with customer payments by the day received and paid paystubs by
// the carrier-local day paid (Chicago here). Drafts count for nothing, another carrier's money
// never shows, and a database that cannot be reached reads as unavailable, never as zero. Two
// tenants, removed after.

const A = randomUUID();
const B = randomUUID();
const TODAY = "2026-11-03";

let admin: Db;
let app: Db;

type Ids = { customer: string; driver: string; payConfig: string; periods: Map<string, string> };

async function seed(id: string, timezone: string, weeks: readonly string[]): Promise<Ids> {
  const ids: Ids = { customer: randomUUID(), driver: randomUUID(), payConfig: randomUUID(), periods: new Map() };
  await admin.withTenant(id, async (q) => {
    const tag = id.slice(0, 8);
    await q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
      `home-flow-${tag}`,
      `Carrier ${tag}`,
      timezone,
    ]);
    await q.execute(
      `INSERT INTO customers (id, tenant_id, code, name, terms_days, city, state)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'HF-1', 'Harbor Foods', 30, 'Dayton', 'OH')`,
      [ids.customer],
    );
    await q.execute(
      `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
         per_mile_cents, active_from)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'AG-1', 'Ana', 'Rivera', $2, 'company', 'per_mile', 60,
         CAST('2026-01-05' AS date))`,
      [ids.driver, `driver@${tag}.example`],
    );
    await q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 0, 0, 0, 0)`,
      [ids.payConfig],
    );
    for (const start of weeks) {
      const period = randomUUID();
      ids.periods.set(start, period);
      await q.execute(
        `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($2 AS date) + 6, 'open')`,
        [period, start],
      );
    }
  });
  return ids;
}

async function payment(q: Queryable, ids: Ids, receivedOn: string, cents: number): Promise<void> {
  await q.execute(
    `INSERT INTO customer_payments (id, tenant_id, customer_id, received_on, amount_cents, method, payment_ref, source)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS date), $4, 'ach', $5, 'seed')`,
    [randomUUID(), ids.customer, receivedOn, cents, `PAY-${randomUUID().slice(0, 8)}`],
  );
}

// A settlement for the week starting `week`; paidAt null keeps it a draft.
async function paystub(q: Queryable, ids: Ids, week: string, netCents: number, paidAt: string | null): Promise<void> {
  await q.execute(
    `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
       deductions_cents, net_cents, paid_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5,
       $6, 0, $6, CAST($7 AS timestamptz))`,
    [randomUUID(), ids.periods.get(week) ?? null, ids.driver, ids.payConfig, paidAt ? "paid" : "draft", netCents, paidAt],
  );
}

describe("Home's money in and out by pay week", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    // Six weeks: the oldest is past the four shown, and the newest has not started on Nov 3.
    const a = await seed(A, "America/Chicago", [
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
    ]);
    await admin.withTenant(A, async (q) => {
      await payment(q, a, "2026-10-06", 11_111);
      await payment(q, a, "2026-10-20", 100_000);
      // The last day of a week and the first of the next.
      await payment(q, a, "2026-10-25", 50_000);
      await payment(q, a, "2026-10-26", 7_000);
      await payment(q, a, "2026-11-10", 22_222);
      // Paid at 10 PM on Oct 25 in Chicago, which is already Oct 26 in UTC: it counts in the week of Oct 19.
      await paystub(q, a, "2026-10-12", 123_456, "2026-10-26T03:00:00Z");
      await paystub(q, a, "2026-10-19", 65_432, "2026-10-30T15:00:00Z");
      // A draft has paid nothing.
      await paystub(q, a, "2026-10-26", 99_999, null);
    });
    const b = await seed(B, "America/New_York", ["2026-10-19"]);
    await admin.withTenant(B, async (q) => {
      await payment(q, b, "2026-10-20", 999);
      await paystub(q, b, "2026-10-19", 888, "2026-10-21T15:00:00Z");
    });
  });

  afterAll(async () => {
    for (const id of [A, B]) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("returns the last four started weeks, oldest first, in whole cents", async () => {
    expect(await app.withTenant(A, (q) => readMoneyFlow(q, TODAY))).toEqual([
      { start: "2026-10-12", end: "2026-10-18", inCents: 0, outCents: 0 },
      { start: "2026-10-19", end: "2026-10-25", inCents: 150_000, outCents: 123_456 },
      { start: "2026-10-26", end: "2026-11-01", inCents: 7_000, outCents: 65_432 },
      { start: "2026-11-02", end: "2026-11-08", inCents: 0, outCents: 0 },
    ]);
  });

  it("never shows another carrier's money", async () => {
    expect(await app.withTenant(B, (q) => readMoneyFlow(q, TODAY))).toEqual([
      { start: "2026-10-19", end: "2026-10-25", inCents: 999, outCents: 888 },
    ]);
  });

  it("reads a carrier with no pay weeks as an empty chart", async () => {
    expect(await app.withTenant(randomUUID(), (q) => readMoneyFlow(q, TODAY))).toEqual([]);
  });

  it("reads a database that cannot be reached as unavailable, never as zero", async () => {
    const url = new URL(appUrl());
    // Port 1 refuses every connection.
    url.port = "1";
    const down = createPgDb({ connectionString: url.toString() });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await loaded("money flow", () => down.withTenant(A, (q) => readMoneyFlow(q, TODAY)))).toEqual({
        ok: false,
      });
    } finally {
      log.mockRestore();
      await down.close();
    }
  });
});
