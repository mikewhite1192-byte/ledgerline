// One plain sentence for each trucking or pay word a new office clerk may not know, shown as hover
// help by <Term> (src/components/app/term.tsx). No vendor names, no internal words.

export const TERMS = {
  linehaul: "The pay or price for the haul itself, before fuel and extras.",
  "fuel-surcharge": "An amount added to cover fuel, usually a rate per mile.",
  detention: "Pay for waiting at a dock beyond the free time, usually after two hours.",
  layover: "Pay for a night away waiting on the next load.",
  lumper: "A fee paid to the crew that unloads at the dock; the driver is paid back for it.",
  "extra-stop": "A pickup or delivery beyond the first and last.",
  "extra-charges":
    "Charges on a load beyond the haul itself, like detention, a lumper or an extra stop (in trucking, accessorials).",
  "loaded-miles": "Miles driven with freight on.",
  "empty-miles": "Miles driven with no freight, to reach the next pickup.",
  "rate-confirmation": "The one-page agreement from the broker or customer that sets the price.",
  "bill-of-lading": "The shipping paper that lists what was hauled and who signed for it.",
  pod: "Proof of delivery: the signed paper that shows the freight arrived.",
  shipper: "Who hands the freight over.",
  consignee: "Who receives the freight.",
  "owner-operator": "A driver who owns the truck and is paid a share of each load.",
  "company-driver": "A driver in a company truck, paid per mile.",
  escrow: "Money held back from an owner-operator's pay and returned when the lease ends.",
  "truck-lease": "The weekly payment an owner-operator makes on the truck.",
  insurance: "A daily charge for insurance coverage, taken for each day the driver drove.",
  "carried-shortfall": "When deductions were more than pay one week, the rest is taken next week.",
  advance: "Pay given early, against work already done; it is taken back from the next paystub.",
  "advance-repaid": "The part of an earlier advance taken back on this paystub.",
  "gross-pay": "Everything earned, before anything is taken out.",
  deductions: "Everything taken out of pay.",
  "net-pay": "What is paid, after deductions.",
  reimbursement: "Money the driver spent for the company and gets back.",
  "pay-period": "The week being paid.",
  paystub: "One driver's pay for that week.",
  "past-due": "An invoice not paid by the day it was due.",
  "credit-on-account": "Money a customer paid that is not yet matched to an invoice.",
  "second-check": "A separate model re-read this against your records before anyone approves.",
  verified: "Your pay rules worked out the same amount to the cent, and a second check agreed.",
  unverified: "Not yet confirmed both ways: your pay rules must work out the same amount and a second check must agree.",
  "verified-answer": "Every amount came from a record or from your own question; no request was made, so no second check ran.",
  "marked-copy":
    "A picture of the document with the line in question circled and what your records say written beside it.",
  "test-payout": "A simulated payment; no real money moves in this demo.",
  "money-code":
    "A one-time code the driver gives a lumper or a repair shop to pay at the dock; it is charged to the driver's week and paid back from the receipt.",
  "card-provider": "The company that issues the fuel cards and money codes; in this demo it is simulated, so no real money moves.",
  "take-home-pay": "What the driver is paid for the week after everything taken out, the same as net pay.",
  "pay-card":
    "A picture of one driver's week for their phone, kept only after a second read matched every number to the paystub.",
  margin: "What is left of the revenue after driver pay.",
  "days-to-pay":
    "The average days from an invoice's date to the day it was paid, over invoices paid in the 180 days before the week ended.",
  factoring: "Selling an open invoice to a factoring company for cash now, instead of waiting for the customer to pay.",
  "advance-rate": "The share of an invoice the factoring company pays now; the rest is held back.",
  "held-back": "The part of a factored invoice kept until the customer pays it (in factoring, the reserve).",
  "factoring-fee": "What the factoring company charges for paying early, taken from the money paid now.",
  "diesel-index": "The weekly average diesel price many customers tie the fuel surcharge to.",
  "fuel-tax-rate": "What each state charges per gallon of diesel burned on its roads; settled every quarter.",
} as const;

export type TermId = keyof typeof TERMS;

export const TERM_IDS = Object.keys(TERMS) as TermId[];

export function termHelp(id: TermId): string {
  return TERMS[id];
}
