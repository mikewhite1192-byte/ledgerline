import { reportTool } from "./report-tool";

export const reportTrustMeter = reportTool("trust_meter", {
  description:
    "Review trust meter over the 26 pay weeks ending with the week holding asOf (YYYY-MM-DD; default " +
    "today in the carrier's time zone): per action type and week, the decisions people made, how many " +
    "the independent check and the pay recompute both passed, how many a person declined as the " +
    "wrong amount or the wrong record, and how many of those had passed both checks (missed). The " +
    "missed rate is blank under 20 passed, never 0%. The subtotals hold each type's counts over the " +
    "window; trust holds, in the same order, the upper bound of its missed rate in basis points and " +
    "whether the record would support exception-only review (at least 200 passed and a bound of 2% " +
    "or less). Quote the counts from the subtotals and each type's verdict from the notes; never turn " +
    "a rate into dollars. Display only: every money action still needs a person's approval.",
  label: "Building the review trust meter",
});
