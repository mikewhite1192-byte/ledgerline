import { reportTool } from "./report-tool";

export const reportDriverPaySummary = reportTool("driver_pay_summary", {
  description:
    "Driver pay summary for one pay week: each driver's gross, deductions, net pay, amount carried " +
    "forward, exception count and settlement status, with totals in integer cents. periodStart is the " +
    "first day of the week (YYYY-MM-DD); leave it out for the latest week with a pay run. driverId " +
    "narrows it to one driver.",
  label: "Building the driver pay summary",
});
