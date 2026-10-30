import { untrustedContentHash } from "../data/content-hash";
import { isoFromMmddyyyy } from "../documents/match";
import { daysBetween, localDateOf } from "../time/local-date";
import { CITY, DRIVER_CODE, LOAD_NUMBER, type LoadAccessorialKind, type LoadCreateArgs } from "./args";
import { MAX_CENTS, parseRateCon, RATECON_CONFIDENCE_FIELDS, rateConTranscriptOf, type RateConReading } from "./schema";

// The deterministic checks between a rate confirmation's reading and a proposed load. Pure: the
// records it compares against (candidates.ts reads them in the tenant's transaction), the clock
// and the start date are passed in. Every value the model returned is a claim; a load is drafted
// only when each one passes, in this order, and the first that fails is the one category kept.
// Comparisons are on whole normalized values, never a part of a string, so "ACME" never finds
// "ACME FOODS". Money is whole cents: the document's own total must equal its lines.

export const RATECON_REFUSALS = [
  "before_start",
  "low_confidence",
  "no_load_number",
  "load_exists",
  "card_exists",
  "unknown_customer",
  "ambiguous_customer",
  "bad_lane",
  "bad_dates",
  "no_miles",
  "no_total",
  "arithmetic_off",
  "accessorial_unknown",
] as const;
export type RateConRefusal = (typeof RATECON_REFUSALS)[number];

// The 50 states and the District of Columbia.
export const US_STATES: ReadonlySet<string> = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);

// The pickup must fall within this window around today, in the tenant's zone, and a printed
// delivery on or after the pickup and at most this many days after it.
export const PICKUP_DAYS_BACK = 60;
export const PICKUP_DAYS_AHEAD = 120;
export const DELIVERY_DAYS_MAX = 30;
export const MILES_MAX = 9_999;

export type RateConCustomer = { id: string; code: string; name: string };

export type RateConCandidates = {
  // The tenant's own zone (tenants.timezone).
  zone: string;
  // Every customer the tenant holds; the customer is one of these or no load is drafted.
  customers: readonly RateConCustomer[];
  // Loads whose normalized number equals the reading's, other than one holding this load's own id.
  loadsWithNumber: number;
  // Live load_create cards (proposed, approved, executing) for the number, other than this
  // load's own.
  cardsWithNumber: number;
};

export type RateConContext = {
  now: Date;
  // The document's created_at, an ISO instant; flags.ratecon.startDate, a local date.
  documentCreatedAt: string;
  startDate: string;
};

// The load as the checks drafted it: the card's args without its ids.
export type LoadDraft = Omit<LoadCreateArgs, "v" | "loadId" | "documentId" | "inputId" | "readingHash" | "revision">;

export type RateConChecked = { ok: true; draft: LoadDraft } | { ok: false; category: RateConRefusal };

const refuse = (category: RateConRefusal): RateConChecked => ({ ok: false, category });

// A load number or a code as compared: trimmed, inner runs of white space as one space, upper case.
export function normCode(s: string | null): string | null {
  if (s === null) return null;
  const out = s.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  return out === "" ? null : out;
}

// A customer name as compared: the same, but lower case.
export function normName(s: string | null): string | null {
  if (s === null) return null;
  const out = s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return out === "" ? null : out;
}

// The load number a reading names, or null when it is not one a load can take.
export function loadNumberOf(s: string | null): string | null {
  const n = normCode(s);
  return n !== null && LOAD_NUMBER.test(n) ? n : null;
}

function cityOf(s: string | null): string | null {
  if (s === null) return null;
  const out = s.normalize("NFKC").trim().replace(/\s+/g, " ");
  return CITY.test(out) ? out : null;
}

function stateOf(s: string | null): string | null {
  const out = normCode(s);
  return out !== null && US_STATES.has(out) ? out : null;
}

function driverCodeOf(s: string | null): string | null {
  const out = normCode(s);
  return out !== null && DRIVER_CODE.test(out) ? out : null;
}

// The one customer whose code or whose name equals the printed one, whole value.
function customerOf(
  reading: RateConReading,
  customers: readonly RateConCustomer[],
): { ok: true; customer: RateConCustomer } | { ok: false; category: "unknown_customer" | "ambiguous_customer" } {
  const code = normCode(reading.customerCode);
  const name = normName(reading.customerName);
  const found = new Map<string, RateConCustomer>();
  for (const c of customers) {
    if ((code !== null && normCode(c.code) === code) || (name !== null && normName(c.name) === name)) {
      found.set(c.id, c);
    }
  }
  if (found.size === 0) return { ok: false, category: "unknown_customer" };
  if (found.size > 1) return { ok: false, category: "ambiguous_customer" };
  return { ok: true, customer: [...found.values()][0] };
}

const isCents = (v: number | null, min: number): v is number =>
  v !== null && Number.isSafeInteger(v) && v >= min && v <= MAX_CENTS;

export function checkRateCon(
  reading: RateConReading,
  candidates: RateConCandidates,
  ctx: RateConContext,
): RateConChecked {
  const created = localDateOf(ctx.documentCreatedAt, candidates.zone);
  if (created < ctx.startDate) return refuse("before_start");
  if (RATECON_CONFIDENCE_FIELDS.some((f) => reading.confidence[f] === "low")) return refuse("low_confidence");

  const loadNumber = loadNumberOf(reading.loadNumber);
  if (loadNumber === null) return refuse("no_load_number");
  if (candidates.loadsWithNumber !== 0) return refuse("load_exists");
  if (candidates.cardsWithNumber !== 0) return refuse("card_exists");

  const customer = customerOf(reading, candidates.customers);
  if (!customer.ok) return refuse(customer.category);

  const originCity = cityOf(reading.originCity);
  const destCity = cityOf(reading.destCity);
  const originState = stateOf(reading.originState);
  const destState = stateOf(reading.destState);
  if (originCity === null || destCity === null || originState === null || destState === null) {
    return refuse("bad_lane");
  }

  const pickupOn = isoFromMmddyyyy(reading.pickupDate);
  if (pickupOn === null) return refuse("bad_dates");
  const today = localDateOf(ctx.now.toISOString(), candidates.zone);
  const ahead = daysBetween(today, pickupOn);
  if (ahead < -PICKUP_DAYS_BACK || ahead > PICKUP_DAYS_AHEAD) return refuse("bad_dates");
  let deliveryOn: string | null = null;
  if (reading.deliveryDate !== null) {
    deliveryOn = isoFromMmddyyyy(reading.deliveryDate);
    if (deliveryOn === null) return refuse("bad_dates");
    const days = daysBetween(pickupOn, deliveryOn);
    if (days < 0 || days > DELIVERY_DAYS_MAX) return refuse("bad_dates");
  }

  // Unknown is not zero: no miles printed is no load (miles drive per-mile pay and fuel tax).
  const miles = reading.loadedMiles;
  if (miles === null || !Number.isSafeInteger(miles) || miles < 1 || miles > MILES_MAX) return refuse("no_miles");

  if (reading.totalCents === null) return refuse("no_total");
  const total = reading.totalCents;
  const linehaul = reading.linehaulCents;
  // No surcharge printed is no surcharge; a linehaul or a charge line with no amount is not.
  const fuel = reading.fuelSurchargeCents ?? 0;
  if (!isCents(total, 1) || !isCents(linehaul, 1) || !isCents(fuel, 0)) return refuse("arithmetic_off");
  const rate = reading.ratePerMileCents;
  if (rate !== null) {
    if (!isCents(rate, 1)) return refuse("arithmetic_off");
    const product = rate * miles;
    if (!Number.isSafeInteger(product) || product !== linehaul) return refuse("arithmetic_off");
  }
  let sum = linehaul + fuel;
  for (const a of reading.accessorials) {
    if (!isCents(a.amountCents, 1)) return refuse("arithmetic_off");
    sum += a.amountCents;
  }
  if (sum !== total) return refuse("arithmetic_off");

  // The load takes four kinds of charge line; any other line is no load (fail closed).
  const accessorials: { kind: LoadAccessorialKind; amountCents: number }[] = [];
  for (const a of reading.accessorials) {
    if (a.kind === "other") return refuse("accessorial_unknown");
    accessorials.push({ kind: a.kind, amountCents: a.amountCents as number });
  }

  return {
    ok: true,
    draft: {
      loadNumber,
      customerId: customer.customer.id,
      customerCode: customer.customer.code,
      originCity,
      originState,
      destCity,
      destState,
      pickupOn,
      deliveryOn,
      loadedMiles: miles,
      ratePerMileCents: rate,
      linehaulCents: linehaul,
      fuelSurchargeCents: fuel,
      accessorials,
      totalCents: total,
      driverCodeClaim: driverCodeOf(reading.driverCode),
    },
  };
}

// The charge lines' total, for the engine's view of a card.
export function accessorialCentsOf(draft: Pick<LoadDraft, "accessorials">): number {
  return draft.accessorials.reduce((n, a) => n + a.amountCents, 0);
}

// The draft's values in one fixed order, so two drafts compare as whole values.
function draftKey(d: LoadDraft): string {
  return JSON.stringify([
    d.loadNumber,
    d.customerId,
    d.customerCode,
    d.originCity,
    d.originState,
    d.destCity,
    d.destState,
    d.pickupOn,
    d.deliveryOn,
    d.loadedMiles,
    d.ratePerMileCents,
    d.linehaulCents,
    d.fuelSurchargeCents,
    d.accessorials.map((a) => [a.kind, a.amountCents]),
    d.totalCents,
    d.driverCodeClaim,
  ]);
}

export function sameDraft(a: LoadDraft, b: LoadDraft): boolean {
  return draftKey(a) === draftKey(b);
}

// What a card was made from, as stored: its ratecon_reads row, the document's created_at and the
// transcript (untrusted_inputs) the row names. candidates.ts reads it.
export type StoredRateCon = {
  status: string;
  proposalId: string | null;
  documentId: string;
  inputId: string | null;
  reading: string | null;
  documentCreatedAt: string;
  transcript: { body: string; hash: string } | null;
};

export type CardRecheck =
  | { ok: true; draft: LoadDraft; reading: RateConReading }
  | { ok: false; category: "not_executable" | "stale" | RateConRefusal };

// A card checked again against what it was made from, for the approval and the auditor: the
// document and transcript are the ones the card names, the transcript still hashes to the card's
// readingHash and is exactly the stored reading's text, the checks still take the stored reading
// against the records as they are now, and they draft exactly the card's values.
export function recheckCard(
  args: LoadCreateArgs,
  stored: StoredRateCon,
  candidates: RateConCandidates,
  ctx: RateConContext,
): CardRecheck {
  if (stored.documentId !== args.documentId || stored.inputId !== args.inputId) {
    return { ok: false, category: "not_executable" };
  }
  const t = stored.transcript;
  if (!t || t.hash !== args.readingHash || untrustedContentHash("document", t.body) !== args.readingHash) {
    return { ok: false, category: "not_executable" };
  }
  const reading = stored.reading === null ? null : parseRateCon(stored.reading);
  if (!reading || rateConTranscriptOf(reading) !== t.body) return { ok: false, category: "not_executable" };
  const checked = checkRateCon(reading, candidates, { ...ctx, documentCreatedAt: stored.documentCreatedAt });
  if (!checked.ok) return checked;
  if (!sameDraft(checked.draft, args)) return { ok: false, category: "stale" };
  return { ok: true, draft: checked.draft, reading };
}
