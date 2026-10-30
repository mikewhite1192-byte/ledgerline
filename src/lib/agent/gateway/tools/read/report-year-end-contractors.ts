import { OPERATOR_AUDITOR } from "../shared";
import { reportTool } from "./report-tool";

export const reportYearEndContractors = reportTool(
  "year_end_contractors",
  {
    description:
      "Year-end 1099-NEC totals for one calendar year (year: four digits; default this year in the " +
      "carrier's time zone): for each contractor (owner-operator) paid that year, the settlements " +
      "paid, the nonemployee compensation (load pay + accessorial pay on paid settlements, by paid " +
      "date), the reimbursements and the approved pay corrections (both shown apart, not counted: a " +
      "correction can be pay, a reimbursement or a refunded charge) in integer cents, and whether the " +
      "compensation meets the 1099-NEC threshold: yes, no, or unknown when the threshold for that " +
      "year is not known or the answer depends on the corrections (never guess yes or no; a person " +
      "decides). form1099.thresholdCents is the threshold the rows were checked against; say to " +
      "confirm it for the tax year whenever you quote it. Company drivers are not listed. driverId " +
      "narrows to one contractor. Reads only; nothing is filed and no form is made.",
    label: "Building the year-end 1099 totals",
  },
  OPERATOR_AUDITOR,
);
