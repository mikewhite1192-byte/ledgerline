import type { MessageCategory } from "../agent/gateway/triage/run";
import { CASE_A_ASK_CENTS } from "../seed/untrusted-inputs";

// Fourteen fixed driver emails for scoring the triage model (design 4.5). Generic words only: no
// person, company or vendor is named in them. Each one is sent from the address of a seeded
// driver of the run's first carrier (the driver at `driver` in code order, wrapping), so the
// sender match has a driver to find. Every date is written out in full, with its year, so the
// expected calendar date never depends on the day the eval runs.

export type TriageCase = {
  key: string;
  // Index into the carrier's drivers sorted by code.
  driver: number;
  subject: string;
  text: string;
  category: MessageCategory;
  // What the message names, as whole cents (null: no amount), and its dates as YYYY-MM-DD.
  amountCents: number | null;
  dates: readonly string[];
};

export const TRIAGE_CASES: readonly TriageCase[] = [
  {
    key: "advance-repair",
    driver: 0,
    subject: "Advance for a repair",
    text: "Hi,\n\nCould I get an advance of $300.00 this week? I need to cover a brake repair before my next load.\n\nThanks",
    category: "advance_request",
    amountCents: 30_000,
    dates: [],
  },
  {
    key: "advance-dated",
    driver: 1,
    subject: "Small advance",
    text: "Hello,\n\nI would like a $150.00 advance on Thursday, November 5, 2026 if that is possible.\n\nThank you",
    category: "advance_request",
    amountCents: 15_000,
    dates: ["2026-11-05"],
  },
  {
    key: "advance-plain",
    driver: 2,
    subject: "Advance please",
    text: "Hi,\n\nCan I get $75.50 advanced for fuel and food on the road? Whenever the office can do it is fine.\n\nThanks",
    category: "advance_request",
    amountCents: 7_550,
    dates: [],
  },
  {
    key: "pay-short",
    driver: 3,
    subject: "Check looks short",
    text: "Hello,\n\nMy settlement for the week ending Saturday, October 31, 2026 came in $42.18 lower than I figured. Can someone look at it?\n\nThanks",
    category: "pay_question",
    amountCents: 4_218,
    dates: ["2026-10-31"],
  },
  {
    key: "pay-deduction",
    driver: 4,
    subject: "Deduction question",
    text: "Hi,\n\nThere is a deduction on my stub I do not recognize. Could someone tell me what it is for?\n\nThank you",
    category: "pay_question",
    amountCents: null,
    dates: [],
  },
  {
    key: "detention-long",
    driver: 5,
    subject: "Long wait at the dock",
    text: "Hello,\n\nI waited four hours at the receiver on Wednesday, October 28, 2026 before they unloaded me. The times are signed on the paperwork.\n\nThanks",
    category: "detention",
    amountCents: null,
    dates: ["2026-10-28"],
  },
  {
    key: "detention-amount",
    driver: 6,
    subject: "Detention pay",
    text: "Hi,\n\nThe shipper kept me three hours past my appointment on Monday, October 26, 2026. I think that comes to $120.00 of detention. Please add it.\n\nThank you",
    category: "detention",
    amountCents: 12_000,
    dates: ["2026-10-26"],
  },
  {
    key: "detention-plain",
    driver: 7,
    subject: "Sat at the warehouse",
    text: "Hello,\n\nI sat most of the afternoon at the warehouse yesterday waiting on a door. I have the in and out times if you need them.\n\nThanks",
    category: "detention",
    amountCents: null,
    dates: [],
  },
  {
    key: "timeoff-two",
    driver: 8,
    subject: "Days off",
    text: "Hi,\n\nI need Monday, November 16, 2026 and Tuesday, November 17, 2026 off for a family matter. Please let dispatch know.\n\nThank you",
    category: "time_off",
    amountCents: null,
    dates: ["2026-11-16", "2026-11-17"],
  },
  {
    key: "timeoff-one",
    driver: 9,
    subject: "Doctor visit",
    text: "Hello,\n\nI have a doctor visit on Friday, November 20, 2026 and will not be able to run that day.\n\nThanks",
    category: "time_off",
    amountCents: null,
    dates: ["2026-11-20"],
  },
  {
    key: "timeoff-week",
    driver: 10,
    subject: "Week off next month",
    text: "Hi,\n\nI would like the week of December 7, 2026 off. Let me know if that works for the schedule.\n\nThank you",
    category: "time_off",
    amountCents: null,
    dates: ["2026-12-07"],
  },
  {
    key: "address-move",
    driver: 11,
    subject: "Moved",
    text: "Hello,\n\nI moved to a new apartment. I will bring the new address to the office on a signed form so my mail goes to the right place.\n\nThanks",
    category: "address_change",
    amountCents: null,
    dates: [],
  },
  {
    key: "rate-sheet",
    driver: 12,
    subject: "Rate sheet for my next load",
    text: "Hi,\n\nAttached is the rate confirmation the broker sent for my next load. It shows a linehaul of $2,450.00. Please put it on file.\n\nThank you",
    category: "rate_confirmation",
    amountCents: 245_000,
    dates: [],
  },
  {
    key: "other-thanks",
    driver: 13,
    subject: "Thanks",
    text: "Hello,\n\nJust wanted to say thanks to the office for the help last week. Everything is running well.\n\nTake care",
    category: "other",
    amountCents: null,
    dates: [],
  },
];

// What each seeded outside text should sort as (untrusted-inputs.ts). Amount undefined: not
// scored (the rate confirmation names several figures). Dates and the driver are not scored on
// these: their dates are relative ("Monday") and runTriage has no sender to match.
export const SEEDED_TRIAGE: Readonly<Record<string, { category: MessageCategory; amountCents?: number | null }>> = {
  "inj-email-a": { category: "advance_request", amountCents: CASE_A_ASK_CENTS },
  "inj-doc-b": { category: "rate_confirmation" },
  "benign-paystub": { category: "pay_question", amountCents: null },
  "benign-detention": { category: "detention", amountCents: null },
  "benign-timeoff": { category: "time_off", amountCents: null },
  "benign-address": { category: "address_change", amountCents: null },
};
