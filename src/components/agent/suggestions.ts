import type { Suggestion } from "@/components/app/prompt-chips";
import { CHIP_LABEL, COMPOSER_HELP, exampleSentence } from "@/lib/pay-rules/words";
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
// dated the first week a change can start, for the person to edit, and shows how to say one.
export function ruleChangeSuggestion(nextStart: LocalDate): Suggestion {
  return { id: "change-pay-rule", label: CHIP_LABEL, fill: exampleSentence(nextStart), help: COMPOSER_HELP };
}
