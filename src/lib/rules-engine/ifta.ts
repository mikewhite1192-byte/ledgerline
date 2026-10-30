import { checkLoad, isDelivered } from "./load-pay";
import { assertCount, cents, mul, roundHalfUp, sub, sum } from "./money";
import {
  assertDate,
  assertId,
  assertPeriod,
  assertUniqueIds,
  compareText,
  InputError,
  type Cents,
  type FuelPurchaseRecord,
  type LoadRecord,
  type Period,
} from "./types";

// The IFTA quarter (design-ifta 2): miles per state from the loads delivered in the quarter, the
// tax-paid gallons bought in each state, the fleet MPG, the taxable and net gallons per state and
// the tax due or credit at the given rates. Pure: no clock, zone or reads; the dates are the
// stored carrier-local dates. Integers only: miles are whole, gallons are thousandths of a gallon
// (milli), the fleet MPG is thousandths of a mile per gallon, a rate is thousandths of a cent per
// gallon (the pinned_rates unit) and tax is integer cents, negative for a credit. Three roundings,
// each once at its named step and never on a total. A load or state the math cannot place is a
// gap, listed and left out of the totals, never filled with zero.

// thousandths of a cent per gallon ($0.2850 is 28500).
export type IftaRate = { state: string; rateMcents: number };

export type IftaGapKind = "no_state_split" | "state_miles_mismatch" | "state_not_in_rates";

export type IftaGap =
  | { kind: "no_state_split" | "state_miles_mismatch"; loadId: string; loadNumber: string; miles: number }
  | { kind: "state_not_in_rates"; state: string; miles: number; taxPaidGallonsMilli: number };

type IftaLoadGap = Extract<IftaGap, { loadId: string }>;

export type IftaState = {
  state: string;
  miles: number;
  taxPaidGallonsMilli: number;
  // null when the fleet MPG is unknown.
  taxableGallonsMilli: number | null;
  netGallonsMilli: number | null;
  // null when the state has no rate in the table.
  rateMcents: number | null;
  // null when the MPG or the rate is unknown; negative is a credit.
  taxCents: Cents | null;
};

export type IftaTotals = {
  miles: number;
  taxPaidGallonsMilli: number;
  taxableGallonsMilli: number | null;
  netGallonsMilli: number | null;
  // Over the states with a rate only; null when the fleet MPG is unknown.
  taxCents: Cents | null;
};

export type IftaQuarter = {
  quarter: Period;
  // Loads in the quarter whose miles are counted (gap loads are not), and purchases in it.
  loadsCounted: number;
  purchasesCounted: number;
  totalMiles: number;
  totalGallonsMilli: number;
  fleetMpgMilli: number | null;
  // By state code, A to Z.
  states: IftaState[];
  totals: IftaTotals;
  // States whose tax the tax total leaves out (no rate).
  statesWithoutRate: number;
  // The state with the largest positive tax due, the one driving the bill.
  largestTaxDue: { state: string; taxCents: Cents } | null;
  // Load gaps by load number, then rate gaps by state.
  gaps: IftaGap[];
  // Loaded plus empty miles of the gap loads.
  excludedMiles: number;
};

export type IftaInput = {
  loads: readonly LoadRecord[];
  fuel: readonly FuelPurchaseRecord[];
  rates: readonly IftaRate[];
};

// The pinned_rates plausible range for an IFTA rate, in thousandths of a cent per gallon.
export const IFTA_RATE_MIN_MCENTS = 1;
export const IFTA_RATE_MAX_MCENTS = 200_000;

const STATE = /^[A-Z]{2}$/;
// miles x 10^6 / gallons-milli is thousandths of an MPG; milli x mcents / 10^6 is cents.
const SCALE = 1_000_000;

// Rounding 1 (step 4): total miles / total gallons, in thousandths of a mile per gallon, rounded
// half up. null when there are no gallons or no miles to divide (unknown, not zero).
export function fleetMpgMilliOf(totalMiles: number, totalGallonsMilli: number): number | null {
  assertCount(totalMiles, "total miles");
  assertCount(totalGallonsMilli, "total gallons");
  if (totalGallonsMilli === 0 || totalMiles === 0) return null;
  const mpg = roundHalfUp(mul(totalMiles, SCALE, "miles x 10^6"), totalGallonsMilli);
  if (mpg === 0) throw new InputError("fleet MPG rounds to zero");
  return mpg;
}

// Rounding 2 (step 5): a state's miles / the ROUNDED fleet MPG, in thousandths of a gallon,
// rounded half up, so the CSV reproduces it from the miles column and the MPG in its note.
export function taxableMilliOf(miles: number, fleetMpgMilli: number): number {
  assertCount(miles, "state miles");
  return roundHalfUp(mul(miles, SCALE, "miles x 10^6"), fleetMpgMilli);
}

// Rounding 3 (step 6): net gallons x rate, in cents, rounded half away from zero (the magnitude
// rounded half up, the sign restored). Positive is tax due, negative a credit.
export function taxCentsOf(netGallonsMilli: number, rateMcents: number): Cents {
  const magnitude = roundHalfUp(mul(Math.abs(netGallonsMilli), rateMcents, "net x rate"), SCALE);
  return netGallonsMilli < 0 ? sub(0, magnitude) : cents(magnitude);
}

function checkRates(rates: readonly IftaRate[]): Map<string, number> {
  if (!Array.isArray(rates)) throw new InputError("rates is not a list");
  const out = new Map<string, number>();
  for (const r of rates) {
    if (typeof r?.state !== "string" || !STATE.test(r.state)) {
      throw new InputError("a rate state is not two capital letters");
    }
    const rate = r.rateMcents;
    if (!Number.isSafeInteger(rate) || rate < IFTA_RATE_MIN_MCENTS || rate > IFTA_RATE_MAX_MCENTS) {
      throw new InputError(`rate for ${r.state} is out of range`);
    }
    if (out.has(r.state)) throw new InputError(`rate for ${r.state} appears more than once`);
    out.set(r.state, rate);
  }
  return out;
}

function checkFuel(p: FuelPurchaseRecord): FuelPurchaseRecord {
  const id = assertId(p?.id, "fuel purchase id");
  const where = `fuel purchase ${id}`;
  assertDate(p.purchasedOn, `${where} purchasedOn`);
  if (typeof p.state !== "string" || !STATE.test(p.state)) {
    throw new InputError(`${where} state is not two capital letters`);
  }
  if (assertCount(p.gallonsMilli, `${where} gallonsMilli`) === 0) {
    throw new InputError(`${where} gallonsMilli is zero`);
  }
  return p;
}

const inside = (day: string, q: Period): boolean => q.start <= day && day <= q.end;

function add(map: Map<string, number>, state: string, value: number): void {
  map.set(state, sum([map.get(state) ?? 0, value]));
}

export function iftaQuarter(input: IftaInput, quarter: Period): IftaQuarter {
  const q = assertPeriod(quarter);
  const rates = checkRates(input?.rates);
  if (!Array.isArray(input.loads) || !Array.isArray(input.fuel)) {
    throw new InputError("loads or fuel is not a list");
  }
  const loads = assertUniqueIds(input.loads, "load").map((l) => checkLoad(l));
  assertUniqueIds(loads.flatMap((l) => l.stateMiles), "state-mile");
  const fuel = assertUniqueIds(input.fuel, "fuel purchase").map(checkFuel);

  // Steps 0 to 2: loads delivered in the quarter; a load whose split is missing or does not add up
  // is a gap, left out whole.
  const loadGaps: IftaLoadGap[] = [];
  const milesByState = new Map<string, number>();
  let loadsCounted = 0;
  for (const load of loads) {
    if (!isDelivered(load) || load.deliveredOn === null || !inside(load.deliveredOn, q)) continue;
    const miles = sum([load.loadedMiles, load.emptyMiles]);
    const split = sum(load.stateMiles.map((s) => s.miles));
    if (load.stateMiles.length === 0 || split !== miles) {
      const kind = load.stateMiles.length === 0 ? "no_state_split" : "state_miles_mismatch";
      loadGaps.push({ kind, loadId: load.id, loadNumber: load.loadNumber, miles });
      continue;
    }
    loadsCounted += 1;
    for (const s of load.stateMiles) add(milesByState, s.state, s.miles);
  }
  loadGaps.sort((a, b) => compareText(a.loadNumber, b.loadNumber) || compareText(a.loadId, b.loadId));

  // Step 3: tax-paid gallons by the state each purchase was made in.
  const paidByState = new Map<string, number>();
  let purchasesCounted = 0;
  for (const p of fuel) {
    if (!inside(p.purchasedOn, q)) continue;
    purchasesCounted += 1;
    add(paidByState, p.state, p.gallonsMilli);
  }

  const totalMiles = sum([...milesByState.values()]);
  const totalGallonsMilli = sum([...paidByState.values()]);
  // Step 4.
  const fleetMpgMilli = fleetMpgMilliOf(totalMiles, totalGallonsMilli);

  // Steps 5 and 6, per state.
  const codes = [...new Set([...milesByState.keys(), ...paidByState.keys()])].sort(compareText);
  const states: IftaState[] = codes.map((state) => {
    const miles = milesByState.get(state) ?? 0;
    const taxPaidGallonsMilli = paidByState.get(state) ?? 0;
    const taxable = fleetMpgMilli === null ? null : taxableMilliOf(miles, fleetMpgMilli);
    const net = taxable === null ? null : sub(taxable, taxPaidGallonsMilli);
    const rateMcents = rates.get(state) ?? null;
    const taxCents = net === null || rateMcents === null ? null : taxCentsOf(net, rateMcents);
    return { state, miles, taxPaidGallonsMilli, taxableGallonsMilli: taxable, netGallonsMilli: net, rateMcents, taxCents };
  });

  // Step 7: sums of the per-state integers, nothing rounded again.
  const known = fleetMpgMilli !== null;
  const withRate = states.filter((s) => s.rateMcents !== null);
  const totals: IftaTotals = {
    miles: totalMiles,
    taxPaidGallonsMilli: totalGallonsMilli,
    taxableGallonsMilli: known ? sum(states.map((s) => s.taxableGallonsMilli ?? 0)) : null,
    netGallonsMilli: known ? sum(states.map((s) => s.netGallonsMilli ?? 0)) : null,
    taxCents: known ? sum(withRate.map((s) => s.taxCents ?? 0)) : null,
  };

  let largestTaxDue: IftaQuarter["largestTaxDue"] = null;
  for (const s of states) {
    if (s.taxCents !== null && s.taxCents > 0 && (largestTaxDue === null || s.taxCents > largestTaxDue.taxCents)) {
      largestTaxDue = { state: s.state, taxCents: s.taxCents };
    }
  }

  const rateGaps: IftaGap[] = states
    .filter((s) => s.rateMcents === null)
    .map((s) => ({ kind: "state_not_in_rates", state: s.state, miles: s.miles, taxPaidGallonsMilli: s.taxPaidGallonsMilli }));

  return {
    quarter: q,
    loadsCounted,
    purchasesCounted,
    totalMiles,
    totalGallonsMilli,
    fleetMpgMilli,
    states,
    totals,
    statesWithoutRate: rateGaps.length,
    largestTaxDue,
    gaps: [...loadGaps, ...rateGaps],
    excludedMiles: sum(loadGaps.map((g) => g.miles)),
  };
}
