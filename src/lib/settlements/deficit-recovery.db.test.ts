import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { dedupeKey } from "../agent/gateway/store/proposals";
import { DEFICIT_LIMIT, getDriverDeficits } from "../agent/gateway/tools/read/get-driver-deficits";
import { readAdvanceInput, readSettlementInput } from "../data/read";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { addAdvance, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { bookPaidSettlement } from "./book";
import { runPayPeriod } from "./run";
import { readStoredLines, readStoredSettlement, recheckSettlement } from "./stored";

// Deficit recovery on pay day (S6b) against a real database, as the app's own role. A paid stub
// adds what each deficit recovery line took to its deficit and settles the deficit by that stub only
// once it is whole; a line that finds no open deficit of that driver rolls the whole booking back;
// a stub with a deficit line waits while the switch is off and writes nothing; a pay run for a week
// that ends before the switch's start date reads no deficits. The pay run also leaves out an
// advance with a card pull-back still in flight, and a stub that recovers one waits unbooked. The deficits read shows one driver's deficits,
// open and settled, to its own carrier only, with what is owed summed over all of them however many
// it lists. Every tenant made here is removed after each test.

const saved = structuredClone(flags);
// Monday November 2, 2026, 10:00 in Chicago (the fixture carrier's zone), the switch's start day.
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const EXTRAS = { screen: null, limit: null };

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;

async function payConfig(f: Fixture, capCents: number | null = null): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, $2, 0, 50000, 5000, 5000)`,
      [id, capCents],
    ),
  );
  return id;
}

async function period(f: Fixture, start: string, status: "open" | "approved" = "approved"): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($2 AS date) + 6, $3)`,
      [id, start, status],
    ),
  );
  return id;
}

type Line = [kind: string, amountCents: number, sources: { table: string; id: string }[]];

// An approved stub for DRV-1: a load's pay plus the lines given, the totals worked from them.
async function stub(f: Fixture, periodId: string, config: string, lines: Line[]): Promise<string> {
  const id = randomUUID();
  const all: Line[] = [["load_pay", 100_000, [{ table: "loads", id: randomUUID() }]], ...lines];
  const deductions = -lines.reduce((n, [, a]) => n + a, 0);
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
         deductions_cents, net_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
         'approved', 100000, $5, $6)`,
      [id, periodId, f.driverId, config, deductions, 100_000 - deductions],
    );
    let seq = 0;
    for (const [kind, amount, sources] of all) {
      seq += 1;
      await q.execute(
        `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $4, $5, CAST($6 AS jsonb))`,
        [randomUUID(), id, seq, kind, amount, JSON.stringify(sources)],
      );
    }
  });
  return id;
}

// A deficit a person named (source 'ruling', so no proposal is needed), booked at a fixed time.
async function addDeficit(
  f: Fixture,
  amountCents: number,
  over: { driverId?: string; createdAt?: string; note?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id, named_by,
         created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, 'ruling', CAST($5 AS uuid),
         CAST($6 AS uuid), CAST($7 AS timestamptz))`,
      [
        id,
        over.driverId ?? f.driverId,
        amountCents,
        over.note ?? "Card 4417 load with no payment record",
        randomUUID(),
        f.memberId,
        over.createdAt ?? "2026-11-02T15:00:00Z",
      ],
    ),
  );
  return id;
}

const owedLine = (deficitId: string, cents: number): Line => [
  "deficit_recovery",
  -cents,
  [{ table: "driver_deficits", id: deficitId }],
];

const deficitRow = async (id: string, f: Fixture = A) =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<{ recovered_cents: string; settled_in: string | null }>(
        `SELECT CAST(recovered_cents AS text) AS recovered_cents, CAST(settled_in AS text) AS settled_in
           FROM driver_deficits WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0];

const stubStatus = async (id: string) =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ status: string }>("SELECT status FROM settlements WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]),
    )
  )[0]?.status;

const book = (settlementId: string) => app.withTenant(A.tenantId, (q) => bookPaidSettlement(q, settlementId, new Date(NOW)));

// A paid advance for DRV-1 asked for on the start day.
async function paidAdvance(f: Fixture, cents: number): Promise<string> {
  const id = await addAdvance(admin, f, cents, "approved");
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE advances SET status = 'paid', paid_at = CAST('2026-11-02T15:30:00Z' AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    ),
  );
  return id;
}

// A card pull-back row against an advance, with the proposal it belongs to, in the status given.
async function addPull(f: Fixture, advanceId: string, status: "issuing" | "pulled" | "unknown"): Promise<string> {
  const [conversation, turn, decision, proposal, trace, pull] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const args = { driverId: f.driverId, advanceId, reason: "driver_request", requestedCents: 20_000 };
  const at = new Date(NOW - 3_600_000).toISOString();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute("INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)", [
      conversation,
      f.session.sub,
    ]);
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Take it off the card', 'done', $3,
         CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
      [turn, conversation, trace, at],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark', 'propose_card_pullback',
         'propose', 'allowed', 'ok', 1)`,
      [decision, turn, trace],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
         created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'card_pullback',
         'advances', CAST($4 AS uuid), 20000, 'in', 'Pull money back off a fuel card', CAST($5 AS jsonb), 'not_given',
         CAST($6 AS uuid), $7, $8, CAST($9 AS timestamptz), CAST($9 AS timestamptz))`,
      [proposal, conversation, turn, advanceId, JSON.stringify(args), decision, dedupeKey("card_pullback", advanceId, args), trace, at],
    );
    await q.execute(
      `INSERT INTO card_pullbacks (id, tenant_id, driver_id, card_id, proposal_id, advance_id, reason, requested_cents,
         balance_cents, pull_cents, shortfall_cents, status, pulled_at)
       SELECT CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), c.id, CAST($3 AS uuid), CAST($4 AS uuid),
              'driver_request', 20000, 25000, 20000, 0, $5,
              CASE WHEN $5 = 'pulled' THEN CAST($6 AS timestamptz) END
         FROM driver_cards c
        WHERE c.tenant_id = current_tenant_id() AND c.driver_id = CAST($2 AS uuid) AND c.is_default`,
      [pull, f.driverId, proposal, advanceId, status, at],
    );
  });
  return pull;
}

const setPull = (id: string, status: "unknown" | "failed") =>
  admin.withTenant(A.tenantId, (q) =>
    q.execute("UPDATE card_pullbacks SET status = $2 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id, status]),
  );

const ctx = (f: Fixture) => ({ now: new Date(NOW), timeZone: "America/Chicago", session: f.session }) as never;

describe("deficit recovery on pay day", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    flags.deficitRecovery = { enabled: true, startDate: "2026-11-02" };
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `deficit-a-${tag}`);
    B = await makeTenant(admin, `deficit-b-${tag}`);
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    for (const f of [A, B]) {
      try {
        // The pulls first: the app role has no DELETE, and they name advances and proposals.
        if (f) await admin.withTenant(f.tenantId, (q) => q.execute("DELETE FROM card_pullbacks WHERE tenant_id = current_tenant_id()"));
      } finally {
        await dropTenant(admin, f);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("adds a part to the deficit, and settles it by the stub that makes it whole", async () => {
    const config = await payConfig(A);
    const d = await addDeficit(A, 10_000);
    const first = await stub(A, await period(A, "2026-11-02"), config, [owedLine(d, 4_000)]);
    expect(await book(first)).toBe(true);
    expect(await deficitRow(d)).toEqual({ recovered_cents: "4000", settled_in: null });
    const second = await stub(A, await period(A, "2026-11-09"), config, [owedLine(d, 6_000)]);
    expect(await book(second)).toBe(true);
    expect(await deficitRow(d)).toEqual({ recovered_cents: "10000", settled_in: second });
    // A second confirm of a paid stub changes nothing.
    expect(await book(second)).toBe(false);
    expect(await deficitRow(d)).toEqual({ recovered_cents: "10000", settled_in: second });
  });

  it("takes a whole deficit in one stub and settles it there", async () => {
    const config = await payConfig(A);
    const [d1, d2] = [await addDeficit(A, 3_000), await addDeficit(A, 2_500)];
    const s = await stub(A, await period(A, "2026-11-02"), config, [owedLine(d1, 3_000), owedLine(d2, 1_000)]);
    expect(await book(s)).toBe(true);
    expect(await deficitRow(d1)).toEqual({ recovered_cents: "3000", settled_in: s });
    expect(await deficitRow(d2)).toEqual({ recovered_cents: "1000", settled_in: null });
    expect(await stubStatus(s)).toBe("paid");
  });

  it("rolls the whole booking back when a line finds no open deficit of that driver", async () => {
    const config = await payConfig(A);
    const open = await addDeficit(A, 5_000);
    const others = await addDeficit(A, 5_000, { driverId: A.otherDriverId });
    const s = await stub(A, await period(A, "2026-11-02"), config, [owedLine(open, 2_000), owedLine(others, 2_000)]);
    await expect(book(s)).rejects.toThrow("a deficit recovery found no open deficit");
    expect(await stubStatus(s)).toBe("approved");
    expect(await deficitRow(open)).toEqual({ recovered_cents: "0", settled_in: null });
    expect(await deficitRow(others)).toEqual({ recovered_cents: "0", settled_in: null });

    // A deficit already settled by an earlier stub is not open either.
    const done = await addDeficit(A, 1_000);
    const paid = await stub(A, await period(A, "2026-11-09"), config, [owedLine(done, 1_000)]);
    expect(await book(paid)).toBe(true);
    const again = await stub(A, await period(A, "2026-11-16"), config, [owedLine(open, 1_000), owedLine(done, 1_000)]);
    await expect(book(again)).rejects.toThrow("a deficit recovery found no open deficit");
    expect(await stubStatus(again)).toBe("approved");
    expect(await deficitRow(open)).toEqual({ recovered_cents: "0", settled_in: null });
    expect(await deficitRow(done)).toEqual({ recovered_cents: "1000", settled_in: paid });
  });

  it("refuses to take back more than is owed, writing nothing", async () => {
    const config = await payConfig(A);
    const d = await addDeficit(A, 2_000);
    const s = await stub(A, await period(A, "2026-11-02"), config, [owedLine(d, 2_500)]);
    expect(await sqlStateOf(book(s))).toBe("23514");
    expect(await stubStatus(s)).toBe("approved");
    expect(await deficitRow(d)).toEqual({ recovered_cents: "0", settled_in: null });
  });

  it("leaves a stub with a deficit line unbooked while the switch is off, writing nothing", async () => {
    const config = await payConfig(A);
    const d = await addDeficit(A, 2_000);
    const s = await stub(A, await period(A, "2026-11-02"), config, [owedLine(d, 2_000)]);
    flags.deficitRecovery.enabled = false;
    await expect(book(s)).rejects.toThrow("deficit recovery is off");
    expect(await stubStatus(s)).toBe("approved");
    expect(await deficitRow(d)).toEqual({ recovered_cents: "0", settled_in: null });
    // A stub with no deficit line books as before with the switch off.
    const plain = await stub(A, await period(A, "2026-11-09"), config, []);
    expect(await book(plain)).toBe(true);
  });

  it("reads deficits into the pay run only for a week ending on or after the start date, with the switch on", async () => {
    await payConfig(A);
    const d = await addDeficit(A, 2_000, { createdAt: "2026-10-27T15:00:00Z" });
    const before = await period(A, "2026-10-26");
    const after = await period(A, "2026-11-02");
    const read = (p: string) => app.withTenant(A.tenantId, (q) => readSettlementInput(q, A.driverId, p));
    expect((await read(before)).deficits).toEqual([]);
    expect((await read(after)).deficits).toEqual([
      {
        id: d,
        driverId: A.driverId,
        amountCents: 2_000,
        recoveredCents: 0,
        createdAt: "2026-10-27T15:00:00.000Z",
        createdOn: "2026-10-27",
        sourceKind: "ruling",
        note: "Card 4417 load with no payment record",
      },
    ]);
    flags.deficitRecovery.enabled = false;
    expect((await read(after)).deficits).toEqual([]);
  });

  it("leaves out of the pay run an advance with a card pull-back still in flight, and only that one", async () => {
    await payConfig(A);
    const held = await paidAdvance(A, 20_000);
    const plain = await paidAdvance(A, 15_000);
    const p = await period(A, "2026-11-02");
    const ids = async () =>
      (await app.withTenant(A.tenantId, (q) => readSettlementInput(q, A.driverId, p))).advances.map((a) => a.id).sort();
    const pull = await addPull(A, held, "issuing");
    expect(await ids()).toEqual([plain]);
    await setPull(pull, "unknown");
    expect(await ids()).toEqual([plain]);
    // The advance check still counts it: it is owed until the pull is read back.
    const ask = await app.withTenant(A.tenantId, (q) => readAdvanceInput(q, A.driverId, "2026-11-02T16:00:00Z", 5_000));
    expect(ask.advances.map((a) => a.id)).toContain(held);
    // A pull that failed takes nothing, so the advance is back in the run.
    await setPull(pull, "failed");
    expect(await ids()).toEqual([held, plain].sort());
    // A pull read back as pulled is recorded on the advance itself, so the advance stays in the run.
    await addPull(A, plain, "pulled");
    expect(await ids()).toEqual([held, plain].sort());
    // Another carrier's run sees none of it.
    await payConfig(B);
    const pB = await period(B, "2026-11-02");
    expect((await app.withTenant(B.tenantId, (q) => readSettlementInput(q, B.driverId, pB))).advances).toEqual([]);
  });

  it("leaves a stub that recovers an advance with a card pull-back still in flight unbooked, writing nothing", async () => {
    const config = await payConfig(A);
    const held = await paidAdvance(A, 20_000);
    const recovered = async () =>
      (
        await admin.withTenant(A.tenantId, (q) =>
          q.query<{ n: string }>(
            "SELECT CAST(recovered_cents AS text) AS n FROM advances WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
            [held],
          ),
        )
      )[0]?.n;
    const s = await stub(A, await period(A, "2026-11-02"), config, [["advance_recovery", -5_000, [{ table: "advances", id: held }]]]);
    const pull = await addPull(A, held, "issuing");
    await expect(book(s)).rejects.toThrow("an advance recovery found no paid advance");
    expect(await stubStatus(s)).toBe("approved");
    expect(await recovered()).toBe("0");
    await setPull(pull, "unknown");
    await expect(book(s)).rejects.toThrow("an advance recovery found no paid advance");
    expect(await stubStatus(s)).toBe("approved");
    expect(await recovered()).toBe("0");
    // Once the pull is no longer live (it failed, taking nothing), the same stub books.
    await setPull(pull, "failed");
    expect(await book(s)).toBe(true);
    expect(await stubStatus(s)).toBe("paid");
    expect(await recovered()).toBe("5000");
  });

  it("shows one driver's deficits, open and settled, to its own carrier only", async () => {
    const config = await payConfig(A);
    const older = await addDeficit(A, 3_000, { createdAt: "2026-10-30T15:00:00Z", note: "Card 4417 pull-back short" });
    const newer = await addDeficit(A, 5_000);
    await addDeficit(A, 9_000, { driverId: A.otherDriverId });
    const s = await stub(A, await period(A, "2026-11-02"), config, [owedLine(older, 3_000), owedLine(newer, 1_500)]);
    expect(await book(s)).toBe(true);
    const out = await app.withTenant(A.tenantId, (q) => getDriverDeficits.run(q, ctx(A), { driverId: A.driverId }, EXTRAS));
    expect(out.result).toEqual({
      driverId: A.driverId,
      owedCents: 3_500,
      truncated: false,
      rows: [
        {
          id: older,
          bookedOn: "2026-10-30",
          sourceKind: "ruling",
          note: "Card 4417 pull-back short",
          amountCents: 3_000,
          recoveredCents: 3_000,
          stillOwedCents: 0,
          status: "settled",
          settledIn: s,
          proposalId: null,
        },
        {
          id: newer,
          bookedOn: "2026-11-02",
          sourceKind: "ruling",
          note: "Card 4417 load with no payment record",
          amountCents: 5_000,
          recoveredCents: 1_500,
          stillOwedCents: 3_500,
          status: "open",
          settledIn: null,
          proposalId: null,
        },
      ],
    });
    const fromB = await app.withTenant(B.tenantId, (q) => getDriverDeficits.run(q, ctx(B), { driverId: A.driverId }, EXTRAS));
    expect(fromB.result).toEqual({ driverId: A.driverId, owedCents: 0, truncated: false, rows: [] });
    flags.deficitRecovery.enabled = false;
    await expect(
      app.withTenant(A.tenantId, (q) => getDriverDeficits.run(q, ctx(A), { driverId: A.driverId }, EXTRAS)),
    ).rejects.toThrow("switched off");
  });

  it("sums what is owed over every deficit, and says so when the list shows only the oldest ones", async () => {
    // n deficits of one dollar each for DRV-1, a minute apart, after the ones already there.
    const many = (n: number, from: number) =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id, named_by,
             created_at)
           SELECT gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 100, 'Card 4417 load with no payment record',
                  'ruling', gen_random_uuid(), CAST($2 AS uuid),
                  CAST('2026-11-02T15:00:00Z' AS timestamptz) + make_interval(mins => i)
             FROM generate_series($3::int, $3::int + $4::int - 1) AS i`,
          [A.driverId, A.memberId, from, n],
        ),
      );
    const read = async () =>
      (await app.withTenant(A.tenantId, (q) => getDriverDeficits.run(q, ctx(A), { driverId: A.driverId }, EXTRAS))).result as {
        owedCents: number;
        truncated: boolean;
        rows: unknown[];
      };
    await many(DEFICIT_LIMIT, 0);
    const full = await read();
    expect({ owed: full.owedCents, truncated: full.truncated, shown: full.rows.length }).toEqual({
      owed: DEFICIT_LIMIT * 100,
      truncated: false,
      shown: DEFICIT_LIMIT,
    });
    // One more, the newest: the list still shows the oldest DEFICIT_LIMIT, and the total counts it.
    await many(1, DEFICIT_LIMIT);
    const over = await read();
    expect({ owed: over.owedCents, truncated: over.truncated, shown: over.rows.length }).toEqual({
      owed: (DEFICIT_LIMIT + 1) * 100,
      truncated: true,
      shown: DEFICIT_LIMIT,
    });
  });

  it("takes from a deficit only what the driver's other approved, unbooked stubs leave, and parks a draft that took the same part", async () => {
    await payConfig(A, 6_000);
    const d = await addDeficit(A, 10_000);
    // A carrier has one open week at a time: week one is run while open, then week two opens.
    const [w1, w2] = [await period(A, "2026-11-02", "open"), await period(A, "2026-11-09")];
    const openOnly = (p: string) =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute(
          "UPDATE settlement_periods SET status = CASE WHEN id = CAST($1 AS uuid) THEN 'open' ELSE 'approved' END WHERE tenant_id = current_tenant_id()",
          [p],
        ),
      );
    for (const day of ["2026-11-03", "2026-11-10"]) {
      await admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date, item_ref, description)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'reimbursement', 'tolls', 100000,
             CAST($3 AS date), $4, 'Tolls')`,
          [randomUUID(), A.driverId, day, `tolls-${day}`],
        ),
      );
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
    const taken = async (s: string) =>
      (await app.withTenant(A.tenantId, (q) => readStoredLines(q, s)))
        .filter((l) => l.kind === "deficit_recovery")
        .map((l) => -l.amountCents);
    const recheck = (s: string) =>
      app.withTenant(A.tenantId, async (q) => {
        const stored = await readStoredSettlement(q, s, false);
        if (!stored) throw new Error("no stub");
        return (await recheckSettlement(q, stored, await readStoredLines(q, s))).park;
      });
    const approve = (s: string) =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute("UPDATE settlements SET status = 'approved' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [s]),
      );

    // Both weeks drafted while neither is approved: each takes the cap from the same deficit.
    await runWeek(w1);
    await openOnly(w2);
    await runWeek(w2);
    const [s1, s2] = [await stubOf(w1), await stubOf(w2)];
    expect(await taken(s1)).toEqual([6_000]);
    expect(await taken(s2)).toEqual([6_000]);
    expect(await recheck(s2)).toBeNull();

    // Week one is approved; its payout can go out before it books. Week two's recheck now reads
    // only 4000 left, so week two parks instead of taking the same part twice, and week one's own
    // recheck (its own stub left out) stays clean.
    await approve(s1);
    expect(await recheck(s2)).toBe("line_amount_changed");
    expect(await recheck(s1)).toBeNull();

    // A rerun of week two takes only what is left, and both rechecks hold once it is approved too.
    await runWeek(w2);
    expect(await stubOf(w2)).toBe(s2);
    expect(await taken(s2)).toEqual([4_000]);
    expect(await recheck(s2)).toBeNull();
    await approve(s2);
    expect(await recheck(s1)).toBeNull();
    expect(await recheck(s2)).toBeNull();

    // Booked in either order, the deficit ends whole and never over.
    expect(await book(s2)).toBe(true);
    expect(await deficitRow(d)).toEqual({ recovered_cents: "4000", settled_in: null });
    expect(await book(s1)).toBe(true);
    expect(await deficitRow(d)).toEqual({ recovered_cents: "10000", settled_in: s1 });
  });

  it("counts an approved stub's hold as taken in the pay read, never past the amount, and fails on a line it cannot read", async () => {
    const config = await payConfig(A);
    const d = await addDeficit(A, 5_000);
    const other = await addDeficit(A, 5_000, { createdAt: "2026-11-02T15:30:00Z" });
    const later = await period(A, "2026-11-16");
    const owed = async () =>
      (await app.withTenant(A.tenantId, (q) => readSettlementInput(q, A.driverId, later))).deficits.map((x) => [
        x.id,
        x.recoveredCents,
      ]);
    // Two approved stubs on other weeks hold 7000 on a 5000 deficit (both approved before this
    // read existed): the read counts it whole, never past its amount.
    await stub(A, await period(A, "2026-11-02"), config, [owedLine(d, 3_000)]);
    await stub(A, await period(A, "2026-11-09"), config, [owedLine(d, 4_000)]);
    expect(await owed()).toEqual([
      [d, 5_000],
      [other, 0],
    ]);
    // A held line that does not cite exactly one deficit fails the read.
    await stub(A, await period(A, "2026-11-23"), config, [
      ["deficit_recovery", -1_000, [{ table: "driver_deficits", id: d }, { table: "driver_deficits", id: other }]],
    ]);
    await expect(owed()).rejects.toThrow("a held deficit recovery line does not cite one deficit");
  });
});
