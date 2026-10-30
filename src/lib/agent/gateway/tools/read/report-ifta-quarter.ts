import { reportTool } from "./report-tool";

export const reportIftaQuarter = reportTool("ifta_quarter", {
  description:
    "IFTA fuel tax summary for the calendar quarter holding asOf (YYYY-MM-DD in the carrier's time " +
    "zone; default today): for each state the miles driven, the tax-paid gallons bought there, the " +
    "taxable gallons (miles / fleet MPG), the net gallons and the tax due or credit in integer cents " +
    "at SAMPLE rates (placeholders, not official rates; say so whenever you quote a tax figure). Loads " +
    "count by delivery date, fuel by purchase date. Lists the data gaps it excluded (a load with no " +
    "state split or one that does not add up, a state with no sample rate); never fills a gap with " +
    "zero. Reads only; nothing is filed.",
  label: "Building the IFTA quarter summary",
});
