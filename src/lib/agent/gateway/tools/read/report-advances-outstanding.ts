import { reportTool } from "./report-tool";

export const reportAdvancesOutstanding = reportTool("advances_outstanding", {
  description:
    "Advances outstanding: per driver, how many advances are still being paid back, the amount " +
    "still owed, the oldest request date, the advance limit and the room left under it, in integer " +
    "cents. asOf (YYYY-MM-DD) counts advances requested on or before that day; leave it out for today.",
  label: "Building the advances outstanding report",
});
