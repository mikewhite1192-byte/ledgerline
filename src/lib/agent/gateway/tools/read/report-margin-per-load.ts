import { reportTool } from "./report-tool";

export const reportMarginPerLoad = reportTool("margin_per_load", {
  description:
    "Margin per load: for each load delivered between periodStart and periodEnd (YYYY-MM-DD, both " +
    "included, at most 92 days), the invoice amount, the driver's pay for it, the margin in integer " +
    "cents and the margin in basis points. A load with no rate shows no revenue and says so. " +
    "customerId narrows it to one customer.",
  label: "Building the margin per load report",
});
