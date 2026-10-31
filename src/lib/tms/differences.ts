// TMS-MIRROR: where the dispatch system's copy of a load and our own load disagree, worked out in
// code only. The agent reads these; it never computes a difference itself and nothing here writes.
// Money is integer cents on both sides; times are instants compared in milliseconds. Pure.

// More than this between the dispatch pickup (or delivery) time and ours is a difference worth saying.
export const PICKUP_SLACK_MINUTES = 30;
export const DELIVERY_SLACK_MINUTES = 30;

// How far along a load is, on a scale both sides share: 0 not picked up, 1 on the road,
// 2 delivered (or past it). A code with no place on the scale (on hold, breakdown, claim, board,
// archived, custom, withdrawn) is never compared.
const TMS_RANK: Readonly<Record<string, number>> = {
  new: 0,
  tendered: 0,
  booked: 0,
  in_transit: 1,
  delivered: 2,
  review: 2,
  pay_ready: 2,
  finalized: 2,
  invoice_hold: 2,
  invoiced: 2,
  paid: 2,
};
const OUR_RANK: Readonly<Record<string, number>> = { planned: 0, in_transit: 1, delivered: 2, invoiced: 2 };

export type TmsSide = {
  statusCode: string;
  revenueTotalCents: number | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  goneAt: string | null;
  flags: readonly string[];
  hasPodDocument: boolean;
};

export type OurSide = {
  status: string;
  // Linehaul plus fuel surcharge plus every extra charge on the load; null while the rate is unknown.
  revenueCents: number | null;
  // When the truck left the pickup (loads.pickup_departed_at); null while not known.
  pickedUpAt: string | null;
  deliveredAt: string | null;
  hasPod: boolean;
};

export type Difference =
  | { kind: "rate_differs"; dispatchCents: number; oursCents: number; deltaCents: number }
  | { kind: "status_ahead"; dispatchStatus: string; ourStatus: string }
  | { kind: "status_behind"; dispatchStatus: string; ourStatus: string }
  | { kind: "pickup_time_differs"; dispatchAt: string; oursAt: string; minutesApart: number }
  | { kind: "delivery_time_differs"; dispatchAt: string; oursAt: string; minutesApart: number }
  | { kind: "pod_in_dispatch_not_here" }
  | { kind: "gone_from_dispatch"; goneAt: string }
  | { kind: "edited_after_finalize" };

const safeCents = (n: number | null): n is number => n !== null && Number.isSafeInteger(n);

function instantMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Every difference between the two sides, in a fixed order. Nothing is said about a value either
// side does not know: a null rate, a missing time or a status off the shared scale.
export function differencesOf(tms: TmsSide, ours: OurSide): Difference[] {
  const out: Difference[] = [];
  if (safeCents(tms.revenueTotalCents) && safeCents(ours.revenueCents) && tms.revenueTotalCents !== ours.revenueCents) {
    out.push({
      kind: "rate_differs",
      dispatchCents: tms.revenueTotalCents,
      oursCents: ours.revenueCents,
      deltaCents: tms.revenueTotalCents - ours.revenueCents,
    });
  }
  const theirs = Object.hasOwn(TMS_RANK, tms.statusCode) ? TMS_RANK[tms.statusCode] : null;
  const mine = Object.hasOwn(OUR_RANK, ours.status) ? OUR_RANK[ours.status] : null;
  if (theirs !== null && mine !== null && theirs !== mine) {
    out.push({
      kind: theirs > mine ? "status_ahead" : "status_behind",
      dispatchStatus: tms.statusCode,
      ourStatus: ours.status,
    });
  }
  const p = instantMs(tms.pickedUpAt);
  const o = instantMs(ours.pickedUpAt);
  if (p !== null && o !== null && tms.pickedUpAt !== null && ours.pickedUpAt !== null) {
    const minutes = Math.round(Math.abs(p - o) / 60_000);
    if (minutes > PICKUP_SLACK_MINUTES) {
      out.push({ kind: "pickup_time_differs", dispatchAt: tms.pickedUpAt, oursAt: ours.pickedUpAt, minutesApart: minutes });
    }
  }
  const a = instantMs(tms.deliveredAt);
  const b = instantMs(ours.deliveredAt);
  if (a !== null && b !== null && tms.deliveredAt !== null && ours.deliveredAt !== null) {
    const minutes = Math.round(Math.abs(a - b) / 60_000);
    if (minutes > DELIVERY_SLACK_MINUTES) {
      out.push({ kind: "delivery_time_differs", dispatchAt: tms.deliveredAt, oursAt: ours.deliveredAt, minutesApart: minutes });
    }
  }
  if (tms.hasPodDocument && !ours.hasPod) out.push({ kind: "pod_in_dispatch_not_here" });
  if (tms.goneAt !== null) out.push({ kind: "gone_from_dispatch", goneAt: tms.goneAt });
  if (tms.flags.includes("edited_after_finalize")) out.push({ kind: "edited_after_finalize" });
  return out;
}

// Our revenue for the comparison: linehaul plus fuel surcharge plus every extra charge, in cents;
// null while the linehaul is not known (a load with no rate yet is never called different).
export function ourRevenueCents(
  linehaulCents: number | null,
  fuelSurchargeCents: number | null,
  accessorialCents: readonly number[],
): number | null {
  if (!safeCents(linehaulCents)) return null;
  let sum = linehaulCents + (safeCents(fuelSurchargeCents) ? fuelSurchargeCents : 0);
  for (const c of accessorialCents) {
    if (!safeCents(c)) return null;
    sum += c;
  }
  return Number.isSafeInteger(sum) ? sum : null;
}

// Minutes between arriving at a stop and leaving it, from the two resolved instants; null when
// either is unknown or they run backward (never zero for unknown).
export function dwellMinutes(arrivedAt: string | null, completedAt: string | null): number | null {
  const a = instantMs(arrivedAt);
  const b = instantMs(completedAt);
  if (a === null || b === null || b < a) return null;
  return Math.round((b - a) / 60_000);
}

