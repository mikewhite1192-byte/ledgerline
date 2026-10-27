import type { Suggestion } from "@/components/app/prompt-chips";
import { formatLocalDate } from "@/lib/format/dates";

// The home screen's suggested questions: four, each one a tool can answer. With the reports on,
// the advance-limit question gives its place to margin per load; "past 60 days" and "Friday's
// pay run" are then answered by the aging and cash needed reports. With collections on, that
// place goes to the payment reminder question instead.
const BASE: readonly Suggestion[] = [
  { id: "paystub-problems", label: "Who has a problem on this week's paystub?" },
  { id: "past-60", label: "Who owes us money past 60 days?" },
  { id: "pay-run-cost", label: "What will Friday's pay run cost?" },
  { id: "advance-limit", label: "Who is over their advance limit?" },
];

const MARGIN: Suggestion = { id: "margin-per-load", label: "What was our margin per load this month?" };

// With collections on, the fourth question asks who needs a payment reminder (get_collections
// answers it), in place of the advance limit or margin per load.
const REMINDER: Suggestion = { id: "payment-reminder", label: "Who needs a payment reminder?" };

// Switches past the reports one come by name, so two switches can never be passed in each
// other's place.
export type SuggestionSwitches = { collections?: boolean };

export function homeSuggestions(reportsOn: boolean, on: SuggestionSwitches = {}): Suggestion[] {
  return BASE.map((s) => {
    if (s.id !== "advance-limit") return { ...s };
    if (on.collections) return { ...REMINDER };
    return reportsOn ? { ...MARGIN } : { ...s };
  });
}

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
  };
  return [first, ...base.slice(0, 3).map((s) => ({ ...s }))];
}
