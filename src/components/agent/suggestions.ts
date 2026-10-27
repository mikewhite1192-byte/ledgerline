import type { Suggestion } from "@/components/app/prompt-chips";
import { formatLocalDate } from "@/lib/format/dates";
import { CHIP_LABEL, composerHelp, exampleSentence } from "@/lib/pay-rules/words";
import type { LocalDate } from "@/lib/time/local-date";

// The home screen's suggested questions: four, each one a tool can answer. With the reports on,
// the advance-limit question gives its place to margin per load; "past 60 days" and "Friday's
// pay run" are then answered by the aging and cash needed reports.
const BASE: readonly Suggestion[] = [
  { id: "paystub-problems", label: "Who has a problem on this week's paystub?" },
  { id: "past-60", label: "Who owes us money past 60 days?" },
  { id: "pay-run-cost", label: "What will Friday's pay run cost?" },
  { id: "advance-limit", label: "Who is over their advance limit?" },
];

const MARGIN: Suggestion = { id: "margin-per-load", label: "What was our margin per load this month?" };

export function homeSuggestions(reportsOn: boolean): Suggestion[] {
  return BASE.map((s) => (reportsOn && s.id === "advance-limit" ? MARGIN : { ...s }));
}

// Offered only while pay rule changes are switched on: the chip puts an example sentence in the box,
// dated the first week a change can start, for the person to edit, and shows how to say one with
// an example dated the same week. The Pay rules page's button starts the box with both.
export function ruleChangeSuggestion(nextStart: LocalDate): Suggestion {
  return { id: "change-pay-rule", label: CHIP_LABEL, fill: exampleSentence(nextStart), help: composerHelp(nextStart) };
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
