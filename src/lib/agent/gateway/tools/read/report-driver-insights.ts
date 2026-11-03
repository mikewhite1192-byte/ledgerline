import { reportTool } from "./report-tool";

export const reportDriverInsights = reportTool("driver_insights", {
  description:
    "Rank this carrier's drivers over a window: net and gross pay from paid paystubs, loads delivered, " +
    "loaded and empty miles, advances taken, what each still owes (advances and deficits), fuel " +
    "deducted. Answers who earned the most, drove the most, took the most advances or owes the most. " +
    "Integer cents; dates in the carrier's zone (from and to, YYYY-MM-DD); default the 28 days ending " +
    "today. The leaders name the top driver of each figure, ties to the lower code. Display only: " +
    "every money action still needs a person's approval.",
  label: "Ranking the drivers",
});
