import { flags } from "../../config/flags";
import type { ReportName } from "./types";

// Whether a report may run right now: every report needs reportsEnabled, and the IFTA quarter
// also needs its own switch. The one place the report switches are read, so the tool, the offer
// list and the download route always agree.
export function reportSwitchOn(name: ReportName): boolean {
  return flags.reportsEnabled && (name !== "ifta_quarter" || flags.iftaEnabled);
}
