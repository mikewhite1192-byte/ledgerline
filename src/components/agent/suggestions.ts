import type { Suggestion } from "@/components/app/prompt-chips";
import { formatLocalDate } from "@/lib/format/dates";

// The home screen's suggested questions: four, each one a tool can answer, each with one line on
// why a person would ask it. With the reports on, the advance-limit question gives its place to
// margin per load; "past 60 days" and "Friday's pay run" are then answered by the aging and cash
// needed reports. With the profit brief on, that last place asks how last week went instead
// (get_profit_brief answers it). With Cash Friday on, the pay run's cost gives its place to whether
// there is cash to make it (get_cash_friday). The labels are sent to the agent as written, so a
// change to one is a change to the question, not only to the screen.
const BASE: readonly Suggestion[] = [
  {
    id: "paystub-problems",
    label: "Who has a problem on this week's paystub?",
    reason: "Finds the paystubs that need a look before Friday.",
  },
  { id: "past-60", label: "Who owes us money past 60 days?", reason: "Lists late invoices by customer." },
  {
    id: "pay-run-cost",
    label: "What will Friday's pay run cost?",
    reason: "Totals the week so you know the cash needed.",
  },
  {
    id: "advance-limit",
    label: "Who is over their advance limit?",
    reason: "Checks each driver's advances against the most their pay allows.",
  },
];

const MARGIN: Suggestion = {
  id: "margin-per-load",
  label: "What was our margin per load this month?",
  reason: "What each load billed, less what its driver was paid.",
};

const PROFIT: Suggestion = {
  id: "profit-brief",
  label: "How did we do last week?",
  reason: "Last closed week's margin by route and customer, every number checked.",
};

const CASH: Suggestion = {
  id: "make-pay-run",
  label: "Can we make Friday's pay run?",
  reason: "Weighs cash on hand and payments due by Friday against the pay run and bills.",
};

// Each other switch comes in by name, so a call that passes one switch for another fails to build.
type HomeSwitches = { profitOn?: boolean; cashFridayOn?: boolean };

export function homeSuggestions(
  reportsOn: boolean,
  { profitOn = false, cashFridayOn = false }: HomeSwitches = {},
): Suggestion[] {
  return BASE.map((s) => {
    if (s.id === "pay-run-cost") return cashFridayOn ? { ...CASH } : { ...s };
    if (s.id !== "advance-limit") return { ...s };
    if (profitOn) return { ...PROFIT };
    return reportsOn ? { ...MARGIN } : { ...s };
  });
}

// Offered only while the detention tools are switched on, so the chip never asks for a tool the
// agent does not have.
export const DETENTION_SUGGESTION: Suggestion = {
  id: "unbilled-detention",
  label: "Find detention we never billed last month",
  reason: "Finds dock waits past the free time that never reached an invoice.",
};

// "Ask about this paystub" on a paystub's page lands on the home screen with that paystub's
// question first, ahead of three of the usual four. The name and the week come from the database.
export function withPaystubSuggestion(
  base: readonly Suggestion[],
  paystub: { driverName: string; periodEnd: string } | null,
): Suggestion[] {
  if (paystub === null) return base.map((s) => ({ ...s }));
  const first: Suggestion = {
    id: "explain-paystub",
    label: `Explain ${paystub.driverName}'s paystub for the week ending ${formatLocalDate(paystub.periodEnd)}.`,
    reason: "Walks through each line of this paystub in plain words.",
  };
  return [first, ...base.slice(0, 3).map((s) => ({ ...s }))];
}
