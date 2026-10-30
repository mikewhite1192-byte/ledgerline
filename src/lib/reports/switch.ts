import { flags } from "../../config/flags";
import type { ReportName } from "./types";

// A report's own switch, read on every call, for the reports that ship dark behind one. A report
// not listed here needs only reportsEnabled.
const REPORT_FLAGS: Readonly<Partial<Record<ReportName, () => boolean>>> = {
  ifta_quarter: () => flags.iftaEnabled,
  year_end_contractors: () => flags.yearEndEnabled,
  trust_meter: () => flags.trustMeterEnabled,
};

// Whether a report may run right now: every report needs reportsEnabled, and a listed one also
// needs its own switch. The one place the report switches are read, so the tool, the offer list,
// the download route and computeReport always agree.
export function reportSwitchOn(name: ReportName): boolean {
  const own = Object.hasOwn(REPORT_FLAGS, name) ? REPORT_FLAGS[name] : undefined;
  return flags.reportsEnabled && (own ? own() : true);
}

// Thrown when a report's switch is off, so a call that got past the registry or the route still
// fails closed.
export class ReportsOffError extends Error {
  constructor() {
    super("reports are switched off");
    this.name = "ReportsOffError";
  }
}
