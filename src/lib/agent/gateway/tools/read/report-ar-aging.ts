import { reportTool } from "./report-tool";

export const reportArAging = reportTool("ar_aging", {
  description:
    "Receivables aging: what each customer owes on open invoices today, split by how many days past " +
    "due each invoice is as of asOf (current, 1 to 30, 31 to 60, 61 to 90, over 90), with totals in " +
    "integer cents. asOf is a YYYY-MM-DD date in the carrier's time zone; leave it out for today. A " +
    "past asOf still shows today's open balances (payments and invoices since then included), only " +
    "aged as of that date; it is not what was owed on that date.",
  label: "Building the receivables aging report",
});
