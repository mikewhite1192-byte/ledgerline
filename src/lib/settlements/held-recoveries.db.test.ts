import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { addAdvance, dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { bookPaidSettlement } from "./book";
import { runPayPeriod } from "./run";
import { readStoredLines, readStoredSettlement, recheckSettlement } from "./stored";

// Balances drawn down across two open pay weeks (D-090) against a real database, as the app's own
// role. One driver owes an advance (50000 plus a 500 fee) and a deficit (30000) and has an escrow
// schedule under its target; weeks W1 (the older) and W2 are both open and both drafted by "Run
// the week". The older draft takes and the newer one reads it as held, so whichever week is paid
// first, every cent of a recovery is booked once. Approval here is the approval's own pre-pay
// recheck (it must be clean) and the status move, then the booking, as the card executor does
// them. Every tenant made here is removed after each test.

const saved = structuredClone(flags);
// Monday November 2, 2026, 10:00 in Chicago (the fixture carrier's zone).
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const W1_START = "2026-11-02";
const W2_START = "2026-11-09";
const ADVANCE = 50_000;
const FEE = 500;
const OWED = ADVANCE + FEE;
const DEFICIT = 30_000;
const ESCROW_EACH = 10_000;
const ESCROW_TARGET = 15_000;

let admin: Db;
let app: Db;
let A: Fixture;

async function payConfig(capCents: number | null = null): Promise<void> {
  await admin.withTenant(A.tenantId, (q) =>
    q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, $2, 0, 50000, 5000, 5000)`,
      [randomUUID(), capCents],
    ),
  );
}

async function openWeek(start: string): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(A.tenantId, (q) =>
    q.execute(
      `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($2 AS date) + 6, 'open')`,
      [id, start],
    ),
  );
  return id;
}

// A pay item for DRV-1 on a day: tolls paid back (earnings) or another deduction.
async function item(kind: "reimbursement" | "other_deduction", day: string, cents: number): Promise<void> {
  await admin.withTenant(A.tenantId, (q) =>
    q.execute(
      `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date, item_ref, description)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'tolls', $4, CAST($5 AS date), $6, 'Tolls')`,
      [randomUUID(), A.driverId, kind, cents, day, `${kind}-${day}`],
    ),
  );
}

async function paidAdvance(): Promise<string> {
  const id = await addAdvance(admin, A, ADVANCE, "approved");
  await admin.withTenant(A.tenantId, (q) =>
    q.execute(
      `UPDATE advances SET status = 'paid', fee_cents = $2, paid_at = CAST('2026-11-02T15:30:00Z' AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id, FEE],
    ),
  );
  return id;
}

async function addDeficit(): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(A.tenantId, (q) =>
    q.execute(
      `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id, named_by,
         created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'A load with no payment record', 'ruling',
         CAST($4 AS uuid), CAST($5 AS uuid), CAST('2026-11-02T15:00:00Z' AS timestamptz))`,
      [id, A.driverId, DEFICIT, randomUUID(), A.memberId],
    ),
  );
  return id;
}

async function escrowSchedule(): Promise<void> {
  await admin.withTenant(A.tenantId, (q) =>
    q.execute(
      `INSERT INTO deduction_schedules (id, tenant_id, driver_id, kind, amount_cents, target_cents, description, active_from)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'escrow', $3, $4, 'Escrow', CAST('2026-01-01' AS date))`,
      [randomUUID(), A.driverId, ESCROW_EACH, ESCROW_TARGET],
    ),
  );
}

// The whole setup: two open weeks, each with 100000 of tolls paid back so there is room for every
// recovery, and the balances the test asks for.
async function setup(opts: { cap?: number | null; deficit?: boolean; escrow?: boolean } = {}) {
  await payConfig(opts.cap ?? null);
  const w1 = await openWeek(W1_START);
  const w2 = await openWeek(W2_START);
  await item("reimbursement", "2026-11-03", 100_000);
  await item("reimbursement", "2026-11-10", 100_000);
  const advance = await paidAdvance();
  const deficit = opts.deficit === false ? null : await addDeficit();
  if (opts.escrow !== false) await escrowSchedule();
  return { w1, w2, advance, deficit };
}

const runWeek = async (p: string) => expect((await runPayPeriod(app, A.session, p, new Date(NOW))).ok).toBe(true);

const stubOf = async (p: string) =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ id: string }>(
        "SELECT CAST(id AS text) AS id FROM settlements WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid)",
        [p],
      ),
    )
  )[0].id;

// What a stub's lines of one kind take, in cents, in line order.
const taken = async (s: string, kind: string) =>
  (await app.withTenant(A.tenantId, (q) => readStoredLines(q, s))).filter((l) => l.kind === kind).map((l) => -l.amountCents);

const linesOf = async (s: string) =>
  (await app.withTenant(A.tenantId, (q) => readStoredLines(q, s))).map((l) => ({
    kind: l.kind,
    amountCents: l.amountCents,
    sources: l.sources,
  }));

// The approval's pre-pay recheck must be clean; then the stub is approved and booked as paid.
async function pay(s: string): Promise<void> {
  const park = await app.withTenant(A.tenantId, async (q) => {
    const stored = await readStoredSettlement(q, s, false);
    if (!stored) throw new Error("no stub");
    return (await recheckSettlement(q, stored, await readStoredLines(q, s))).park;
  });
  expect(park).toBeNull();
  await admin.withTenant(A.tenantId, (q) =>
    q.execute("UPDATE settlements SET status = 'approved' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [s]),
  );
  expect(await app.withTenant(A.tenantId, (q) => bookPaidSettlement(q, s, new Date(NOW)))).toBe(true);
}

async function balances(advance: string, deficit: string | null) {
  return admin.withTenant(A.tenantId, async (q) => {
    const [a] = await q.query<{ recovered: string }>(
      "SELECT CAST(recovered_cents AS text) AS recovered FROM advances WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [advance],
    );
    const [d] = deficit
      ? await q.query<{ recovered: string; settled_in: string | null }>(
          `SELECT CAST(recovered_cents AS text) AS recovered, CAST(settled_in AS text) AS settled_in
             FROM driver_deficits WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [deficit],
        )
      : [null];
    const [e] = await q.query<{ escrow: string }>(
      "SELECT CAST(escrow_balance_cents AS text) AS escrow FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [A.driverId],
    );
    return {
      advance: Number(a.recovered),
      deficit: d ? Number(d.recovered) : null,
      settledIn: d ? d.settled_in : null,
      escrow: Number(e.escrow),
    };
  });
}

describe("recoveries held across two open weeks", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    flags.deficitRecovery = { enabled: true, startDate: "2026-11-02" };
    A = await makeTenant(admin, `held-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    await dropTenant(admin, A);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("lets only the older week take the advance, the deficit and the full escrow; the newer one tops escrow up to the target", async () => {
    const { w1, w2 } = await setup();
    await runWeek(w1);
    await runWeek(w2);
    const [s1, s2] = [await stubOf(w1), await stubOf(w2)];
    expect(await taken(s1, "advance_recovery")).toEqual([OWED]);
    expect(await taken(s1, "deficit_recovery")).toEqual([DEFICIT]);
    expect(await taken(s1, "escrow")).toEqual([ESCROW_EACH]);
    expect(await taken(s2, "advance_recovery")).toEqual([]);
    expect(await taken(s2, "deficit_recovery")).toEqual([]);
    expect(await taken(s2, "escrow")).toEqual([ESCROW_TARGET - ESCROW_EACH]);
  });

  it("books every cent once when the newer week is paid first", async () => {
    const { w1, w2, advance, deficit } = await setup();
    await runWeek(w1);
    await runWeek(w2);
    const [s1, s2] = [await stubOf(w1), await stubOf(w2)];
    await pay(s2);
    expect(await balances(advance, deficit)).toEqual({ advance: 0, deficit: 0, settledIn: null, escrow: ESCROW_TARGET - ESCROW_EACH });
    await pay(s1);
    expect(await balances(advance, deficit)).toEqual({ advance: OWED, deficit: DEFICIT, settledIn: s1, escrow: ESCROW_TARGET });
  });

  it("takes nothing already recovered when the newer week is rerun after the older is paid", async () => {
    const { w1, w2, advance, deficit } = await setup();
    await runWeek(w1);
    await runWeek(w2);
    const [s1, s2] = [await stubOf(w1), await stubOf(w2)];
    const held = await linesOf(s2);
    await pay(s1);
    expect(await balances(advance, deficit)).toEqual({ advance: OWED, deficit: DEFICIT, settledIn: s1, escrow: ESCROW_EACH });
    await runWeek(w2);
    expect(await stubOf(w2)).toBe(s2);
    expect(await linesOf(s2)).toEqual(held);
    await pay(s2);
    expect(await balances(advance, deficit)).toEqual({ advance: OWED, deficit: DEFICIT, settledIn: s1, escrow: ESCROW_TARGET });
  });

  it("lets the newer week take only what the older week's capped recovery leaves, in either pay order", async () => {
    const cap = 30_000;
    for (const order of ["older first", "newer first"] as const) {
      const { w1, w2, advance } = await setup({ cap, deficit: false, escrow: false });
      await runWeek(w1);
      await runWeek(w2);
      const [s1, s2] = [await stubOf(w1), await stubOf(w2)];
      expect(await taken(s1, "advance_recovery"), order).toEqual([cap]);
      expect(await taken(s2, "advance_recovery"), order).toEqual([OWED - cap]);
      for (const s of order === "older first" ? [s1, s2] : [s2, s1]) await pay(s);
      expect((await balances(advance, null)).advance, order).toBe(OWED);
      // A fresh carrier for the second order.
      await dropTenant(admin, A);
      A = await makeTenant(admin, `held-${randomUUID().slice(0, 8)}`);
    }
  });

  it("dates a shortfall carried from the older week past the newer week when the newer is paid first", async () => {
    const { w1, w2 } = await setup({ deficit: false, escrow: false });
    // Week one's deductions pass its earnings, so it ends short and carries the rest.
    await item("other_deduction", "2026-11-04", 150_000);
    await runWeek(w1);
    await runWeek(w2);
    const [s1, s2] = [await stubOf(w1), await stubOf(w2)];
    const carried = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ carry: string }>(
        "SELECT CAST(carry_forward_cents AS text) AS carry FROM settlements WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [s1],
      ),
    );
    expect(Number(carried[0].carry)).toBe(50_000);
    await pay(s2);
    await pay(s1);
    const items = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ item_date: string; amount: string }>(
        `SELECT CAST(item_date AS text) AS item_date, CAST(amount_cents AS text) AS amount
           FROM pay_items WHERE tenant_id = current_tenant_id() AND kind = 'carried_shortfall'`,
      ),
    );
    expect(items).toEqual([{ item_date: "2026-11-16", amount: "50000" }]);
  });

  it("dates a carried shortfall past a newer week that closed with no stub of this driver", async () => {
    const { w1, w2 } = await setup({ deficit: false, escrow: false });
    await item("other_deduction", "2026-11-04", 150_000);
    await runWeek(w1);
    // The newer week was paid for the other drivers and closed; this driver had no stub in it.
    await admin.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE settlement_periods SET status = 'paid' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [w2]),
    );
    await pay(await stubOf(w1));
    const items = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ item_date: string }>(
        `SELECT CAST(item_date AS text) AS item_date
           FROM pay_items WHERE tenant_id = current_tenant_id() AND kind = 'carried_shortfall'`,
      ),
    );
    expect(items).toEqual([{ item_date: "2026-11-16" }]);
  });
});
