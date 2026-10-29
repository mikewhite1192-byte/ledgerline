import type { CardTransactionRow, DriverCardRow, DriverRow, TenantRows } from "../data/rows";
import { compareText } from "../rules-engine";
import { rankCandidates, topIsTied, type Candidate } from "../rules-engine/card-recon";
import { addDays, datesBetween, isWithin, type LocalDate, type Period } from "../time/local-date";
import { instantAt } from "./calendar";
import type { DemoCarrier } from "./carriers";
import { Rng } from "./prng";

// The card provider's statement in Test mode: what its portal would show for the carrier's fuel
// cards. One fuel row per company-card purchase of the last 14 days before the anchor (the same
// reference, amount, state and gallons), on the driver's default card, plus four planted
// differences for the card check to find:
//   (a) a fuel row $3.40 above its purchase                      -> fuel_amount_differs
//   (b) a fuel row on a known card with no purchase              -> purchase_not_recorded
//   (c) $212.40 on an unknown pool card, one clear driver          -> card_unknown (a match card)
//   (d) a $150.00 card load with no payment record               -> load_not_in_ledger
//
// The ids come from their own random stream (`<slug>:<anchor>:statement`), so the statement
// changes no id or amount anywhere else in the plan. The plants sit early in the open week, so a
// check on a real clock from the day they happen through the finals still has them in its window.
// The statement is the provider's side only: no purchase, pay item or ledger row is planted, so no
// driver's pay changes.

export const STATEMENT_DAYS = 14;
export const PLANT_FUEL_EXTRA_CENTS = 340;
export const PLANT_UNKNOWN_CENTS = 21_240;
export const PLANT_UNKNOWN_GALLONS_MILLI = 52_850;
export const PLANT_UNKNOWN_PORTAL = "POOL CARD 7";
export const PLANT_LOAD_CENTS = 15_000;

export type StatementPlanted = {
  fuelAmountDiffersId: string;
  purchaseNotRecordedId: string;
  cardUnknownId: string;
  loadNotInLedgerId: string;
  // The one driver the candidates put on top for the unknown card; null when the top is tied.
  candidateDriverId: string | null;
};

function hex24(rng: Rng): string {
  return rng.uuid().replace(/-/g, "").slice(0, 24);
}

function defaultCard(cards: readonly DriverCardRow[], driverId: string): DriverCardRow | null {
  return cards.find((c) => c.driver_id === driverId && c.is_default && c.status === "active") ?? null;
}

function portalNameOf(card: DriverCardRow, driver: DriverRow): string {
  return card.holder_kind === "generic" && card.portal_name ? card.portal_name : driver.code;
}

export function buildCardStatement(input: {
  carrier: DemoCarrier;
  anchor: LocalDate;
  openWeek: Period;
  rows: TenantRows;
  heroId: string | null;
  // Purchases other plants already tell a story about: never reused here.
  avoidPurchaseIds: ReadonlySet<string>;
}): { rows: CardTransactionRow[]; planted: StatementPlanted } {
  const { carrier, anchor, openWeek, rows } = input;
  const zone = carrier.timezone;
  const rng = new Rng(`${carrier.slug}:${anchor}:statement`);
  const window: Period = { start: addDays(anchor, -STATEMENT_DAYS), end: addDays(anchor, -1) };
  const drivers = new Map(rows.drivers.map((d) => [d.id, d]));
  const out: CardTransactionRow[] = [];

  const purchases = rows.fuel_purchases
    .filter((p) => p.paid_with === "company_card" && isWithin(p.purchased_on, window))
    .sort((a, b) => compareText(a.purchased_at, b.purchased_at) || compareText(a.id, b.id));
  for (const p of purchases) {
    const driver = drivers.get(p.driver_id);
    const card = driver ? defaultCard(rows.driver_cards, driver.id) : null;
    if (!driver || !card) throw new Error("a company-card purchase has no default card");
    out.push({
      id: rng.uuid(),
      provider: "fuel_card_sim",
      provider_ref: p.purchase_ref,
      kind: "fuel",
      card_token: card.provider_token,
      card_last4: card.last4,
      portal_name: portalNameOf(card, driver),
      posted_at: p.purchased_at,
      posted_on: p.purchased_on,
      amount_cents: p.amount_cents,
      state: p.state,
      gallons_milli: p.gallons_milli,
      merchant: null,
      source: "seed",
    });
  }

  // The plants: the open week's second day first, then the days after it, so the earliest day that
  // carries each plant is taken.
  const plantDays = datesBetween(addDays(openWeek.start, 1), openWeek.end);
  const plain = (driverId: string): boolean => driverId !== input.heroId;
  const loads = new Map(rows.loads.map((l) => [l.id, l]));

  // (a) a fuel row $3.40 above its purchase.
  const purchaseIndex = (() => {
    for (const day of plantDays) {
      const found = out.findIndex((t) => {
        const p = purchases.find((x) => x.purchase_ref === t.provider_ref);
        return t.posted_on === day && p !== undefined && plain(p.driver_id) && !input.avoidPurchaseIds.has(p.id);
      });
      if (found >= 0) return found;
    }
    throw new Error("no company-card purchase in the open week for the amount plant");
  })();
  out[purchaseIndex] = { ...out[purchaseIndex], amount_cents: out[purchaseIndex].amount_cents + PLANT_FUEL_EXTRA_CENTS };
  const fuelAmountDiffersId = out[purchaseIndex].id;
  const amountPlantDriver = purchases.find((p) => p.purchase_ref === out[purchaseIndex].provider_ref)!.driver_id;

  // Days of work by driver and day, for (b) and (c).
  const worked = rows.driver_days
    .filter((d) => d.load_id !== null && plantDays.includes(d.day) && plain(d.driver_id))
    .sort((a, b) => compareText(a.day, b.day) || compareText(drivers.get(a.driver_id)!.code, drivers.get(b.driver_id)!.code));

  // (b) a fuel row on a known card with no purchase: a driver on a load that day, at the load's
  // origin, at a pump price between $3.89 and $4.29.
  const knownDay = worked.find((d) => d.driver_id !== amountPlantDriver && defaultCard(rows.driver_cards, d.driver_id));
  if (!knownDay) throw new Error("no working driver for the purchase-not-recorded plant");
  const knownDriver = drivers.get(knownDay.driver_id)!;
  const knownCard = defaultCard(rows.driver_cards, knownDriver.id)!;
  const knownGallons = rng.int(80_000, 140_000);
  const knownPrice = rng.int(389, 429);
  const notRecorded: CardTransactionRow = {
    id: rng.uuid(),
    provider: "fuel_card_sim",
    provider_ref: `fcs_txn_${hex24(rng)}`,
    kind: "fuel",
    card_token: knownCard.provider_token,
    card_last4: knownCard.last4,
    portal_name: portalNameOf(knownCard, knownDriver),
    posted_at: instantAt(knownDay.day, 14, 20, zone),
    posted_on: knownDay.day,
    amount_cents: Math.round((knownGallons * knownPrice) / 1000),
    state: loads.get(knownDay.load_id!)!.origin_state,
    gallons_milli: knownGallons,
    merchant: null,
    source: "seed",
  };
  out.push(notRecorded);

  // (c) the unknown pool card: the first day and state where the candidates put exactly one
  // driver, not the hero, on top with a load in that state. A carrier whose lanes share every
  // state on every open-week day (Prairie Wind's regional network) gets the first day and state
  // with a load in it instead: its top is tied, so the check asks a person to pick the driver.
  const usedTokens = new Set(rows.driver_cards.map((c) => c.provider_token));
  const usedLast4 = new Set([...rows.driver_cards.map((c) => c.last4), ...out.map((t) => t.card_last4)]);
  let token = "";
  do token = `fcs_card_${hex24(rng)}`;
  while (usedTokens.has(token));
  let last4 = "";
  do last4 = String(rng.int(0, 9999)).padStart(4, "0");
  while (usedLast4.has(last4));
  const facts = {
    drivers: rows.drivers.map((d) => ({ id: d.id, code: d.code, activeFrom: d.active_from, activeTo: d.active_to })),
    days: rows.driver_days.map((d) => ({ driverId: d.driver_id, day: d.day, loadId: d.load_id })),
    loads: rows.loads.map((l) => ({ id: l.id, originState: l.origin_state, destState: l.dest_state })),
    stateMiles: rows.load_state_miles.map((m) => ({ loadId: m.load_id, state: m.state })),
    cards: rows.driver_cards.map((c) => ({
      driverId: c.driver_id,
      providerToken: c.provider_token,
      portalName: c.portal_name,
      status: c.status,
    })),
  };
  let unknown: { day: LocalDate; state: string; top: Candidate | null } | null = null;
  let tied: { day: LocalDate; state: string } | null = null;
  for (const w of worked) {
    if (unknown) break;
    const load = loads.get(w.load_id!)!;
    const crossed = rows.load_state_miles.filter((m) => m.load_id === load.id).map((m) => m.state);
    for (const state of [...new Set([load.origin_state, load.dest_state, ...crossed])].sort(compareText)) {
      const ranked = rankCandidates({ postedOn: w.day, state, portalName: PLANT_UNKNOWN_PORTAL }, facts);
      const top = ranked[0];
      if (top && top.score >= 3 && !topIsTied(ranked) && plain(top.driverId) && top.reasons.includes("on_load_in_state")) {
        unknown = { day: w.day, state, top };
        break;
      }
      if (!tied && top && top.reasons.includes("on_load_in_state") && topIsTied(ranked)) tied = { day: w.day, state };
    }
  }
  if (!unknown && tied) unknown = { ...tied, top: null };
  if (!unknown) throw new Error("no day and state with a driver on a load for the unknown card");
  const cardUnknown: CardTransactionRow = {
    id: rng.uuid(),
    provider: "fuel_card_sim",
    provider_ref: `fcs_txn_${hex24(rng)}`,
    kind: "fuel",
    card_token: token,
    card_last4: last4,
    portal_name: PLANT_UNKNOWN_PORTAL,
    posted_at: instantAt(unknown.day, 17, 45, zone),
    posted_on: unknown.day,
    amount_cents: PLANT_UNKNOWN_CENTS,
    state: unknown.state,
    gallons_milli: PLANT_UNKNOWN_GALLONS_MILLI,
    merchant: null,
    source: "seed",
  };
  out.push(cardUnknown);

  // (d) a card load with no payment record, on a known driver's card.
  const loadDriver = drivers.get(
    worked.find((d) => d.driver_id !== knownDriver.id && d.driver_id !== amountPlantDriver)?.driver_id ?? knownDriver.id,
  )!;
  const loadCard = defaultCard(rows.driver_cards, loadDriver.id)!;
  const cardLoad: CardTransactionRow = {
    id: rng.uuid(),
    provider: "fuel_card_sim",
    provider_ref: `fcs_load_${hex24(rng)}`,
    kind: "load",
    card_token: loadCard.provider_token,
    card_last4: loadCard.last4,
    portal_name: portalNameOf(loadCard, loadDriver),
    posted_at: instantAt(plantDays[0], 9, 5, zone),
    posted_on: plantDays[0],
    amount_cents: PLANT_LOAD_CENTS,
    state: null,
    gallons_milli: null,
    merchant: null,
    source: "seed",
  };
  out.push(cardLoad);

  out.sort((a, b) => compareText(a.posted_at, b.posted_at) || compareText(a.id, b.id));
  return {
    rows: out,
    planted: {
      fuelAmountDiffersId,
      purchaseNotRecordedId: notRecorded.id,
      cardUnknownId: cardUnknown.id,
      loadNotInLedgerId: cardLoad.id,
      candidateDriverId: unknown.top?.driverId ?? null,
    },
  };
}
