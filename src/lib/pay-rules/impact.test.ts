import { describe, expect, it } from "vitest";
import { configFor } from "../data/config-version";
import { payConfigOf, settlementInputOf } from "../data/records";
import { assertPayConfig, cents, settleDriver } from "../rules-engine";
import { ruleChangeOf, type RuleChange, type RuleChangeArgs, type RuleChangeRows } from "./change";
import { ruleImpact, TOP_DRIVERS, type ImpactDriver } from "./impact";
import { applyRule, RULES } from "./rules";
import { rowsFor } from "./__tests__/rows";

// The impact on last week's pay, in integer cents, on the seed's Blue Ridge plan at the golden
// anchor: the newest paid week is Oct 19 to 25, run under the version from Oct 19 ($11.00 a day).
// Every figure is checked against the engine's own settlement of the same week, never a hand sum.

const NOW = new Date("2026-10-27T15:00:00Z");
const WEEK = { start: "2026-10-19", end: "2026-10-25" };

function sized(args: RuleChangeArgs): RuleChange {
  const check = ruleChangeOf(rowsFor("blue-ridge"), args, "skip", NOW);
  if (!check.ok) throw new Error(`refused: ${check.reason}`);
  return check.change;
}

// The engine's settlement of one driver's week under the version it ran and under the candidate.
function both(driverId: string) {
  const rows = rowsFor("blue-ridge");
  const input = settlementInputOf(rows, driverId, WEEK);
  const version = configFor(rows.pay_configs, WEEK.start);
  const before = settleDriver({ ...input, config: payConfigOf(version) });
  const after = settleDriver({ ...input, config: payConfigOf(applyRule(version, "insurance_per_day_cents", 1200)) });
  const line = before.lines.find((l) => l.kind === "insurance");
  return { before, after, days: line ? Number(line.meta?.days ?? 0) : 0 };
}

const INSURANCE: RuleChangeArgs = { ruleKey: "insurance_per_day_cents", newValue: 1200, askedFrom: "2026-11-02" };

describe("the impact on last week's pay", () => {
  it("is $1.00 less per insured owner-operator day for insurance $11 to $12, net of the floor", () => {
    const i = sized(INSURANCE).impact;
    expect(i.basis).toBe("settled_week");
    expect([i.periodStart, i.periodEnd]).toEqual([WEEK.start, WEEK.end]);
    const rows = rowsFor("blue-ridge");
    const period = rows.settlement_periods.find((p) => p.period_start === WEEK.start);
    const paid = rows.settlements.filter((s) => s.period_id === period?.id);
    expect(i.driversCompared).toBe(paid.length);
    const weeks = paid.map((s) => ({ settlement: s, ...both(s.driver_id) }));
    // A driver whose week ends at zero pay or at the net pay floor keeps the same net: the extra
    // insurance moves the carry-forward or what the floor holds back, never the net.
    const held = weeks.filter((w) => w.days > 0 && (w.before.netCents === 0 || w.before.netCents === 30000));
    expect(held.length).toBeGreaterThan(0);
    for (const w of held) expect(w.after.netCents).toBe(w.before.netCents);
    expect(held.some((w) => w.after.carryForwardCents > w.before.carryForwardCents)).toBe(true);
    const moved = weeks.filter((w) => w.days > 0 && !held.includes(w));
    for (const w of moved) expect(w.after.netCents - w.before.netCents).toBe(-100 * w.days);
    expect(i.netDeltaCents).toBe(-100 * moved.reduce((a, w) => a + w.days, 0));
    expect(i.driversChanged).toBe(moved.length);
    expect(i.ownerOperatorsOnly).toBe(true);
    // The worked example's driver: one dollar for each of the week's insured days, linked to the
    // paystub it came from.
    const hero = rows.drivers.find((d) => d.code === "BR-D07");
    if (!hero) throw new Error("no hero");
    const heroTop = i.top.find((t) => t.code === "BR-D07");
    expect(heroTop?.deltaCents).toBe(-100 * both(hero.id).days);
    expect(heroTop?.settlementId).toBe(paid.find((s) => s.driver_id === hero.id)?.id);
  });

  it("keeps every figure an integer and lists at most five drivers, largest first then by code", () => {
    const i = sized(INSURANCE).impact;
    for (const n of [i.netDeltaCents, i.driversChanged, i.driversCompared, ...i.top.map((t) => t.deltaCents)]) {
      expect(Number.isSafeInteger(n)).toBe(true);
    }
    expect(i.top.length).toBeLessThanOrEqual(TOP_DRIVERS);
    expect(i.driversChanged).toBeGreaterThan(TOP_DRIVERS);
    for (let k = 1; k < i.top.length; k += 1) {
      const a = i.top[k - 1];
      const b = i.top[k];
      const ordered = Math.abs(a.deltaCents) > Math.abs(b.deltaCents) || (a.deltaCents === b.deltaCents && a.code < b.code);
      expect(ordered).toBe(true);
    }
  });

  it("is zero for a rule only the advance check reads", () => {
    const i = sized({ ruleKey: "advance_fee_cents", newValue: 500, askedFrom: "2026-11-02" }).impact;
    expect(i).toEqual({
      basis: "advances_only",
      periodId: null,
      periodStart: null,
      periodEnd: null,
      driversCompared: 0,
      driversChanged: 0,
      netDeltaCents: 0,
      ownerOperatorsOnly: false,
      top: [],
    });
  });

  it("says so when no week has been paid", () => {
    const rows = rowsFor("blue-ridge");
    const base = assertPayConfig(payConfigOf(configFor(rows.pay_configs, WEEK.start)));
    const i = ruleImpact(RULES.insurance_per_day_cents, null, [], base, base);
    expect(i.basis).toBe("no_settled_week");
    expect(i.netDeltaCents).toBe(0);
  });

  it("recomputes both nets, so a driver under the floor shows no change while the carry-forward moves", () => {
    const rows = rowsFor("blue-ridge");
    const hero = rows.drivers.find((d) => d.code === "BR-D07");
    if (!hero) throw new Error("no hero");
    const base = assertPayConfig(payConfigOf(configFor(rows.pay_configs, WEEK.start)));
    const candidate = assertPayConfig(payConfigOf(applyRule(configFor(rows.pay_configs, WEEK.start), "insurance_per_day_cents", 1200)));
    // The hero's week with no loads and no pay items: nothing earned, insurance still taken.
    const input = { ...settlementInputOf(rows, hero.id, WEEK), loads: [], items: [] };
    const driver: ImpactDriver = {
      driverId: hero.id,
      code: hero.code,
      workerType: hero.worker_type,
      settlementId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      input,
    };
    const before = settleDriver({ ...input, config: base });
    const after = settleDriver({ ...input, config: candidate });
    expect(before.netCents).toBe(0);
    expect(after.netCents).toBe(0);
    expect(after.carryForwardCents).toBeGreaterThan(before.carryForwardCents);
    const i = ruleImpact(RULES.insurance_per_day_cents, { id: "p", ...WEEK }, [driver], candidate, base);
    expect(i.driversCompared).toBe(1);
    expect(i.driversChanged).toBe(0);
    expect(i.netDeltaCents).toBe(0);
    expect(i.top).toEqual([]);
    expect(i.ownerOperatorsOnly).toBe(false);
  });
});

// The escrow a compared week ran from. The driver's balance now already holds what that week took,
// so a rerun from it can take a different escrow than the week did. The week's own escrow line
// stores the balance it started from; a week that took none stored none, and its escrow stays out.
describe("the escrow a compared week ran from", () => {
  const TARGET_195: RuleChangeArgs = { ruleKey: "escrow_target_cents", newValue: 195_000, askedFrom: "2026-11-02" };

  // One driver's week of Oct 19, with their escrow schedule on the carrier's own target (so the
  // escrow target rule reaches them), their balance now, and their week's escrow line meta.
  function rowsWith(code: string, balanceNow: number, lineMeta?: Record<string, number> | null) {
    const rows = rowsFor("blue-ridge");
    const driver = rows.drivers.find((d) => d.code === code);
    const period = rows.settlement_periods.find((p) => p.period_start === WEEK.start);
    const settlement = rows.settlements.find((s) => s.period_id === period?.id && s.driver_id === driver?.id);
    if (!driver || !settlement) throw new Error("no such driver week");
    const line = rows.settlement_lines.find((l) => l.settlement_id === settlement.id && l.kind === "escrow") ?? null;
    const out: RuleChangeRows = {
      ...rows,
      drivers: rows.drivers.map((d) => (d.id === driver.id ? { ...d, escrow_balance_cents: balanceNow } : d)),
      deduction_schedules: rows.deduction_schedules.map((x) =>
        x.driver_id === driver.id && x.kind === "escrow" ? { ...x, target_cents: null } : x,
      ),
      settlement_lines: rows.settlement_lines.map((l) =>
        line && l.id === line.id && lineMeta !== undefined ? { ...l, meta: lineMeta } : l,
      ),
    };
    return { rows: out, driver, settlement, line };
  }

  function impactOf(rows: RuleChangeRows, args: RuleChangeArgs) {
    const check = ruleChangeOf(rows, args, "skip", NOW);
    if (!check.ok) throw new Error(`refused: ${check.reason}`);
    return check.change.impact;
  }

  it("starts each week from the balance stored on its escrow line, not the balance held now", () => {
    // The hero's week took $100 of escrow and filled it to the $2,000 target: it started at
    // $1,900 and the hero holds $2,000 now. From $1,900, a $1,950 target takes $50 that week
    // instead of $100, so the hero is paid $50 more; from $2,000 neither run would take any.
    const { rows, driver, settlement, line } = rowsWith("BR-D07", 200_000, {
      balanceBeforeCents: 190_000,
      targetCents: 200_000,
    });
    expect(line?.amount_cents).toBe(-10_000);
    // The engine, run from the stored balance under the week's own version, takes what the week took.
    const input = { ...settlementInputOf(rows, driver.id, WEEK), escrowBalanceCents: cents(190_000) };
    const ran = settleDriver({ ...input, config: payConfigOf(configFor(rows.pay_configs, WEEK.start)) });
    expect(ran.lines.find((l) => l.kind === "escrow")?.amountCents).toBe(-10_000);
    expect(ran.netCents).toBe(settlement.net_cents);
    const i = impactOf(rows, TARGET_195);
    expect(i.driversChanged).toBe(1);
    expect(i.netDeltaCents).toBe(5_000);
    expect(i.top).toEqual([
      { driverId: driver.id, code: "BR-D07", deltaCents: 5_000, settlementId: settlement.id },
    ]);
  });

  it("leaves escrow out of both runs for a week that took none, whatever the balance held now", () => {
    // BR-D11's week took no escrow (at the target then). Even with $0 held now, a lower target
    // changes nothing about a week that took none.
    const { rows, line } = rowsWith("BR-D11", 0);
    expect(line).toBeNull();
    const i = impactOf(rows, { ...TARGET_195, newValue: 5_000 });
    expect(i.driversChanged).toBe(0);
    expect(i.netDeltaCents).toBe(0);
    expect(i.top).toEqual([]);
  });

  it("refuses to size a week whose escrow line holds no starting balance (unknown, never zero)", () => {
    const { rows } = rowsWith("BR-D07", 200_000, null);
    expect(() => ruleChangeOf(rows, TARGET_195, "skip", NOW)).toThrow();
  });

  it("refuses to size a raised target on a week that took none, as its starting balance is unknown", () => {
    // BR-D11's week took no escrow although its schedule runs and $0 held would take $100, so it
    // started at the $2,000 target or above. A $2,050 target takes $50 that week from $2,000 and
    // nothing from $2,050: which one is unknown, so the change is not sized at all.
    const { rows, driver, line } = rowsWith("BR-D11", 0);
    expect(line).toBeNull();
    const fromZero = settleDriver({ ...settlementInputOf(rows, driver.id, WEEK), escrowBalanceCents: cents(0) });
    expect(fromZero.escrowDeltaCents).toBe(10_000);
    expect(() => ruleChangeOf(rows, { ...TARGET_195, newValue: 205_000 }, "skip", NOW)).toThrow(
      /starting balance is unknown/,
    );
  });

  it("sizes a raised carrier target as no change where each schedule carries its own target", () => {
    // The seed's escrow schedules hold their own $2,000 target, which the engine takes over the
    // carrier's, so every week that took none still takes none.
    const rows = rowsFor("blue-ridge");
    const escrow = rows.deduction_schedules.filter((s) => s.kind === "escrow");
    expect(escrow.length).toBeGreaterThan(0);
    expect(escrow.every((s) => s.target_cents === 200_000)).toBe(true);
    const i = impactOf(rows, { ...TARGET_195, newValue: 205_000 });
    expect(i.driversChanged).toBe(0);
    expect(i.netDeltaCents).toBe(0);
  });

  it("refuses to size a lower floor on a week the floor kept from taking escrow, as its balance is unknown", () => {
    // BR-D25 netted $8.81 that week, under the $300 floor, so the floor left no room for escrow and
    // the week says nothing about the balance. With no floor, that week takes escrow or not
    // depending on that balance, so the change is not sized at all.
    const rows = rowsFor("blue-ridge");
    const driver = rows.drivers.find((d) => d.code === "BR-D25");
    const period = rows.settlement_periods.find((p) => p.period_start === WEEK.start);
    const settlement = rows.settlements.find((s) => s.period_id === period?.id && s.driver_id === driver?.id);
    if (!driver || !settlement) throw new Error("no such driver week");
    expect(rows.settlement_lines.some((l) => l.settlement_id === settlement.id && l.kind === "escrow")).toBe(false);
    const fromZero = settleDriver({ ...settlementInputOf(rows, driver.id, WEEK), escrowBalanceCents: cents(0) });
    expect(fromZero.escrowDeltaCents).toBe(0);
    expect(fromZero.netCents).toBe(settlement.net_cents);
    expect(settlement.net_cents).toBeLessThan(30_000);
    const noFloor: RuleChangeArgs = { ruleKey: "net_pay_floor_cents", newValue: 0, askedFrom: "2026-11-02" };
    expect(() => ruleChangeOf(rows, noFloor, "skip", NOW)).toThrow(/starting balance is unknown/);
  });
});
