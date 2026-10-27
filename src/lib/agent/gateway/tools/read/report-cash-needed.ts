import { reportTool } from "./report-tool";

export const reportCashNeeded = reportTool("cash_needed", {
  description:
    "Cash needed for a pay run: the net pay still to be paid for one week (settlements in draft or " +
    "approved), per driver, with subtotals for company drivers and owner-operators and the total, in " +
    "integer cents. periodStart is the first day of the week (YYYY-MM-DD); leave it out for the open week.",
  label: "Building the cash needed report",
});
