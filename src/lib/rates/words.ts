// Every sentence the Fuel and tax rates page says (GROUNDED-RATES design 4.8). Fixed words only: a
// route's answer picks one by its category, and no page text or error text is ever shown.

export const RATES_WORDS = {
  title: "Fuel and tax rates",
  subtitle:
    "The weekly diesel price and the fuel tax rate for each state. The assistant looks them up and shows the source; only an admin can pin one. A pin records the rate: no rate rule uses it yet, and pinning recalculates nothing.",
  lookUpDiesel: "Look up this week's diesel price",
  lookUpState: "Look up",
  lookingUp: "Looking it up",
  dieselTitle: "Diesel price",
  statesTitle: "Fuel tax by state",
  notPinned: "Not pinned yet",
  emptyTitle: "Rates appear here once you pin one",
  emptyBody: "Look up this week's diesel price to start.",
  noStates: "States appear here once a load crosses one.",
  matched: "Number matched to the page",
  notMatched: "Number not matched to the page",
  notMatchedBody: "The source page is linked, but the number could not be matched to its text. Open the page and type the rate.",
  pinThis: "Pin this rate",
  typeIt: "Type the rate from the page",
  typeOwn: "Type a rate from a page",
  onlyAdmin: "Only an admin can pin a rate.",
  keep: "Keep reviewing",
  pinning: "Pinning",
  cancel: "Cancel",
  rateLabel: "Rate in dollars per gallon",
  rateHint: "As the page shows it, like 3.657.",
  rateBad: "Type the rate in dollars per gallon, like 3.657.",
  pageLabel: "Address of the page",
  pageHint: "The https address you read the rate on.",
  pageBad: "Paste the page's full address, starting with https://.",
  fromLabel: "Use it from",
  fromHint: "The day the pinned rate is recorded as starting. No rate rule uses it yet.",
  fromBad: "Pick a day from a year back up to today.",
  review: "Review the pin",
} as const;

// "Pin $3.657 per gallon?"
export function pinQuestion(perGallon: string): string {
  return `Pin ${perGallon} per gallon?`;
}

// "It is recorded as starting Oct 26, 2026. No rate rule uses it yet, and nothing is
// recalculated, billed or sent."
export function pinNext(fromDay: string): string {
  return `It is recorded as starting ${fromDay}. No rate rule uses it yet, and nothing is recalculated, billed or sent.`;
}

// Under a pinned rate: "Recorded as starting Oct 19, 2026. No rate rule uses it yet."
export function pinnedFromLine(fromDay: string): string {
  return `Recorded as starting ${fromDay}. No rate rule uses it yet.`;
}

export function lookupsLeftLine(n: number): string {
  if (n <= 0) return "No lookups left for today. Try again tomorrow.";
  return n === 1 ? "1 lookup left for today." : `${n} lookups left for today.`;
}

// What the page says after a lookup, by the route's answer.
export function lookupNotice(outcome: string): { tone: "success" | "info" | "warning" | "destructive"; text: string } {
  switch (outcome) {
    case "suggested":
      return { tone: "success", text: "The lookup found a rate and the page it is on. Nothing is used until an admin pins it." };
    case "unconfirmed":
      return {
        tone: "warning",
        text: "The lookup found a page but could not match the number to it. Open the page and type the rate.",
      };
    case "no_source":
      return { tone: "warning", text: "The search found no page with this rate. Nothing was pinned or changed. Try again later." };
    case "limit":
      return { tone: "warning", text: "This carrier used today's lookups. Nothing was pinned or changed. Try again tomorrow." };
    case "budget":
      return {
        tone: "warning",
        text: "Lookups are paused for now: the demo budget would not cover one. Nothing was pinned or changed.",
      };
    case "forbidden":
      return { tone: "warning", text: "Only staff of this carrier can look up a rate." };
    case "disabled":
      return { tone: "warning", text: "Fuel and tax rates are off for this carrier. Nothing was changed." };
    case "unknown":
      return {
        tone: "warning",
        text: "The answer did not come back, so this lookup may or may not have been kept. The page shows what is saved.",
      };
    default:
      return { tone: "destructive", text: "The lookup did not finish. Nothing was pinned or changed. Try again." };
  }
}

// What the page says after a pin, by the route's answer.
export function pinNotice(outcome: string): { tone: "success" | "info" | "warning" | "destructive"; text: string } {
  switch (outcome) {
    case "pinned":
      return { tone: "success", text: "Pinned. Nothing was recalculated, billed or sent." };
    case "already":
      return { tone: "info", text: "That rate is already pinned from that day. Nothing changed." };
    case "forbidden":
      return { tone: "warning", text: "Only an admin can pin a rate. Nothing changed." };
    case "changed":
    case "not_found":
      return { tone: "warning", text: "This rate changed since the page was read. Nothing was pinned. The page shows it as it is now." };
    case "bad_request":
      return { tone: "warning", text: "That did not look right. Check the rate, the page address and the day. Nothing was pinned." };
    case "disabled":
      return { tone: "warning", text: "Fuel and tax rates are off for this carrier. Nothing was changed." };
    case "unknown":
      return {
        tone: "warning",
        text: "The answer did not come back, so this rate may or may not have been pinned. The page shows what is saved.",
      };
    default:
      return { tone: "destructive", text: "The pin did not go through. Nothing changed. Try again." };
  }
}
