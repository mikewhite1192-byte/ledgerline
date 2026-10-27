import { reportTool } from "./report-tool";

export const reportArAging = reportTool("ar_aging", {
  description:
    "Receivables aging: what each customer owes on open invoices, split by days past due (current, " +
    "1 to 30, 31 to 60, 61 to 90, over 90), with totals in integer cents. asOf is a YYYY-MM-DD date " +
    "in the carrier's time zone; leave it out for today.",
  label: "Building the receivables aging report",
});
