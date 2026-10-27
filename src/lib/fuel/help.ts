import { formatLocalDate } from "../format/dates";
import { formatCents } from "../format/money";
import type { FuelCheckName, NoSuggestionReason } from "../rules-engine/fuel";

// Every word the fuel checks page shows, in one place (FUEL-ANOMALY design 4.6). Fixed sentences
// with the engine's numbers filled in: no model prose, no internal word and no raw id ever reaches
// the screen. Record links show the human ref (the fill-up's receipt number, the load number).

export const FUEL_LABELS: Readonly<Record<FuelCheckName, string>> = {
  fuel_off_route: "Fuel bought off the route",
  fuel_over_tank: "More fuel than the tank holds",
  fuel_while_parked: "Fuel bought on a day off",
  fuel_duplicate: "Same receipt turned in twice",
};

export const FUEL_STATUS_WORDS: Readonly<Record<string, string>> = {
  open: "Needs you",
  proposed: "Sent for approval",
  corrected: "Corrected",
  dismissed: "Dismissed",
  cleared: "Cleared",
};

// The badge tone each status borrows from the shared status badge.
export const FUEL_STATUS_TONE: Readonly<Record<string, string>> = {
  open: "unknown",
  proposed: "approved",
  corrected: "done",
  dismissed: "draft",
  cleared: "done",
};

// The status a row shows. A finding sent for approval keeps that status in the database; once its
// card was approved and carried out, the row reads the card and says Corrected.
export function fuelRowStatus(row: { status: string; proposal: { status: string } | null }): string {
  return row.status === "proposed" && row.proposal?.status === "done" ? "corrected" : row.status;
}

export const DISMISS_CATEGORIES = ["driver_explained", "pump_error", "provider_reversed", "other"] as const;
export type DismissCategory = (typeof DISMISS_CATEGORIES)[number];

export const DISMISS_WORDS: Readonly<Record<DismissCategory, string>> = {
  driver_explained: "The driver explained it",
  pump_error: "Pump error",
  provider_reversed: "The card company reversed it",
  other: "Other",
};

export const FUEL_PAGE_WORDS = {
  title: "Fuel checks",
  subtitle:
    "Fill-ups that do not fit the truck, the route or the day. Nothing changes a driver's pay until you approve a correction.",
  run: "Check this week's fuel",
  running: "Checking fill-ups...",
  emptyTitle: "No fuel problems found this week.",
  emptyBody: "Click Check this week's fuel after new fill-ups come in.",
  failed: "The check did not finish. Nothing was changed or sent. Try again in a minute.",
  busy: "A check is already running. Wait a moment, then look again.",
  dismiss: "Dismiss: it checks out",
  dismissConfirm: "Dismiss",
  sent: "Sent for approval. Approve or reject it below.",
  liveExists: "A correction for this driver is already waiting. Decide that one first.",
  changed: "The records changed since this check ran. Check this week's fuel again.",
  noOpenWeek: "There is no open pay week to put the correction in.",
  notKnown: "The answer did not come back. Refresh the page to see where it stands before trying again.",
  refused: "That did not go through. Nothing changed.",
  notSetUp: "Fuel checks are not set up yet. Nothing was changed.",
  turnedDown: "This correction was turned down before. Dismiss it with a reason, or handle it by hand.",
  neverTitle: "No fuel check yet",
  neverBody: "Click Check this week's fuel to look over this week's fill-ups.",
  details: "See details",
  hideDetails: "Hide details",
  dismissPick: "Why it checks out",
  cancel: "Cancel",
  cleared: "Cleared: the records no longer show this problem.",
  lastChecked: "Last checked",
} as const;

// "Checked 464 fill-ups, 4 need you."
export function runLine(checked: number, needYou: number): string {
  const fills = `${checked} ${checked === 1 ? "fill-up" : "fill-ups"}`;
  return `Checked ${fills}, ${needYou} ${needYou === 1 ? "needs" : "need"} you.`;
}

export function proposeLabel(cents: number): string {
  return `Propose a pay correction of ${formatCents(Math.abs(cents))}`;
}

// Thousandths of a gallon as written on a receipt: 286400 is "286.4", 95000 is "95.0", 84250 is
// "84.25". Integer math only.
export function gallonsText(milli: number): string {
  if (!Number.isSafeInteger(milli) || milli < 0) throw new RangeError("gallons must be whole thousandths");
  const whole = Math.trunc(milli / 1000);
  let frac = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  if (frac === "") frac = "0";
  return `${whole.toLocaleString("en-US")}.${frac}`;
}

// The hover help on each label. Over the tank names the truck's tank and the fill-up.
export function fuelHelp(check: FuelCheckName, tankGallons: number, gallonsMilli: number): string {
  switch (check) {
    case "fuel_off_route":
      return "The state on the receipt is not one this load drove through";
    case "fuel_over_tank":
      return `This truck's tank holds ${tankGallons} gallons; this fill-up was ${gallonsText(gallonsMilli)}`;
    case "fuel_while_parked":
      return "No load and no dispatch day for this driver that day";
    case "fuel_duplicate":
      return "Two fill-ups with the same gallons, amount and state minutes apart; when both photos are on file we compared them";
  }
}

// Why the main action is off, when the engine suggests no correction.
export function noSuggestionLine(reason: NoSuggestionReason, excessCents: number | null): string {
  switch (reason) {
    case "driver_paid":
      return "No pay change suggested: the driver paid for this fuel";
    case "already_deducted":
      return "No pay change suggested: this fuel is already taken from the driver's pay";
    case "over_tank":
      return excessCents !== null && excessCents > 0
        ? `No pay change suggested: the gallons over the tank cost ${formatCents(excessCents)}. Check them with the driver.`
        : "No pay change suggested: check the gallons with the driver.";
    case "card_double_charge":
      return "No pay change suggested: the card was charged twice, and the card company reverses that";
    case "not_paid_back":
      return "No pay change suggested: the driver was not paid back the full amount twice";
    case "over_limit":
      return "Above the correction limit, handle by hand";
    case "payback_on_other_row":
      return "No pay change suggested: another row already covers taking back this payback";
  }
}

// The photo compare's one line. Nothing here changes an amount: the finding stands on the records.
export function compareLine(c: {
  verdict: string | null;
  confidence: string | null;
  category: string | null;
}): string {
  const conf = c.confidence === "high" || c.confidence === "medium" || c.confidence === "low" ? c.confidence : null;
  if (c.verdict === "same" && conf) return `The two photos show the same receipt (${conf} confidence).`;
  if (c.verdict === "different" && conf) return `The two photos show different receipts (${conf} confidence).`;
  if (c.verdict === "unknown") {
    switch (c.category) {
      case "no_photos":
        return "Photos not on file yet. Upload the receipt photos under Documents and check again.";
      case "budget":
        return "The photos were not compared: today's allowance for photo checks is used up. The records still show it.";
      case "timeout":
        return "The photo check did not finish. Check this week's fuel again later; the records still show it.";
      default:
        return "The photos could not be compared. The records still show it.";
    }
  }
  return "The photos have not been compared yet.";
}

const STATE_NAMES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "the District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export function stateName(code: string): string {
  return Object.hasOwn(STATE_NAMES, code) ? STATE_NAMES[code] : code;
}

// "North Carolina", "North Carolina and Georgia", "North Carolina, South Carolina and Georgia".
export function stateList(codes: readonly string[]): string {
  const names = codes.map(stateName);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// "Oct 29": the year is on the page header's week, so a row needs only the day.
export function shortDate(value: string): string {
  const full = formatLocalDate(value);
  return full.replace(/, \d{4}$/, "");
}

export type SentenceInput = {
  check: FuelCheckName;
  driver: string;
  purchasedOn: string;
  state: string;
  gallonsMilli: number;
  tankGallons: number;
  amountCents: number;
  paidWith: "company_card" | "driver_own";
  loadNumber: string | null;
  loadStates: readonly string[];
  minutesApart: number | null;
};

// The finding as one sentence with every number (design 3.1).
export function fuelSentence(f: SentenceInput): string {
  const gal = gallonsText(f.gallonsMilli);
  const day = shortDate(f.purchasedOn);
  const where = stateName(f.state);
  switch (f.check) {
    case "fuel_off_route":
      return f.loadNumber && f.loadStates.length > 0
        ? `${f.driver} bought ${gal} gallons in ${where} on ${day}, but load ${f.loadNumber} ran through ${stateList(f.loadStates)}.`
        : `${f.driver} bought ${gal} gallons in ${where} on ${day}, a state the load did not run through.`;
    case "fuel_over_tank": {
      const over = f.gallonsMilli - f.tankGallons * 1000;
      return over > 0
        ? `${f.driver} bought ${gal} gallons in ${where} on ${day}, but the truck's tank holds ${f.tankGallons} gallons: ${gallonsText(over)} gallons more than fit.`
        : `${f.driver} bought ${gal} gallons in ${where} on ${day}, more than the truck's ${f.tankGallons} gallon tank holds.`;
    }
    case "fuel_while_parked":
      return `${f.driver} bought ${gal} gallons in ${where} on ${day} with the company card, with no load and no dispatch day that day.`;
    case "fuel_duplicate": {
      const apart =
        f.minutesApart !== null && f.minutesApart >= 0
          ? `${f.minutesApart} ${f.minutesApart === 1 ? "minute" : "minutes"} apart`
          : "minutes apart";
      return `${f.driver} turned in the same fill-up twice on ${day}: ${gal} gallons for ${formatCents(f.amountCents)} in ${where}, ${apart}.`;
    }
  }
}
