import { describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { configFor, configForDay, sortVersions } from "../data/config-version";
import {
  advanceOf,
  checkInputOf,
  customerOf,
  driverOf,
  loadsOf,
  loadStopsOf,
  payConfigOf,
  receivablesInputOf,
  settlementInputOf,
} from "../data/records";
import type { AdvanceRow, DriverDayRow, DriverRow } from "../data/rows";
import {
  agingBucket,
  checkAdvance,
  detentionStops,
  driverPayOnLoad,
  findAdvanceOverLoadCap,
  findUnbilledDetention,
  lastFullMonthBefore,
  mulBps,
  outstandingCents,
  paymentProfile,
  runFuelChecks,
  settleDriver,
} from "../rules-engine";
import { addDays, daysBetween } from "../time/local-date";
import { customerClassOf } from "./ar-plan";
import { instantAt } from "./calendar";
import { assertPlan, DETENTION_TOTAL_CENTS, HERO_OPEN_WEEK, seededAdvanceDecision } from "./assert-plan";
import { DEMO_CARRIERS } from "./carriers";
import { buildCarrierPlan, buildDriverCards, type CarrierPlan } from "./plan";

const ANCHOR = "2026-11-02";
const plans = DEMO_CARRIERS.map((c) => buildCarrierPlan(c, ANCHOR));

// Every date and instant value in the plan.
function datesOf(plan: CarrierPlan): string[] {
  const r = plan.rows;
  return [
    ...r.loads.flatMap((l) => [
      l.pickup_on,
      l.delivered_on,
      l.delivered_at,
      l.pickup_arrived_at,
      l.pickup_departed_at,
      l.delivery_arrived_at,
      l.delivery_departed_at,
    ]),
    ...r.driver_days.map((d) => d.day),
    ...r.fuel_purchases.flatMap((f) => [f.purchased_on, f.purchased_at]),
    ...r.pay_items.map((p) => p.item_date),
    ...r.advances.flatMap((a) => [a.requested_on, a.requested_at, a.paid_at]),
    ...r.settlement_periods.map((p) => p.period_end),
    ...r.pay_configs.map((v) => v.effective_from),
    ...r.invoices.flatMap((i) => [i.issued_on, i.paid_on]),
    ...r.customer_payments.map((p) => p.received_on),
  ].filter((v): v is string => v !== null);
}

const plantedAdvanceIds = (plan: CarrierPlan) =>
  new Set([...plan.planted.duplicateAdvanceIds, ...plan.planted.overLimitAdvanceIds]);

describe("buildCarrierPlan", () => {
  it("gives the same rows and ids for the same anchor", () => {
    for (const c of DEMO_CARRIERS) {
      expect(buildCarrierPlan(c, ANCHOR)).toEqual(plans.find((p) => p.carrier === c));
    }
  });

  it("gives different ids for a different anchor", () => {
    const other = buildCarrierPlan(DEMO_CARRIERS[0], "2026-11-09");
    const ids = new Set(plans[0].rows.loads.map((l) => l.id));
    expect(other.rows.loads.some((l) => ids.has(l.id))).toBe(false);
  });

  it("keeps the two carriers' ids apart", () => {
    const ids = new Set(plans[0].rows.drivers.map((d) => d.id));
    expect(plans[1].rows.drivers.some((d) => ids.has(d.id))).toBe(false);
  });

  it("dates everything before the anchor", () => {
    for (const plan of plans) {
      // A local date is before the anchor; an instant (in UTC) is before the anchor's end.
      for (const v of datesOf(plan)) {
        expect(v.length === 10 ? v <= addDays(ANCHOR, -1) : v.slice(0, 10) <= ANCHOR).toBe(true);
      }
    }
  });

  it("plants nothing on the hero", () => {
    const plan = plans[0];
    const hero = plan.rows.drivers.find((d) => d.code === plan.carrier.heroCode) as DriverRow;
    const { planted, rows } = plan;
    const driverOfLoad = (id: string) => rows.loads.find((l) => l.id === id)?.driver_id;
    const lumper = rows.load_accessorials.find((a) => a.id === planted.unreimbursedLumperId);
    const touched = [
      ...rows.advances.filter((a) => plantedAdvanceIds(plan).has(a.id)).map((a) => a.driver_id),
      rows.pay_items.find((p) => p.id === planted.wrongDriverFuelItemId)?.driver_id,
      rows.fuel_purchases.find((f) => f.id === planted.wrongDriverPurchaseId)?.driver_id,
      rows.driver_days.find((d) => d.id === planted.dispatchDayId)?.driver_id,
      lumper ? driverOfLoad(lumper.load_id) : undefined,
      driverOfLoad(planted.noRateLoadId),
      ...[planted.fuelOffRouteId, planted.fuelOverTankId, planted.fuelParkedId, ...planted.fuelDuplicateIds].map(
        (id) => rows.fuel_purchases.find((f) => f.id === id)?.driver_id,
      ),
      ...planted.detentionLoadIds.map(driverOfLoad),
    ];
    expect(touched).toHaveLength(18);
    for (const id of touched) {
      expect(id).toBeDefined();
      expect(id).not.toBe(hero.id);
    }
    const codes = Object.values(plan.victims);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(hero.code);
  });

  it("leaves the insurance-day victim no load in transit from before the planted day", () => {
    for (const plan of plans) {
      const day = plan.rows.driver_days.find(
        (d) => d.id === plan.planted.dispatchDayId,
      ) as DriverDayRow;
      expect(day.source).toBe("dispatch");
      const carrying = plan.rows.loads.filter(
        (l) => l.driver_id === day.driver_id && l.status === "in_transit" && l.pickup_on <= day.day,
      );
      expect(carrying).toEqual([]);
    }
  });

  it("ties every fuel pay item to a fuel purchase", () => {
    for (const plan of plans) {
      const purchases = new Set(plan.rows.fuel_purchases.map((f) => f.id));
      const fuel = plan.rows.pay_items.filter((p) => p.kind === "fuel");
      expect(fuel.length).toBeGreaterThan(0);
      for (const p of fuel) {
        expect(p.ref_table).toBe("fuel_purchases");
        expect(purchases.has(p.ref_id as string)).toBe(true);
      }
    }
  });

  it("keeps every driver but the over-limit victim inside the advance limit, fee included", () => {
    for (const plan of plans) {
      const config = configFor(plan.rows.pay_configs, plan.periods[3].start);
      const limitOf = (d: DriverRow) => d.advance_limit_cents ?? config.advance_limit_default_cents;
      for (const d of plan.rows.drivers) {
        if (d.code === plan.victims.overLimit) continue;
        const open = plan.rows.advances
          .filter((a) => a.driver_id === d.id && (a.status === "approved" || a.status === "paid"))
          .reduce((n, a) => n + a.amount_cents + a.fee_cents - a.recovered_cents, 0);
        expect(open).toBeLessThanOrEqual(limitOf(d));
      }
    }
  });

  it("makes no duplicate advance but the planted pair", () => {
    for (const plan of plans) {
      const [a, b] = plan.planted.duplicateAdvanceIds;
      const pairs: string[] = [];
      const list = plan.rows.advances;
      for (const x of list) {
        for (const y of list) {
          const hours = (Date.parse(y.requested_at) - Date.parse(x.requested_at)) / 3_600_000;
          const same = x.driver_id === y.driver_id && x.amount_cents === y.amount_cents;
          if (x.id !== y.id && same && hours >= 0 && hours <= 24) pairs.push(`${x.id}>${y.id}`);
        }
      }
      expect(pairs).toEqual([`${a}>${b}`]);
    }
  });

  it("makes every advance that is not planted one the engine would approve", () => {
    for (const plan of plans) {
      const planted = plantedAdvanceIds(plan);
      const { rows } = plan;
      const loads = loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials);
      const clean = plan.rows.advances.filter((a) => !planted.has(a.id));
      expect(clean.length).toBeGreaterThanOrEqual(14);
      for (const a of clean) {
        const driver = plan.rows.drivers.find((d) => d.id === a.driver_id) as DriverRow;
        const prior: AdvanceRow[] = plan.rows.advances.filter(
          (x) => x.driver_id === a.driver_id && x.requested_at < a.requested_at,
        );
        const decision = seededAdvanceDecision({
          config: payConfigOf(configForDay(plan.rows.pay_configs, a.requested_on)),
          driver,
          loads,
          periods: plan.periods,
          zone: plan.carrier.timezone,
          at: a.requested_at,
          amountCents: a.amount_cents,
          prior,
        });
        expect({ code: driver.code, reasons: decision.reasons }).toEqual({
          code: driver.code,
          reasons: [],
        });
        expect(decision.eligible).toBe(true);
        expect(a.fee_cents).toBe(decision.feeCents);
      }
    }
  });

  // One test per anchor, each with room for a slow runner: every plan runs all of assertPlan.
  const spread = Array.from({ length: 12 }, (_, i) => addDays("2026-01-05", i * 31));
  spread.push("2026-03-09", "2026-11-03");
  it.each(spread)(
    "builds and checks both plans at anchor %s (a spread of anchors, DST weeks included)",
    { timeout: 30_000 },
    (anchor) => {
      for (const c of DEMO_CARRIERS) expect(() => buildCarrierPlan(c, anchor)).not.toThrow();
    },
  );
});

describe("fuel cards", () => {
  it("gives every driver one default active card, unique tokens and last four, and plants one declined and one slow", () => {
    for (const plan of plans) {
      const { drivers, driver_cards: cards } = plan.rows;
      const defaults = cards.filter((c) => c.is_default);
      expect(defaults).toHaveLength(drivers.length);
      expect(new Set(defaults.map((c) => c.driver_id))).toEqual(new Set(drivers.map((d) => d.id)));
      expect(defaults.every((c) => c.status === "active" && c.closed_at === null && c.holder_kind === "named")).toBe(true);
      expect(cards.every((c) => c.source === "seed")).toBe(true);
      expect(new Set(cards.map((c) => c.provider_token)).size).toBe(cards.length);
      expect(new Set(cards.map((c) => c.last4)).size).toBe(cards.length);
      expect(cards.every((c) => /^fcs_card_[0-9a-f]{24}$/.test(c.provider_token) && /^[0-9]{4}$/.test(c.last4))).toBe(true);
      expect(cards.filter((c) => c.sim_behavior === "declined")).toHaveLength(1);
      expect(cards.filter((c) => c.sim_behavior === "slow")).toHaveLength(1);
      expect(cards.some((c) => c.sim_behavior === "offline")).toBe(false);
      // Three more cards only where there is a hero: 28 at Blue Ridge, 25 at Prairie Wind.
      expect(cards).toHaveLength(drivers.length + (plan.carrier.heroCode ? 3 : 0));
    }
  });

  it("plants the declined card on the highest non-hero driver code and the slow one on the next", () => {
    const plan = plans.find((p) => p.carrier.heroCode === "BR-D07")!;
    const codeOf = new Map(plan.rows.drivers.map((d) => [d.id, d.code]));
    const by = (b: string) => plan.rows.driver_cards.filter((c) => c.sim_behavior === b).map((c) => codeOf.get(c.driver_id));
    const codes = plan.rows.drivers.map((d) => d.code).filter((c) => c !== "BR-D07").sort();
    expect(by("declined")).toEqual([codes[codes.length - 1]]);
    expect(by("slow")).toEqual([codes[codes.length - 2]]);
    const hero = plan.rows.drivers.find((d) => d.code === "BR-D07")!;
    expect(plan.rows.driver_cards.find((c) => c.driver_id === hero.id)?.sim_behavior).toBe("ok");
  });

  it("skips the hero even when the hero holds the highest code", () => {
    const drivers = ["X-D01", "X-D02", "X-D03"].map((code, i) => ({ id: `d${i}`, code }) as DriverRow);
    const cards = buildDriverCards("test:2026-11-02", drivers, "X-D03");
    expect(cards.map((c) => c.sim_behavior)).toEqual(["slow", "declined", "ok"]);
  });

  it("draws cards from their own stream, so the same seed gives the same cards", () => {
    const again = DEMO_CARRIERS.map((c) => buildCarrierPlan(c, ANCHOR));
    expect(again.map((p) => p.rows.driver_cards)).toEqual(plans.map((p) => p.rows.driver_cards));
  });
});

describe("advance parity", () => {
  const codeOf = (plan: CarrierPlan, id: string) => plan.rows.drivers.find((d) => d.id === id)!.code;

  it("arms every driver from the morning they started except one planted driver, never the hero", () => {
    for (const plan of plans) {
      const { drivers, advances, driver_arm_events: events } = plan.rows;
      const disarmed = drivers.filter((d) => !d.money_armed);
      expect(disarmed.map((d) => d.id)).toEqual([plan.planted.parity.disarmedDriverId]);
      expect(disarmed[0].code).not.toBe(plan.carrier.heroCode);
      expect(disarmed[0].money_armed_at).toBeNull();
      expect(advances.some((a) => a.driver_id === disarmed[0].id)).toBe(false);
      for (const d of drivers.filter((x) => x.money_armed)) {
        expect(d.money_armed_at).toBe(instantAt(d.active_from, 8, 0, plan.carrier.timezone));
      }
      expect(events).toHaveLength(drivers.length);
      for (const e of events) {
        const d = drivers.find((x) => x.id === e.driver_id)!;
        expect([e.armed, e.source, e.membership_id, e.note]).toEqual([d.money_armed, "seed", null, null]);
      }
    }
  });

  it("plants the money code sample only on an armed driver's load, never the disarmed driver's", () => {
    for (const plan of plans.filter((p) => p.planted.moneyCodeLoadId !== null)) {
      const load = plan.rows.loads.find((l) => l.id === plan.planted.moneyCodeLoadId)!;
      expect(plan.rows.drivers.find((d) => d.id === load.driver_id)!.money_armed).toBe(true);
    }
    // At this anchor the only load on the road is the planted disarmed driver's, whose code the
    // arming rule would refuse, so no sample is planted at all.
    const plan = buildCarrierPlan(DEMO_CARRIERS.find((c) => c.slug === "blue-ridge")!, "2026-11-23");
    const onRoad = plan.rows.loads.filter((l) => l.status === "in_transit");
    expect(onRoad.map((l) => l.driver_id)).toEqual([plan.planted.parity.disarmedDriverId]);
    expect(plan.planted.moneyCodeLoadId).toBeNull();
  });

  it("gives each driver one dispatch-system id, unique within the carrier", () => {
    for (const plan of plans) {
      const ids = plan.rows.driver_identities;
      expect(ids).toHaveLength(plan.rows.drivers.length);
      expect(new Set(ids.map((x) => x.driver_id)).size).toBe(ids.length);
      expect(new Set(ids.map((x) => x.external_id)).size).toBe(ids.length);
      const shape = new RegExp(`^TMS-${plan.carrier.prefix}-[0-9]{5}$`);
      expect(ids.every((x) => x.system === "tms" && x.source === "seed" && shape.test(x.external_id))).toBe(true);
    }
  });

  it("refuses a plan whose dispatch id is not the carrier's TMS-<prefix>-<five digits>", () => {
    const plan = plans[0];
    const prefix = plan.carrier.prefix;
    for (const bad of [`TMS-${prefix}-1234`, `TMS-${prefix}-123456`, `TMS-${prefix}X-12345`, `tms-${prefix}-12345`, `TMS-${prefix}-1234a`]) {
      const copy = structuredClone(plan);
      copy.rows.driver_identities[0].external_id = bad;
      expect(() => assertPlan(copy)).toThrow("seed plan: a dispatch id is malformed");
    }
  });

  it("adds a second named card, a generic pool card and a closed card at Blue Ridge, never on the hero", () => {
    const plan = plans.find((p) => p.carrier.heroCode === "BR-D07")!;
    const { parity } = plan.planted;
    const cards = plan.rows.driver_cards;
    const hero = plan.rows.drivers.find((d) => d.code === "BR-D07")!;
    expect(cards.filter((c) => c.driver_id === hero.id)).toHaveLength(1);
    const extra = cards.find((c) => c.id === parity.extraCardId)!;
    expect([codeOf(plan, extra.driver_id), extra.status, extra.is_default, extra.holder_kind]).toEqual([
      "BR-D08",
      "active",
      false,
      "named",
    ]);
    expect(cards.filter((c) => c.driver_id === extra.driver_id && c.status === "active")).toHaveLength(2);
    const generic = cards.find((c) => c.id === parity.genericCardId)!;
    expect(generic.holder_kind).toBe("generic");
    expect(generic.portal_name).toMatch(/^POOL CARD [1-9]$/);
    expect([generic.status, generic.is_default]).toEqual(["active", false]);
    const closed = cards.find((c) => c.id === parity.closedCardId)!;
    expect([closed.status, closed.is_default]).toEqual(["closed", false]);
    expect(closed.closed_at).toBe(instantAt(addDays(ANCHOR, -60), 10, 0, plan.carrier.timezone));
    const owners = [extra, generic, closed].map((c) => c.driver_id);
    expect(new Set(owners).size).toBe(3);
    expect(owners).not.toContain(parity.disarmedDriverId);
    const planted = cards.filter((c) => c.sim_behavior !== "ok").map((c) => c.driver_id);
    expect(owners.some((id) => planted.includes(id))).toBe(false);
  });

  it("adds no extra cards where there is no hero", () => {
    const plan = plans.find((p) => p.carrier.heroCode === null)!;
    const { parity } = plan.planted;
    expect([parity.extraCardId, parity.genericCardId, parity.closedCardId]).toEqual([null, null, null]);
    expect(plan.rows.driver_cards.every((c) => c.is_default && c.holder_kind === "named")).toBe(true);
  });

  it("plants two paid advances on one open-week load, different amounts, both granted and under the load's cap", () => {
    for (const plan of plans) {
      const { rows, planted, periods } = plan;
      const [a, b] = planted.parity.loadPairAdvanceIds.map((id) => rows.advances.find((x) => x.id === id)!);
      expect(a.driver_id).toBe(b.driver_id);
      expect([a.load_id, b.load_id]).toEqual([planted.parity.loadPairLoadId, planted.parity.loadPairLoadId]);
      expect(a.amount_cents).not.toBe(b.amount_cents);
      expect([a.status, b.status, a.recovered_cents, b.recovered_cents]).toEqual(["paid", "paid", 0, 0]);
      expect(a.requested_on >= periods[3].start && b.requested_on <= periods[3].end).toBe(true);
      expect(Date.parse(b.requested_at) - Date.parse(a.requested_at)).toBeGreaterThan(24 * 3600_000);
      expect(rows.advances.filter((x) => x.driver_id === a.driver_id)).toHaveLength(2);
      const driver = rows.drivers.find((d) => d.id === a.driver_id)!;
      const loads = loadsOf(rows.loads, rows.load_state_miles, rows.load_accessorials);
      const load = loads.find((l) => l.id === a.load_id)!;
      const config = payConfigOf(configForDay(rows.pay_configs, a.requested_on));
      const payCents = driverPayOnLoad(config, driverOf(driver), load);
      const cap = mulBps(payCents, config.advancePerLoadBpsOfPay!);
      expect(a.amount_cents + a.fee_cents + b.amount_cents + b.fee_cents).toBeLessThanOrEqual(cap);
      const ask = (x: AdvanceRow, prior: AdvanceRow[]) =>
        seededAdvanceDecision({
          config,
          driver,
          loads,
          periods,
          zone: plan.carrier.timezone,
          at: x.requested_at,
          amountCents: x.amount_cents,
          prior,
          load: { id: load.id, payCents },
        });
      expect(ask(a, []).eligible).toBe(true);
      const second = ask(b, [a]);
      expect(second.eligible).toBe(true);
      expect(second.openOnLoadCents).toBe(a.amount_cents + a.fee_cents);
    }
  });

  // At these anchors the duplicate-receipt driver (victim 11) is the one the parity stream would
  // otherwise pick: disarmed on Sep 28 (both carriers), the load pair on Nov 9 (Prairie Wind).
  it.each(["2026-09-28", "2026-11-09"])(
    "never disarms or plants the load pair on the duplicate-receipt driver (anchor %s)",
    (anchor) => {
      for (const c of DEMO_CARRIERS) {
        const plan = buildCarrierPlan(c, anchor);
        const { rows, planted, victims } = plan;
        const pairLoad = rows.loads.find((l) => l.id === planted.parity.loadPairLoadId)!;
        expect(Object.values(victims)).not.toContain(codeOf(plan, planted.parity.disarmedDriverId));
        expect(codeOf(plan, pairLoad.driver_id!)).not.toBe(victims.fuelDuplicate);
      }
    },
  );

  it("names the driver's own recent load on an advance only while the load's cap holds", () => {
    for (const plan of plans) {
      const { rows } = plan;
      const linked = rows.advances.filter((a) => a.load_id !== null);
      expect(linked.length).toBeGreaterThan(2);
      for (const a of linked) {
        const load = rows.loads.find((l) => l.id === a.load_id)!;
        expect(load.driver_id).toBe(a.driver_id);
        expect(load.delivered_on! <= a.requested_on).toBe(true);
        expect(daysBetween(load.delivered_on!, a.requested_on)).toBeLessThanOrEqual(14);
      }
      expect(findAdvanceOverLoadCap(checkInputOf(rows))).toEqual([]);
    }
  });

  it("takes back one open-week advance in full, one no settlement recovered from, so recovery and take-back never overlap", () => {
    for (const plan of plans) {
      const { rows, periods } = plan;
      const back = rows.advances.find((a) => a.id === plan.planted.parity.takenBackAdvanceId)!;
      expect(back.requested_on >= periods[3].start && back.requested_on <= periods[3].end).toBe(true);
      expect([back.status, back.taken_back_cents, back.takeback_reason]).toEqual([
        "paid",
        back.amount_cents,
        "wrong_driver",
      ]);
      expect(Date.parse(back.taken_back_at!) - Date.parse(back.paid_at!)).toBe(3 * 3600_000);
      expect(back.taken_back_by_membership_id).toBeNull();
      // No settled week recovered from it: no recovery line cites it, and only its fee is still owed.
      const cited = rows.settlement_lines.filter(
        (l) => l.kind === "advance_recovery" && l.sources.some((x) => x.table === "advances" && x.id === back.id),
      );
      expect(cited).toEqual([]);
      expect(back.recovered_cents).toBe(0);
      expect(() => checkAdvance(advanceOf(back))).not.toThrow();
      expect(outstandingCents(advanceOf(back))).toBe(back.fee_cents);
      expect(rows.advances.filter((a) => a.taken_back_at !== null)).toHaveLength(1);
    }
  });
});

describe("versioned pay rules", () => {
  it("settles Blue Ridge's first two weeks under the opening rules and the third under v2", () => {
    const { rows, periods } = plans[0];
    const versions = sortVersions(rows.pay_configs);
    expect(versions.map((v) => [v.effective_from, v.insurance_per_day_cents, v.source])).toEqual([
      ["2026-10-05", 1050, "seed"],
      ["2026-10-19", 1100, "seed"],
    ]);
    const versionOf = (start: string) => {
      const p = rows.settlement_periods.find((x) => x.period_start === start)!;
      const settled = rows.settlements.filter((s) => s.period_id === p.id);
      return [...new Set(settled.map((s) => s.pay_config_id))];
    };
    expect(versionOf(periods[0].start)).toEqual([versions[0].id]);
    expect(versionOf(periods[1].start)).toEqual([versions[0].id]);
    expect(versionOf(periods[2].start)).toEqual([versions[1].id]);
    // The insurance lines show the rate of the week's version.
    for (const [week, rate] of [[0, 1050], [1, 1050], [2, 1100]] as const) {
      const p = rows.settlement_periods.find((x) => x.period_start === periods[week].start)!;
      const settled = new Set(
        rows.settlements.filter((s) => s.period_id === p.id).map((s) => s.id),
      );
      const lines = rows.settlement_lines.filter(
        (l) => settled.has(l.settlement_id) && l.kind === "insurance",
      );
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l.meta?.perDayCents).toBe(rate);
    }
  });

  it("settles Prairie Wind's weeks under its one version", () => {
    const { rows } = plans[1];
    expect(rows.pay_configs.map((v) => [v.effective_from, v.note])).toEqual([
      ["2026-10-04", "Opening pay policy"],
    ]);
    expect(new Set(rows.settlements.map((s) => s.pay_config_id))).toEqual(
      new Set([rows.pay_configs[0].id]),
    );
  });

  it("keeps the hero's open week at the worked example under v2", () => {
    const { rows, periods, carrier } = plans[0];
    const hero = rows.drivers.find((d) => d.code === carrier.heroCode)!;
    const r = settleDriver(settlementInputOf(rows, hero.id, periods[3]));
    expect(r.netCents).toBe(HERO_OPEN_WEEK.netCents);
    expect(r.lines.find((l) => l.kind === "insurance")?.amountCents).toBe(-5 * 1100);
  });
});

describe("planted fuel anomalies", () => {
  // The three rules, written here on their own so the test does not trust the plan's checker.
  for (const plan of plans) {
    const { rows, planted } = plan;
    const statesOf = (loadId: string) =>
      new Set(rows.load_state_miles.filter((m) => m.load_id === loadId).map((m) => m.state));
    const offRoute = rows.fuel_purchases.filter((f) => {
      const l = rows.loads.find((x) => x.id === f.load_id);
      if (!l || f.purchased_on < l.pickup_on) return false;
      if (l.delivered_on !== null && f.purchased_on > l.delivered_on) return false;
      return !statesOf(l.id).has(f.state);
    });
    const overTank = rows.fuel_purchases.filter((f) => {
      const d = rows.drivers.find((x) => x.id === f.driver_id)!;
      return f.gallons_milli > d.tank_gallons * 1000;
    });
    const parked = rows.fuel_purchases.filter((f) => {
      if (f.paid_with !== "company_card") return false;
      const spanned = rows.loads.some(
        (l) =>
          l.driver_id === f.driver_id &&
          l.pickup_on <= f.purchased_on &&
          f.purchased_on <= (l.delivered_on ?? f.purchased_on),
      );
      const dayRow = rows.driver_days.some(
        (d) => d.driver_id === f.driver_id && d.day === f.purchased_on,
      );
      return !spanned && !dayRow;
    });

    // The same fill-up twice: one driver, the same gallons, amount and state, within an hour.
    const twice = rows.fuel_purchases.flatMap((a) =>
      rows.fuel_purchases
        .filter((b) => {
          const gap = Date.parse(b.purchased_at) - Date.parse(a.purchased_at);
          return (
            b.id !== a.id &&
            b.driver_id === a.driver_id &&
            b.gallons_milli === a.gallons_milli &&
            b.amount_cents === a.amount_cents &&
            b.state === a.state &&
            (gap > 0 || (gap === 0 && b.id > a.id)) &&
            gap <= 60 * 60_000
          );
        })
        .map((b) => [a.id, b.id]),
    );

    it(`finds each of ${plan.carrier.slug}'s four by exactly its rule`, () => {
      expect(offRoute.map((f) => f.id)).toEqual([planted.fuelOffRouteId]);
      expect(overTank.map((f) => f.id)).toEqual([planted.fuelOverTankId]);
      expect(parked.map((f) => f.id)).toEqual([planted.fuelParkedId]);
      expect(twice).toEqual([planted.fuelDuplicateIds]);
    });

    it(`plants ${plan.carrier.slug}'s receipt turned in twice as the design states`, () => {
      const [older, newer] = planted.fuelDuplicateIds.map(
        (id) => rows.fuel_purchases.find((f) => f.id === id)!,
      );
      const driver = rows.drivers.find((d) => d.id === newer.driver_id)!;
      expect(driver.code).toBe(plan.victims.fuelDuplicate);
      for (const f of [older, newer]) {
        expect([f.gallons_milli, f.amount_cents, f.paid_with]).toEqual([84200, 31996, "driver_own"]);
        expect(f.purchased_on >= addDays(plan.periods[3].start, 2)).toBe(true);
        expect(statesOf(f.load_id!).has(f.state)).toBe(true);
      }
      expect(Date.parse(newer.purchased_at) - Date.parse(older.purchased_at)).toBe(6 * 60_000);
      expect(newer.purchased_on).toBe(older.purchased_on);
      const paybacks = planted.fuelDuplicatePaybackIds.map(
        (id) => rows.pay_items.find((i) => i.id === id)!,
      );
      expect(
        paybacks.map((i) => [i.kind, i.subkind, i.driver_id, i.amount_cents, i.ref_id, i.settlement_id]),
      ).toEqual([
        ["reimbursement", "fuel", driver.id, 31996, older.id, null],
        ["reimbursement", "fuel", driver.id, 31996, newer.id, null],
      ]);
    });

    it(`plants ${plan.carrier.slug}'s three as the design states`, () => {
      const byId = (id: string) => rows.fuel_purchases.find((f) => f.id === id)!;
      const off = byId(planted.fuelOffRouteId);
      const load = rows.loads.find((l) => l.id === off.load_id)!;
      expect([off.state, off.gallons_milli, off.amount_cents, off.paid_with]).toEqual([
        plan.carrier.prefix === "BR" ? "FL" : "NM",
        95000,
        36575,
        "company_card",
      ]);
      expect(off.purchased_on).toBe(addDays(load.pickup_on, 1));
      const over = byId(planted.fuelOverTankId);
      expect([over.gallons_milli, over.amount_cents, over.paid_with]).toEqual([
        286400,
        111696,
        "company_card",
      ]);
      expect(rows.drivers.find((d) => d.id === over.driver_id)?.tank_gallons).toBe(200);
      const item = rows.pay_items.find((i) => i.ref_id === over.id);
      expect([item?.kind, item?.driver_id, item?.amount_cents]).toEqual([
        "fuel",
        over.driver_id,
        111696,
      ]);
      const park = byId(planted.fuelParkedId);
      expect([park.load_id, park.gallons_milli, park.amount_cents]).toEqual([null, 118000, 43896]);
      expect(park.purchased_at).toBe(instantAt(park.purchased_on, 22, 40, plan.carrier.timezone));
      for (const f of [off, over, park]) {
        expect(f.purchased_on >= plan.periods[3].start).toBe(true);
      }
    });
  }

  // What the fuel checks page lists for each carrier, with the engine's numbers. Prairie Wind's
  // fill-up on a day off is from before the checks' start date, so it is never listed.
  it("lists each carrier's fill-ups from the start date on, to the cent", () => {
    const listed = plans.map(({ rows }) =>
      runFuelChecks(checkInputOf(rows), flags.fuelAnomalyLimits).map((f) => [
        f.check,
        f.purchasedOn,
        f.amountCents,
        f.suggestedCents ?? f.noSuggestion,
        f.excessCents,
      ]),
    );
    expect(listed).toEqual([
      [
        ["fuel_off_route", "2026-10-29", 36575, -36575, null],
        ["fuel_over_tank", "2026-10-28", 111696, "over_tank", 33696],
        ["fuel_while_parked", "2026-10-31", 43896, -43896, null],
        ["fuel_duplicate", "2026-10-28", 31996, -31996, null],
      ],
      [
        ["fuel_off_route", "2026-10-29", 36575, -36575, null],
        ["fuel_over_tank", "2026-10-27", 111696, "over_tank", 33696],
        ["fuel_duplicate", "2026-10-30", 31996, -31996, null],
      ],
    ]);
  });

  it("fits every ordinary purchase in its driver's tank", () => {
    for (const { rows } of plans) {
      for (const d of rows.drivers) {
        expect(d.tank_gallons).toBeGreaterThanOrEqual(150);
        expect(d.tank_gallons).toBeLessThanOrEqual(300);
      }
    }
  });
});

describe("unbilled detention", () => {
  for (const plan of plans) {
    const { rows, planted, periods } = plan;
    const stops = rows.loads.map(loadStopsOf);
    const customers = rows.customers.map(customerOf);
    const accessorials = rows.load_accessorials.map((a) => ({ loadId: a.load_id, kind: a.kind }));

    it(`finds exactly ${plan.carrier.slug}'s four planted loads, $1,350.00 in all`, () => {
      const found = findUnbilledDetention(stops, customers, accessorials, {
        start: periods[0].start,
        end: periods[3].end,
      });
      const byLoad = new Map(found.map((u) => [u.loadId, u.amountCents]));
      expect(planted.detentionLoadIds.map((id) => byLoad.get(id))).toEqual([
        41250, 30000, 37500, 26250,
      ]);
      expect(found).toHaveLength(4);
      expect(found.reduce((n, u) => n + u.amountCents, 0)).toBe(DETENTION_TOTAL_CENTS);
      // October, the last full month before the anchor, holds the same four.
      const month = lastFullMonthBefore(ANCHOR);
      expect(month).toEqual({ start: "2026-10-01", end: "2026-10-31" });
      const october = findUnbilledDetention(stops, customers, accessorials, month);
      expect(october.map((u) => u.loadId).sort()).toEqual([...planted.detentionLoadIds].sort());
    });

    it(`puts ${plan.carrier.slug}'s plants on four drivers with no problem, open invoices`, () => {
      const loads = planted.detentionLoadIds.map((id) => rows.loads.find((l) => l.id === id)!);
      const drivers = new Set(loads.map((l) => l.driver_id));
      expect(drivers.size).toBe(4);
      const hero = rows.drivers.find((d) => d.code === plan.carrier.heroCode)?.id;
      const victimIds = new Set(
        Object.values(plan.victims).map((code) => rows.drivers.find((d) => d.code === code)!.id),
      );
      for (const l of loads) {
        expect(victimIds.has(l.driver_id!)).toBe(false);
        expect(l.driver_id).not.toBe(hero);
        expect(rows.load_accessorials.filter((a) => a.load_id === l.id)).toEqual([]);
        expect(rows.invoices.find((i) => i.load_id === l.id)?.status).toBe("open");
        expect(l.delivered_on! >= periods[1].start && l.delivered_on! <= periods[2].end).toBe(true);
      }
      expect(loads.map((l) => rows.customers.findIndex((c) => c.id === l.customer_id))).toEqual([
        3, 0, 7, 4,
      ]);
    });

    it(`gives ${plan.carrier.slug}'s billed detention a bill of lading that agrees`, () => {
      for (const a of rows.load_accessorials.filter((x) => x.kind === "detention")) {
        const load = stops.find((l) => l.id === a.load_id)!;
        const customer = customers.find((c) => c.id === load.customerId)!;
        const [pickup, delivery] = detentionStops(load, customer)!;
        const minutes = Math.ceil((a.amount_cents * 60) / customer.detentionHourlyCents);
        expect(pickup.overMinutes).toBe(minutes);
        expect(pickup.cents).toBeGreaterThanOrEqual(a.amount_cents);
        expect(delivery.cents).toBe(0);
      }
    });

    it(`keeps ${plan.carrier.slug}'s ordinary waits free, one at the limit, some not known`, () => {
      const plantSet = new Set(planted.detentionLoadIds);
      const billed = new Set(
        rows.load_accessorials.filter((a) => a.kind === "detention").map((a) => a.load_id),
      );
      let atLimit = 0;
      for (const load of stops) {
        if (plantSet.has(load.id) || billed.has(load.id) || load.pickupArrivedAt === null) continue;
        const customer = customers.find((c) => c.id === load.customerId)!;
        const result = detentionStops(load, customer)!;
        expect(result.map((s) => s.cents)).toEqual([0, 0]);
        if (result[1].dwellMinutes === customer.detentionFreeMinutes) atLimit++;
      }
      expect(atLimit).toBeGreaterThanOrEqual(1);
      const unknown = rows.loads.filter(
        (l) => l.delivered_at !== null && l.pickup_arrived_at === null,
      );
      expect(unknown.length).toBeGreaterThan(0);
      for (const l of unknown) expect(l.delivered_on! >= periods[3].start).toBe(true);
    });
  }
});

describe("payment styles and collections", () => {
  for (const plan of plans) {
    const { rows, planted } = plan;
    const input = receivablesInputOf(rows, ANCHOR);

    it(`reads ${plan.carrier.slug}'s prompt payers as reliable, slow ones as repeat late`, () => {
      const labels = rows.customers.map((c, i) => [
        customerClassOf(i),
        paymentProfile(c.id, input, ANCHOR).label,
      ]);
      for (const [style, label] of labels) {
        if (style === "prompt") expect(label).toBe("reliable");
        if (style === "slow") expect(label).toBe("repeat_late");
      }
    });

    it(`leaves ${plan.carrier.slug}'s named late invoices open in their buckets`, () => {
      const got = planted.collections.map((k) => {
        const i = rows.invoices.find((x) => x.id === k.invoiceId)!;
        const index = rows.customers.findIndex((c) => c.id === i.customer_id);
        const late = daysBetween(i.due_on, ANCHOR);
        const bucket = agingBucket(i.due_on, ANCHOR);
        return [index, k.customerClass, i.status, late, bucket, i.amount_cents];
      });
      expect(got).toEqual([
        [2, "slow", "open", 34, "31_60", 248000],
        [2, "slow", "open", 62, "61_90", 196000],
        [2, "slow", "open", 97, "over_90", 312000],
        [0, "prompt", "open", 12, "1_30", 174000],
      ]);
    });

    it(`never leaves a ${plan.carrier.slug} prompt payer open past 30 days or paid in part`, () => {
      rows.customers.forEach((c, index) => {
        if (customerClassOf(index) !== "prompt") return;
        for (const i of rows.invoices.filter((x) => x.customer_id === c.id)) {
          expect(i.status).not.toBe("partially_paid");
          if (i.status !== "paid") expect(daysBetween(i.due_on, ANCHOR)).toBeLessThanOrEqual(30);
        }
      });
    });
  }
});
