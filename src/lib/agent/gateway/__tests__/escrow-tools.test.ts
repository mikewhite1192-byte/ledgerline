import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { DUE_SQL } from "../../../escrow/due";
import { DRIVER_ESCROW_SQL, DRIVER_RELEASES_SQL } from "../../../escrow/read";
import { instantAt } from "../../../seed/calendar";
import { callTool } from "../index";
import type { GatewayContext } from "../types";
import { context, fixedClock, type Handler, type Row } from "./fake-db";
import { blueRidgePlan, PLAN_ANCHOR, planDb } from "./plan-db";

// The three escrow release tools over the synthetic Blue Ridge plan, with the hero driver read as
// terminated by a handler: switched off they refuse before reading a record; on, the reads work
// on the carrier's local date, and the propose tool drafts exactly the balance for a person to
// approve, refusing every other amount, an amount over the cap, an active driver, a driver with a
// live release and a balance date that is not today. The plan's own departed driver (seed
// terminated-plan.ts) is due on the plan alone, and their statement matches. No tool writes
// anything but the gateway's own decision row. No database, no clock, no network.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const hero = plan.rows.drivers.find((d) => d.code === plan.carrier.heroCode)!;
const departed = plan.rows.drivers.find((d) => d.active_to !== null)!;
const ctx: GatewayContext = context({ now: new Date(instantAt(PLAN_ANCHOR, 12, 0, zone)), timeZone: zone });
const saved = structuredClone(flags.escrowRelease);
const savedPayouts = flags.payoutsEnabled;

const call = (name: string, args: unknown) => ({ id: "call-1", name, argumentsJson: JSON.stringify(args) });

// The hero as of the anchor: last active on activeTo with this balance, and these releases.
function heroAs(activeTo: string | null, balanceCents: number, releases: Row[] = []): Handler {
  return (sql, params) => {
    if (sql === DRIVER_ESCROW_SQL) {
      return params[0] === hero.id
        ? [{ id: hero.id, code: hero.code, active_from: hero.active_from, active_to: activeTo, escrow_balance_cents: balanceCents }]
        : [];
    }
    if (sql === DRIVER_RELEASES_SQL) return params[0] === hero.id ? releases : [];
    return undefined;
  };
}

async function run(name: string, args: unknown, extra?: Handler, over: Partial<GatewayContext> = {}) {
  const db = planDb(plan, extra);
  const out = await callTool({ ...ctx, ...over }, call(name, args), { db, clock: fixedClock });
  return { out, db };
}

function wroteNothing(db: ReturnType<typeof planDb>) {
  const writes = db.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.sql));
  expect(writes.map((s) => s.sql.slice(0, 40))).toEqual(["INSERT INTO gateway_decisions"].map((p) => expect.stringContaining(p)));
}

function switchesOn() {
  flags.escrowRelease.enabled = true;
  flags.escrowRelease.armed = true;
  flags.payoutsEnabled = true;
}

afterEach(() => {
  flags.escrowRelease = structuredClone(saved);
  flags.payoutsEnabled = savedPayouts;
});

const proposeArgs = { driverId: hero.id, amountCents: 100_000, balanceAsOf: PLAN_ANCHOR };

describe("escrow release tools switched off", () => {
  it.each([
    ["list_escrow_releases_due", {}],
    ["get_escrow_statement", { driverId: hero.id }],
    ["propose_escrow_release", proposeArgs],
  ])("%s refuses as disabled before reading a record, with one decision row", async (name, args) => {
    expect(flags.escrowRelease.enabled).toBe(false);
    const { out, db } = await run(name, args, heroAs("2026-07-01", 100_000));
    expect(out).toMatchObject({ decision: "blocked", reason: "disabled" });
    expect(db.decisions).toHaveLength(1);
    for (const st of db.statements) expect(st.sql).not.toMatch(/FROM (drivers|escrow_releases|settlements)\b/);
  });
});

describe("list_escrow_releases_due", () => {
  it("asks for the drivers last active ninety days before the carrier's own date, and writes nothing", async () => {
    switchesOn();
    let cutoff: unknown = null;
    const due: Handler = (sql, params) => {
      if (sql !== DUE_SQL) return undefined;
      cutoff = params[0];
      return [{ id: hero.id, code: hero.code, active_to: "2026-08-04", escrow_balance_cents: 100_000 }];
    };
    // 03:30 UTC on November 3 is still November 2 in the carrier's zone.
    const { out, db } = await run("list_escrow_releases_due", {}, due, { now: new Date("2026-11-03T03:30:00.000Z") });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(cutoff).toBe("2026-08-04");
    expect(out.result).toEqual({
      asOf: "2026-11-02",
      max: 50,
      truncated: false,
      drivers: [{ driverId: hero.id, driverCode: hero.code, lastActiveDay: "2026-08-04", daysSince: 90, balanceCents: 100_000 }],
    });
    wroteNothing(db);
  });

  it("lists the plan's departed driver with their balance once the release switch is on", async () => {
    flags.escrowRelease.enabled = true;
    const { out, db } = await run("list_escrow_releases_due", {});
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.result).toEqual({
      asOf: PLAN_ANCHOR,
      max: 50,
      truncated: false,
      drivers: [{ driverId: departed.id, driverCode: "BR-D26", lastActiveDay: "2026-07-26", daysSince: 99, balanceCents: 30_000 }],
    });
    wroteNothing(db);
  });

  it("is offered to the auditor and refused to the triage role", async () => {
    switchesOn();
    const { out } = await run("list_escrow_releases_due", {}, undefined, { role: "auditor" });
    expect(out).toMatchObject({ decision: "allowed" });
    const triage = await run("list_escrow_releases_due", {}, undefined, { role: "triage" });
    expect(triage.out).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
  });
});

describe("get_escrow_statement", () => {
  it("reports a balance its paid weeks do not add up to as not matching, and corrects nothing", async () => {
    switchesOn();
    // The hero's three paid weeks each withheld the $100 step, while the stored balance reads
    // $1,000 (the seed's opening balance has no paid weeks behind it).
    const { out, db } = await run("get_escrow_statement", { driverId: hero.id }, heroAs("2026-07-01", 100_000));
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.result).toMatchObject({
      found: true,
      driverId: hero.id,
      terminated: true,
      asOf: PLAN_ANCHOR,
      openingCents: 0,
      withheldCents: 30_000,
      closingCents: 30_000,
      balanceCents: 100_000,
      matches: false,
      openRelease: null,
      linesTotal: 3,
    });
    wroteNothing(db);
  });

  it("matches the plan's departed driver: three paid weeks, the full step each, nothing released", async () => {
    flags.escrowRelease.enabled = true;
    const { out, db } = await run("get_escrow_statement", { driverId: departed.id });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const weeks = plan.rows.settlements
      .filter((s) => s.driver_id === departed.id)
      .map((s) => ({ s, p: plan.rows.settlement_periods.find((p) => p.id === s.period_id)! }))
      .sort((a, b) => (a.p.period_start < b.p.period_start ? -1 : 1));
    expect(out.result).toEqual({
      found: true,
      driverId: departed.id,
      driverCode: "BR-D26",
      firstActiveDay: "2025-07-07",
      lastActiveDay: "2026-07-26",
      terminated: true,
      asOf: PLAN_ANCHOR,
      openingCents: 0,
      withheldCents: 30_000,
      chargesCents: 0,
      releasedCents: 0,
      closingCents: 30_000,
      balanceCents: 30_000,
      matches: true,
      openRelease: null,
      linesTotal: 3,
      lines: weeks.map(({ s, p }) => ({
        kind: "withheld",
        settlementId: s.id,
        periodStart: p.period_start,
        periodEnd: p.period_end,
        withheldCents: 10_000,
        chargesCents: 0,
      })),
    });
    expect(weeks.map(({ p }) => p.period_start)).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
    wroteNothing(db);
  });
});

describe("propose_escrow_release", () => {
  it("drafts exactly the balance for a person to approve, sends nothing and writes nothing", async () => {
    switchesOn();
    const { out, db } = await run("propose_escrow_release", proposeArgs, heroAs("2026-07-01", 100_000));
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.draft).toEqual({
      kind: "escrow_release",
      subjectTable: "drivers",
      subjectId: hero.id,
      amountCents: 100_000,
      args: { driverId: hero.id, amountCents: 100_000, balanceAsOf: PLAN_ANCHOR },
      limitCents: 100_000,
      exceptions: [],
      reasons: [],
      sources: [{ table: "drivers", id: hero.id }],
    });
    expect(out.result).toMatchObject({ proposed: true, amountCents: 100_000 });
    expect(String((out.result as { note: string }).note)).toContain("nothing is sent by this call");
    wroteNothing(db);
  });

  it("refuses an amount over the cap with the cap as the limit", async () => {
    switchesOn();
    flags.escrowRelease.capCents = 50_000;
    const { out, db } = await run("propose_escrow_release", proposeArgs, heroAs("2026-07-01", 100_000));
    expect(out).toMatchObject({ decision: "blocked", reason: "amount_over_limit", result: { limitCents: 50_000 } });
    expect(db.decisions[0]).toMatchObject({ limitCents: 50_000, requestedCents: 100_000 });
  });

  it("takes a release up to the cap itself", async () => {
    switchesOn();
    flags.escrowRelease.capCents = 100_000;
    const { out } = await run("propose_escrow_release", proposeArgs, heroAs("2026-07-01", 100_000));
    expect(out).toMatchObject({ decision: "allowed" });
  });

  it.each([
    ["an amount above the balance", { amountCents: 100_001 }, heroAs("2026-07-01", 100_000), "amount_mismatch"],
    ["an amount below the balance", { amountCents: 99_999 }, heroAs("2026-07-01", 100_000), "amount_mismatch"],
    ["a driver still active", {}, heroAs(null, 100_000), "driver_active"],
    ["a driver whose last active day is today", {}, heroAs(PLAN_ANCHOR, 100_000), "driver_active"],
    ["a balance date that is not today", { balanceAsOf: "2026-11-01" }, heroAs("2026-07-01", 100_000), "balance_date_mismatch"],
    [
      "a driver with a release still being sent",
      {},
      heroAs("2026-07-01", 100_000, [
        {
          id: "0f0e0d0c-0b0a-4908-8706-050403020100",
          driver_id: hero.id,
          proposal_id: "1f0e0d0c-0b0a-4908-8706-050403020100",
          money_action_id: null,
          opening_balance_cents: 100_000,
          amount_cents: 100_000,
          status: "issuing",
          released_at: null,
          created_at: "2026-11-01T15:00:00.000Z",
        },
      ]),
      "release_exists",
    ],
  ])("refuses %s with its category and no draft", async (_what, over, extra, category) => {
    switchesOn();
    const { out } = await run("propose_escrow_release", { ...proposeArgs, ...over }, extra);
    expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused", result: { category } });
    expect(out).not.toHaveProperty("draft");
  });

  it.each([
    ["not armed", () => (flags.escrowRelease.armed = false), "escrow_not_armed"],
    ["with payouts off", () => (flags.payoutsEnabled = false), "escrow_payouts_off"],
    ["before its start date", () => (flags.escrowRelease.startDate = "2026-11-03"), "escrow_before_start"],
  ])("refuses while the switch is on but %s", async (_what, set, category) => {
    switchesOn();
    set();
    const { out } = await run("propose_escrow_release", proposeArgs, heroAs("2026-07-01", 100_000));
    expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused", result: { category } });
  });

  it("is never offered to the auditor", async () => {
    switchesOn();
    const { out } = await run("propose_escrow_release", proposeArgs, heroAs("2026-07-01", 100_000), { role: "auditor" });
    expect(out).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
  });
});
