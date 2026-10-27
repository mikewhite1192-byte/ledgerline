import { configForDay } from "../data/config-version";
import { driverOf, payConfigOf } from "../data/records";
import type {
  AdvanceRow,
  DriverArmEventRow,
  DriverCardRow,
  DriverIdentityRow,
  DriverRow,
  PayConfigKnobs,
} from "../data/rows";
import { compareText, driverPayOnLoad, mulBps, type LoadRecord } from "../rules-engine";
import { addDays, isWithin, localDateOf, type LocalDate, type Period } from "../time/local-date";
import { seededAdvanceDecision } from "./assert-plan";
import { instantAt } from "./calendar";
import type { Rng } from "./prng";

// The advance parity rows (migration 0027): who is armed to receive money, the id the dispatch
// system knows each driver by, the extra cards a driver can hold, the load an advance is for, and
// a take-back. Everything here draws from its own stream (`<seed>:parity`), in a fixed order, so
// no row the other streams make moves.

export type ParityPlanted = {
  // The one driver nobody has armed: never the hero, no seeded advance.
  disarmedDriverId: string;
  // Two paid advances on one load in the open week, together under the load's cap.
  loadPairLoadId: string;
  loadPairAdvanceIds: [string, string];
  // A paid advance in the oldest settled week taken back in full (wrong driver), after history.
  takenBackAdvanceId: string;
  // On a carrier with a hero only: a second named card on the hero's neighbor, a generic card and
  // a closed card. Null elsewhere.
  extraCardId: string | null;
  genericCardId: string | null;
  closedCardId: string | null;
};

type Versions = readonly (PayConfigKnobs & { effective_from: LocalDate })[];

export type AdvanceDraft = Omit<AdvanceRow, "request_ref"> & { ref?: string };

// A seeded driver is armed from the morning they started.
export function armedAt(activeFrom: LocalDate, zone: string): string {
  return instantAt(activeFrom, 8, 0, zone);
}

const loadCapOf = (versions: Versions, driver: DriverRow, load: LoadRecord, on: LocalDate) => {
  const version = configForDay(versions, on);
  const bps = version.advance_per_load_bps_of_pay;
  if (bps === null) return null;
  const pay = driverPayOnLoad(payConfigOf(version), driverOf(driver), load);
  return { pay, cap: mulBps(pay, bps) };
};

const roundDown2500 = (n: number) => Math.floor(n / 2500) * 2500;

// Stands in for the first advance's id while the second one's room is worked out.
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

// Two paid advances on one load, for a driver with no other advance: the first is half of what
// the engine allows with the load named, the second about three quarters of what is left (never
// the same amount), asked a day apart after the load delivered. Both are ones the engine grants with the load named, and their
// sum with fees stays under the load's cap.
export function plantLoadPair(a: {
  parity: Rng;
  slug: string;
  zone: string;
  drivers: readonly DriverRow[];
  skip: ReadonlySet<string>;
  victims: ReadonlySet<string>;
  loads: readonly LoadRecord[];
  versions: Versions;
  periods: readonly Period[];
  lastDay: LocalDate;
}): { loadId: string; rows: [AdvanceDraft, AdvanceDraft] } {
  const open = a.periods[3];
  const free = a.drivers.filter((d) => !a.skip.has(d.code));
  const candidates = [
    ...a.parity.shuffle(free.filter((d) => !a.victims.has(d.code))),
    ...a.parity.shuffle(free.filter((d) => a.victims.has(d.code))),
  ];
  const last = open.end < a.lastDay ? open.end : a.lastDay;
  for (const d of candidates) {
    const load = a.loads
      .filter(
        (l) =>
          l.driverId === d.id &&
          l.deliveredOn !== null &&
          isWithin(l.deliveredOn, open) &&
          addDays(l.deliveredOn, 2) <= last,
      )
      .sort((x, y) => compareText(y.deliveredOn!, x.deliveredOn!) || compareText(x.id, y.id))[0];
    if (!load) continue;
    const day1 = addDays(load.deliveredOn!, 1);
    const day2 = addDays(load.deliveredOn!, 2);
    const capped = loadCapOf(a.versions, d, load, day1);
    if (!capped) continue;
    const draft = (id: string, day: LocalDate, hour: number, minute: number, amount: number, ref: string) => {
      const at = instantAt(day, hour, minute, a.zone);
      const row: AdvanceDraft = {
        id,
        driver_id: d.id,
        requested_at: at,
        requested_on: localDateOf(at, a.zone),
        amount_cents: amount,
        fee_cents: configForDay(a.versions, day).advance_fee_cents,
        status: "paid",
        recovered_cents: 0,
        source: "seed",
        reason_category: null,
        paid_at: new Date(Date.parse(at) + 35 * 60_000).toISOString(),
        proposal_id: null,
        source_input_id: null,
        decided_at: null,
        decided_by_membership_id: null,
        load_id: load.id,
        taken_back_cents: 0,
        taken_back_at: null,
        taken_back_by_membership_id: null,
        takeback_reason: null,
        ref,
      };
      return row;
    };
    const decide = (at: string, amount: number, prior: AdvanceRow[]) =>
      seededAdvanceDecision({
        config: payConfigOf(configForDay(a.versions, localDateOf(at, a.zone))),
        driver: d,
        loads: a.loads,
        periods: a.periods,
        zone: a.zone,
        at,
        amountCents: amount,
        prior,
        load: { id: load.id, payCents: capped.pay },
      });
    const asRow = (x: AdvanceDraft): AdvanceRow => ({ ...x, request_ref: x.ref ?? x.id });
    const at1 = instantAt(day1, 9, 10, a.zone);
    const at2 = instantAt(day2, 14, 35, a.zone);
    const floor = (day: LocalDate) => Math.max(2500, configForDay(a.versions, day).advance_min_cents);
    const first = roundDown2500(decide(at1, floor(day1), []).maxCents / 2);
    if (first < floor(day1) || !decide(at1, first, []).eligible) continue;
    // The amounts are settled before any id is drawn, so a driver passed over moves nothing.
    const trial = asRow(draft(PLACEHOLDER_ID, day1, 9, 10, first, "trial"));
    let second = roundDown2500((decide(at2, floor(day2), [trial]).maxCents * 3) / 4);
    if (second === first) second -= 2500;
    if (second < floor(day2) || !decide(at2, second, [trial]).eligible) continue;
    const one = draft(a.parity.uuid(), day1, 9, 10, first, `${a.slug}-adv-load-a`);
    const two = draft(a.parity.uuid(), day2, 14, 35, second, `${a.slug}-adv-load-b`);
    const owed = one.amount_cents + one.fee_cents + two.amount_cents + two.fee_cents;
    if (owed > capped.cap) throw new Error("the load pair is over the load's cap");
    return { loadId: load.id, rows: [one, two] };
  }
  throw new Error("no driver has a load for the planted load pair");
}

// Every other seeded advance names the driver's latest load delivered on or before the day it was
// asked for, within 14 days, when what it owes still fits under that load's cap with the advances
// already named against it (amount plus fee, before any recovery, so a settlement can only make
// room). Otherwise it names no load. No random draws.
export function linkAdvanceLoads(
  drafts: readonly AdvanceDraft[],
  drivers: readonly DriverRow[],
  loads: readonly LoadRecord[],
  versions: Versions,
): void {
  const byId = new Map(drivers.map((d) => [d.id, d]));
  const owedOn = new Map<string, number>();
  for (const x of drafts) {
    if (x.load_id !== null) owedOn.set(x.load_id, (owedOn.get(x.load_id) ?? 0) + x.amount_cents + x.fee_cents);
  }
  const ordered = [...drafts].sort(
    (x, y) => compareText(x.requested_at, y.requested_at) || compareText(x.id, y.id),
  );
  for (const x of ordered) {
    if (x.load_id !== null) continue;
    const from = addDays(x.requested_on, -14);
    const load = loads
      .filter(
        (l) =>
          l.driverId === x.driver_id &&
          l.deliveredOn !== null &&
          l.deliveredOn <= x.requested_on &&
          l.deliveredOn >= from,
      )
      .sort((p, q) => compareText(q.deliveredOn!, p.deliveredOn!) || compareText(p.id, q.id))[0];
    if (!load) continue;
    const capped = loadCapOf(versions, byId.get(x.driver_id)!, load, x.requested_on);
    const owed = (owedOn.get(load.id) ?? 0) + x.amount_cents + x.fee_cents;
    if (capped !== null && owed > capped.cap) continue;
    x.load_id = load.id;
    owedOn.set(load.id, owed);
  }
}

// The advance to take back: one paid advance asked for in the open week (periods[3]). History
// settles only the paid weeks, and a settlement recovers only advances asked for by its last day,
// so nothing has been recovered on it and the whole amount can come back without the recovery
// and the take-back ever passing what was lent. Drawn here, before history, so its one draw keeps
// its place on the parity stream; plantTakeBack records it.
export function chooseTakeBack(parity: Rng, candidates: readonly AdvanceDraft[], periods: readonly Period[]): string {
  const open = periods[3];
  const inWeek = candidates
    .filter((x) => x.status === "paid" && x.paid_at !== null && isWithin(x.requested_on, open))
    .sort((x, y) => compareText(x.requested_at, y.requested_at) || compareText(x.id, y.id));
  if (inWeek.length === 0) throw new Error("no open-week advance to take back");
  return parity.pick(inWeek).id;
}

// The chosen advance, taken back in full three hours after it was paid because it went to the
// wrong driver. Set after history has run, which never recovered it, so every settled week keeps
// its net; the open week then recovers only its fee. An advance any settlement recovered from is
// refused, so the recovery and the take-back never count the same money twice.
export function plantTakeBack(advances: readonly AdvanceRow[], id: string): AdvanceRow {
  const x = advances.find((a) => a.id === id);
  if (!x || x.status !== "paid" || x.paid_at === null) throw new Error("the advance to take back is not paid");
  if (x.recovered_cents !== 0) throw new Error("the advance to take back was already recovered from pay");
  x.taken_back_cents = x.amount_cents;
  x.taken_back_at = new Date(Date.parse(x.paid_at) + 3 * 60 * 60_000).toISOString();
  x.takeback_reason = "wrong_driver";
  return x;
}

// The disarmed driver: the highest code that is not the hero, holds no planted card behavior, has
// no seeded advance and carries no planted problem.
export function chooseDisarmed(
  drivers: readonly DriverRow[],
  cards: readonly DriverCardRow[],
  heroCode: string | null,
  withAdvance: ReadonlySet<string>,
  victims: ReadonlySet<string>,
): DriverRow {
  const plain = new Set(cards.filter((c) => c.sim_behavior === "ok").map((c) => c.driver_id));
  const pick = [...drivers]
    .sort((x, y) => compareText(y.code, x.code))
    .find(
      (d) =>
        d.code !== heroCode && plain.has(d.id) && !withAdvance.has(d.id) && !victims.has(d.code),
    );
  if (!pick) throw new Error("no driver can be the disarmed one");
  return pick;
}

// FUEL-CARD's one card per driver (already each driver's default). On a carrier with a hero, three
// more: a second named card on the hero's neighbor (the hero keeps exactly one), a generic card
// with a portal placeholder on a mid-code driver, and a card closed 60 days before the anchor on
// the next one. Never on the disarmed driver or a planted card driver. Last four stay unique.
export function parityCards(a: {
  parity: Rng;
  base: readonly DriverCardRow[];
  drivers: readonly DriverRow[];
  heroCode: string | null;
  avoid: ReadonlySet<string>;
  anchor: LocalDate;
  zone: string;
}): { cards: DriverCardRow[]; extra: string | null; generic: string | null; closed: string | null } {
  const cards: DriverCardRow[] = [...a.base];
  if (!a.heroCode) return { cards, extra: null, generic: null, closed: null };
  const used = new Set(cards.map((c) => c.last4));
  const plain = new Set(a.base.filter((c) => c.sim_behavior === "ok").map((c) => c.driver_id));
  const card = (driver: DriverRow, more: Partial<DriverCardRow>): DriverCardRow => {
    const id = a.parity.uuid();
    const token = `fcs_card_${a.parity.uuid().replace(/-/g, "").slice(0, 24)}`;
    let last4 = "";
    do {
      last4 = String(a.parity.int(0, 9999)).padStart(4, "0");
    } while (used.has(last4));
    used.add(last4);
    const row: DriverCardRow = {
      id,
      driver_id: driver.id,
      rail: "fuel_card",
      provider: "fuel_card_sim",
      provider_token: token,
      last4,
      status: "active",
      sim_behavior: "ok",
      source: "seed",
      closed_at: null,
      is_default: false,
      holder_kind: "named",
      portal_name: null,
      ...more,
    };
    cards.push(row);
    return row;
  };
  const sorted = [...a.drivers].sort((x, y) => compareText(x.code, y.code));
  const heroAt = sorted.findIndex((d) => d.code === a.heroCode);
  const usable = (d: DriverRow | undefined): d is DriverRow =>
    d !== undefined && d.code !== a.heroCode && plain.has(d.id) && !a.avoid.has(d.id);
  const neighbor = sorted.slice(heroAt + 1).find(usable);
  if (!neighbor) throw new Error("the hero has no neighbor for a second card");
  const extra = card(neighbor, {});
  const middle = sorted.slice(Math.floor(sorted.length / 2)).filter((d) => usable(d) && d.id !== neighbor.id);
  if (middle.length < 2) throw new Error("no mid-code drivers for the generic and closed cards");
  const generic = card(middle[0], {
    holder_kind: "generic",
    portal_name: `POOL CARD ${a.parity.int(1, 9)}`,
  });
  const closed = card(middle[1], {
    status: "closed",
    closed_at: instantAt(addDays(a.anchor, -60), 10, 0, a.zone),
  });
  return { cards, extra: extra.id, generic: generic.id, closed: closed.id };
}

// One dispatch-system id per driver, TMS-<prefix>-<5 digits>, unique within the carrier.
export function driverIdentities(parity: Rng, drivers: readonly DriverRow[], prefix: string): DriverIdentityRow[] {
  const used = new Set<string>();
  return [...drivers]
    .sort((x, y) => compareText(x.code, y.code))
    .map((d) => {
      let external = "";
      do {
        external = `TMS-${prefix}-${parity.int(10000, 99999)}`;
      } while (used.has(external));
      used.add(external);
      return { id: parity.uuid(), driver_id: d.id, system: "tms" as const, external_id: external, source: "seed" as const };
    });
}

// One seed row per driver on the arming log, saying where they stand.
export function armEvents(parity: Rng, drivers: readonly DriverRow[]): DriverArmEventRow[] {
  return [...drivers]
    .sort((x, y) => compareText(x.code, y.code))
    .map((d) => ({
      id: parity.uuid(),
      driver_id: d.id,
      armed: d.money_armed,
      note: null,
      membership_id: null,
      source: "seed" as const,
    }));
}
