// What the proposal card's auditor line means for the demo path's step 4.
//
// With the auditor released, the line must be one of its three verdicts, with one exception: on
// the deployed site, once the shared demo budget is spent, the card reads "Not checked: demo
// budget reached" and no audit call is made, so there is no verdict to check. That line marks the
// step skipped, never passed. Locally every run starts on a fresh database with the budget
// unspent, so the same line there is a failure. With the auditor off, the line must read
// "Auditor off". Every comparison is on the whole line.

export const VERDICTS = ["Checked by Muse Wonder: pass", "Muse Wonder has concerns", "Muse Wonder blocked this"];
export const BUDGET_REACHED = "Not checked: demo budget reached";
export const AUDITOR_OFF = "Auditor off";
export const AUDIT_LINES = [...VERDICTS, "Not checked", BUDGET_REACHED, AUDITOR_OFF];

export type AuditLineCheck = "verdict" | "off" | "budget_skip" | "wrong";

export function checkAuditLine(shown: string, options: { auditorOn: boolean; deployed: boolean }): AuditLineCheck {
  if (!options.auditorOn) return shown === AUDITOR_OFF ? "off" : "wrong";
  if (VERDICTS.includes(shown)) return "verdict";
  if (options.deployed && shown === BUDGET_REACHED) return "budget_skip";
  return "wrong";
}
