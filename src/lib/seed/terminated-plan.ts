import { configFor } from "../data/config-version";
import type {
  DeductionScheduleRow,
  DriverArmEventRow,
  DriverCardRow,
  DriverIdentityRow,
  DriverRow,
  LoadRow,
  LoadStateMilesRow,
  SettlementPeriodRow,
  TenantRows,
} from "../data/rows";
import { compareText, roundHalfUp } from "../rules-engine";
import { addDays, localDateOf, type LocalDate, type Period } from "../time/local-date";
import { instantAt } from "./calendar";
import type { DemoCarrier } from "./carriers";
import { applyHistory } from "./history";
import { LANES, laneMiles, reverseLane, type Lane } from "./lanes";
import { armedAt } from "./parity-plan";
import { Rng } from "./prng";

// The departed driver (ESCROW-SEED): one owner-operator per demo carrier who drove three old weeks,
// left, and still has the escrow those weeks withheld. Their release is due once 90 days have
// passed since they left (src/lib/escrow/due.ts), and their statement matches the balance because
// the balance is what the engine withheld in those paid weeks and nothing else.
//
// Every id and pick comes from its own stream (`<seed>:terminated`), and the rows are appended
// after every other builder has run (plan.ts), so no other seeded row, id or pick moves. The old
// weeks are settled by applyHistory on rows holding this driver alone, so their settlements and
// lines draw from this stream too, and the driver is skipped in the four demo weeks (history.ts
// settles only drivers active in the period).

// How many old paid weeks the driver worked, and how many weeks before the first demo week the
// first of them starts: weeks W-13, W-12 and W-11, so the driver left 10 weeks before the demo
// weeks begin (about 99 days before the demo anchor).
export const DEPARTED_WEEKS = 3;
const WEEKS_BACK = 13;
// Regional loads at least this long pay enough that the full escrow step is withheld each week.
const MIN_LOADED_MILES = 400;
const PERCENT_BPS = 7400;
const MINUTE_MS = 60_000;

// The old weeks, oldest first: the first demo week shifted back 13, 12 and 11 weeks.
export function departedPeriods(periods: readonly Period[]): Period[] {
  const first = periods[0];
  if (!first) throw new Error("the plan has no first week");
  return Array.from({ length: DEPARTED_WEEKS }, (_, i) => {
    const back = -7 * (WEEKS_BACK - i);
    return { start: addDays(first.start, back), end: addDays(first.end, back) };
  });
}

export type DepartedArgs = {
  carrier: DemoCarrier;
  seed: string;
  periods: readonly Period[];
  rows: TenantRows;
  // Unused names from the plan's shuffled name lists, so the driver's name repeats no other's.
  firstName: string;
  lastName: string;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const minutesBefore = (at: string, minutes: number) =>
  new Date(Date.parse(at) - minutes * MINUTE_MS).toISOString();

// Builds the departed driver and their old weeks, settles those weeks, and appends every row to
// `rows`. Fails closed on any shortfall or carried item: the story is a clean balance.
export function appendDeparted(args: DepartedArgs): void {
  const { carrier, seed, periods, rows } = args;
  const { prefix } = carrier;
  const zone = carrier.timezone;
  const t = new Rng(`${seed}:terminated`);
  const weeks = departedPeriods(periods);
  const activeFrom = addDays(weeks[0].start, -364);
  const activeTo = weeks[weeks.length - 1].end;
  if (activeTo >= periods[0].start) throw new Error("the departed driver overlaps the demo weeks");
  const version = configFor(rows.pay_configs, weeks[0].start);

  const n = rows.drivers.length + 1;
  const code = `${prefix}-D${pad2(n)}`;
  const driver: DriverRow = {
    id: t.uuid(),
    code,
    first_name: args.firstName,
    last_name: args.lastName,
    email: `${code.toLowerCase()}@${carrier.emailDomain}`,
    worker_type: "owner_operator",
    pay_basis: "percent",
    per_mile_cents: null,
    percent_bps: PERCENT_BPS,
    flat_per_load_cents: null,
    advance_limit_cents: null,
    escrow_balance_cents: 0,
    truck_unit: `${prefix}-T${100 + n}`,
    tank_gallons: t.int(20, 30) * 10,
    active_from: activeFrom,
    active_to: activeTo,
    preferred_language: "en",
    money_armed: true,
    money_armed_at: armedAt(activeFrom, zone),
    own_insurance: false,
  };

  const settlementPeriods: SettlementPeriodRow[] = weeks.map((w) => ({
    id: t.uuid(),
    period_start: w.start,
    period_end: w.end,
    status: "paid",
  }));

  // One regional load a week, at least 400 loaded miles, delivered inside the week.
  const long = LANES[prefix].regional.filter((l) => laneMiles(l) >= MIN_LOADED_MILES);
  if (long.length === 0) throw new Error("the carrier has no lane long enough for the departed driver");
  const loads: LoadRow[] = [];
  const stateMiles: LoadStateMilesRow[] = [];
  weeks.forEach((w, i) => {
    const picked = t.pick(long);
    const lane: Lane = t.chance(1, 2) ? picked : reverseLane(picked);
    const loaded = laneMiles(lane);
    const span = loaded <= 600 ? 2 : 3;
    const pickup = addDays(w.start, t.int(0, 2));
    const delivered = addDays(pickup, span - 1);
    if (delivered > w.end) throw new Error("a departed driver's load left its week");
    const deliveredAt = instantAt(delivered, t.int(6, 19), t.int(0, 59), zone);
    if (localDateOf(deliveredAt, zone) !== delivered) throw new Error("delivery left its day");
    const customer = t.pick(rows.customers);
    const row: LoadRow = {
      id: t.uuid(),
      load_number: `${prefix}-L${9981 + i}`,
      customer_id: customer.id,
      driver_id: driver.id,
      status: "invoiced",
      origin_city: lane.from.city,
      origin_state: lane.from.state,
      dest_city: lane.to.city,
      dest_state: lane.to.state,
      pickup_on: pickup,
      delivered_on: delivered,
      delivered_at: deliveredAt,
      loaded_miles: loaded,
      empty_miles: t.int(30, 180),
      linehaul_cents: roundHalfUp(loaded * t.int(210, 320), 100) * 100,
      fuel_surcharge_cents: roundHalfUp(loaded * t.int(40, 60), 100) * 100,
      pickup_arrived_at: null,
      pickup_departed_at: null,
      delivery_arrived_at: null,
      delivery_departed_at: null,
    };
    // Stop times as plan.ts sets a multi-day load's: loaded during the pickup day, a wait at
    // each end, and the delivery departure at the signed delivery.
    const deliveryDwell = t.int(20, 85);
    const pickupDwell = t.int(25, 85);
    const pickupDeparted = instantAt(pickup, t.int(6, 14), t.int(0, 59), zone);
    row.pickup_arrived_at = minutesBefore(pickupDeparted, pickupDwell);
    row.pickup_departed_at = pickupDeparted;
    row.delivery_arrived_at = minutesBefore(deliveredAt, deliveryDwell);
    row.delivery_departed_at = deliveredAt;
    loads.push(row);
    // Miles per state, the empty miles on the first state (the deadhead), as plan.ts does.
    lane.states.forEach(([state, miles], k) => {
      stateMiles.push({ id: t.uuid(), load_id: row.id, state, miles: k === 0 ? miles + row.empty_miles : miles });
    });
  });

  const schedule: DeductionScheduleRow = {
    id: t.uuid(),
    driver_id: driver.id,
    kind: "escrow",
    amount_cents: version.escrow_per_settlement_cents,
    target_cents: version.escrow_target_cents,
    description: "Escrow",
    active_from: driver.active_from,
    active_to: driver.active_to,
  };

  // The card they fueled on, closed the morning after they left. Its last four and token repeat
  // no card on file and no line on the provider's statement.
  const usedLast4 = new Set([
    ...rows.driver_cards.map((c) => c.last4),
    ...rows.card_transactions.map((x) => x.card_last4),
  ]);
  const usedTokens = new Set([
    ...rows.driver_cards.map((c) => c.provider_token),
    ...rows.card_transactions.map((x) => x.card_token),
  ]);
  const cardId = t.uuid();
  let token = "";
  do token = `fcs_card_${t.uuid().replace(/-/g, "").slice(0, 24)}`;
  while (usedTokens.has(token));
  let last4 = "";
  do last4 = String(t.int(0, 9999)).padStart(4, "0");
  while (usedLast4.has(last4));
  const card: DriverCardRow = {
    id: cardId,
    driver_id: driver.id,
    rail: "fuel_card",
    provider: "fuel_card_sim",
    provider_token: token,
    last4,
    status: "closed",
    sim_behavior: "ok",
    source: "seed",
    closed_at: instantAt(addDays(activeTo, 1), 10, 0, zone),
    is_default: false,
    holder_kind: "named",
    portal_name: null,
  };

  const usedTms = new Set(rows.driver_identities.map((x) => x.external_id));
  let external = "";
  do external = `TMS-${prefix}-${t.int(10000, 99999)}`;
  while (usedTms.has(external));
  const identity: DriverIdentityRow = {
    id: t.uuid(),
    driver_id: driver.id,
    system: "tms",
    external_id: external,
    source: "seed",
  };
  const armEvent: DriverArmEventRow = {
    id: t.uuid(),
    driver_id: driver.id,
    armed: driver.money_armed,
    note: null,
    membership_id: null,
    source: "seed",
  };

  // Settle the old weeks by the engine, on rows that hold this driver alone, with every paid and
  // open week in date order so history skips the weeks the driver was gone.
  const own: TenantRows = {
    ...rows,
    drivers: [driver],
    loads,
    load_state_miles: stateMiles,
    load_accessorials: [],
    driver_days: [],
    deduction_schedules: [schedule],
    advances: [],
    pay_items: [],
    settlement_periods: [...settlementPeriods, ...rows.settlement_periods].sort((a, b) =>
      compareText(a.period_start, b.period_start),
    ),
    settlements: [],
    settlement_lines: [],
  };
  applyHistory({ slug: carrier.slug, zone, rows: own, newId: () => t.uuid() });
  if (own.pay_items.length !== 0) throw new Error("the departed driver's history carried a shortfall");
  if (own.settlements.length !== DEPARTED_WEEKS) throw new Error("the departed driver was not settled once a week");

  rows.drivers.push(driver);
  rows.loads.push(...loads);
  rows.load_state_miles.push(...stateMiles);
  rows.deduction_schedules.push(schedule);
  rows.driver_cards.push(card);
  rows.driver_identities.push(identity);
  rows.driver_arm_events.push(armEvent);
  // The old weeks go after the demo weeks, so the first period row stays the first demo week.
  rows.settlement_periods.push(...settlementPeriods);
  rows.settlements.push(...own.settlements);
  rows.settlement_lines.push(...own.settlement_lines);
}

// The departed driver's first week's start: the opening pay rules version is dated back to it,
// so the old weeks settle under the policy in force when the driver drove.
export function departedStart(periods: readonly Period[]): LocalDate {
  return departedPeriods(periods)[0].start;
}
