// What the card's second-check line means for the demo path's step 4.
//
// With the auditor released, the line must be one of its three results, with one exception: on
// the deployed site, once the shared demo budget is spent, the card reads "Second check skipped:
// demo budget reached" and no audit call is made, so there is no result to check. That line marks
// the step skipped, never passed. Locally every run starts on a fresh database with the budget
// unspent, so the same line there is a failure. With the auditor off, the line must read
// "Second check is off". Every comparison is on the whole line.

export const VERDICTS = ["Second check passed", "Second check has concerns", "Second check did not pass"];
export const BUDGET_REACHED = "Second check skipped: demo budget reached";
export const AUDITOR_OFF = "Second check is off";
export const NOT_CHECKED = "Second check could not run";
export const AUDIT_LINES = [...VERDICTS, NOT_CHECKED, BUDGET_REACHED, AUDITOR_OFF];

export type AuditLineCheck = "verdict" | "off" | "budget_skip" | "wrong";

export function checkAuditLine(shown: string, options: { auditorOn: boolean; deployed: boolean }): AuditLineCheck {
  if (!options.auditorOn) return shown === AUDITOR_OFF ? "off" : "wrong";
  if (VERDICTS.includes(shown)) return "verdict";
  if (options.deployed && shown === BUDGET_REACHED) return "budget_skip";
  return "wrong";
}
