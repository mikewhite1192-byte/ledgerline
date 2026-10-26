import { addDays, type LocalDate, type Period } from "../time/local-date";
import { assertCents, assertCount, cents, mul, roundHalfUp, sum } from "./money";
import {
  assertDate,
  assertId,
  assertPeriod,
  compareText,
  instantMs,
  InputError,
  type CustomerRecord,
  type LoadStopsRecord,
  type Stop,
  type StopDetention,
  type UnbilledDetention,
} from "./types";

// Detention (addendum B3): time a truck waited at a stop past the customer's free time, billed
// per started quarter hour at the customer's hourly rate. The stop times come from the bill of
// lading; a load whose times are not known is never a finding (unknown is not zero).

const MINUTE_MS = 60_000;

function terms(customer: CustomerRecord): { free: number; hourly: number } {
  const id = assertId(customer?.id, "customer id");
  const free = assertCount(customer.detentionFreeMinutes, `customer ${id} detentionFreeMinutes`);
  if (free > 600) throw new InputError(`customer ${id} detentionFreeMinutes is out of range`);
  const hourly = assertCents(customer.detentionHourlyCents, `customer ${id} detentionHourlyCents`);
  if (hourly < 0) throw new InputError(`customer ${id} detentionHourlyCents is negative`);
  return { free, hourly };
}

// One stop: whole minutes at the stop, the minutes past free, the started quarters, the cents.
// Null when either time is missing; a stop with only one time is malformed.
function stopDetention(
  load: LoadStopsRecord,
  stop: Stop,
  arrivedAt: string | null,
  departedAt: string | null,
  customer: CustomerRecord,
): StopDetention | null {
  if (arrivedAt === null && departedAt === null) return null;
  if (arrivedAt === null || departedAt === null) {
    throw new InputError(`load ${load.id} has only one ${stop} time`);
  }
  const ms =
    instantMs(departedAt, `load ${load.id} ${stop} departure`) -
    instantMs(arrivedAt, `load ${load.id} ${stop} arrival`);
  if (ms < 0) throw new InputError(`load ${load.id} leaves ${stop} before it arrives`);
  const { free, hourly } = terms(customer);
  const dwellMinutes = Math.floor(ms / MINUTE_MS);
  const overMinutes = Math.max(0, dwellMinutes - free);
  const quarters = Math.ceil(overMinutes / 15);
  return {
    stop,
    dwellMinutes,
    overMinutes,
    quarters,
    cents: cents(roundHalfUp(mul(quarters, hourly), 4)),
  };
}

// Both stops of one load, pickup first, or null when either stop's times are not known.
export function detentionStops(
  load: LoadStopsRecord,
  customer: CustomerRecord,
): StopDetention[] | null {
  assertId(load?.id, "load id");
  if (load.customerId !== customer?.id) {
    throw new InputError(`load ${load.id} is not for customer ${customer?.id}`);
  }
  const { pickupArrivedAt: pa, pickupDepartedAt: pd } = load;
  const { deliveryArrivedAt: da, deliveryDepartedAt: dd } = load;
  const pickup = stopDetention(load, "pickup", pa, pd, customer);
  const delivery = stopDetention(load, "delivery", da, dd, customer);
  return pickup && delivery ? [pickup, delivery] : null;
}

// The detention a load earned, both stops together; null when its times are not known.
export function detentionCents(load: LoadStopsRecord, customer: CustomerRecord): number | null {
  const stops = detentionStops(load, customer);
  return stops ? sum(stops.map((s) => s.cents)) : null;
}

// Delivered loads with delivered_on inside the window whose stop times earn detention and that
// carry no detention charge yet: the money the carrier has not billed. In load number order.
export function findUnbilledDetention(
  loads: readonly LoadStopsRecord[],
  customers: readonly CustomerRecord[],
  accessorials: readonly { loadId: string; kind: string }[],
  window: Period,
): UnbilledDetention[] {
  const { start, end } = assertPeriod(window);
  const byId = new Map(customers.map((c) => [assertId(c?.id, "customer id"), c]));
  const billed = new Set(accessorials.filter((a) => a.kind === "detention").map((a) => a.loadId));
  const out: UnbilledDetention[] = [];
  for (const load of loads) {
    assertId(load?.id, "load id");
    if (load.deliveredOn === null || billed.has(load.id)) continue;
    const on = assertDate(load.deliveredOn, `load ${load.id} deliveredOn`);
    if (on < start || on > end) continue;
    if (load.customerId === null) continue;
    const customer = byId.get(load.customerId);
    if (!customer) throw new InputError(`load ${load.id} names no known customer`);
    const stops = detentionStops(load, customer);
    if (!stops) continue;
    const earning = stops.filter((s) => s.cents > 0);
    if (earning.length === 0) continue;
    out.push({
      loadId: load.id,
      loadNumber: load.loadNumber,
      customerId: customer.id,
      deliveredOn: on,
      stops: earning,
      amountCents: sum(earning.map((s) => s.cents)),
      sources: [
        { table: "loads", id: load.id },
        { table: "customers", id: customer.id },
      ],
    });
  }
  return out.sort(
    (a, b) => compareText(a.loadNumber, b.loadNumber) || compareText(a.loadId, b.loadId),
  );
}

// The last full calendar month that ends before asOf, in the tenant's own dates: the month
// before asOf's month (for 2026-11-01 and 2026-11-02 alike, October 2026).
export function lastFullMonthBefore(asOf: LocalDate): Period {
  const end = addDays(`${assertDate(asOf, "asOf").slice(0, 8)}01`, -1);
  return { start: `${end.slice(0, 8)}01`, end };
}
