import { codeToWords } from "../format/labels";

// Plain words for why a run ended. A screen never shows the raw code.
const ENDED: Record<string, string> = {
  ok: "Finished with evidence",
  not_found: "The portal has no delivery times for this load",
  declined: "A person declined a safety check",
  approval_expired: "Nobody decided the safety check within 30 minutes",
  session_expired: "The portal session ended before the run could go on",
  step_budget: "Stopped at the step limit",
  wall_time: "Stopped at the time limit",
  run_cents: "Stopped at the run's cost limit",
  call_cents: "One step would cost more than the per-step limit",
  spend_cap: "The demo budget is used up",
  incomplete: "The model's answer was cut short twice",
  invalid_action: "The model asked for an action the runner refuses",
  too_many_checks: "Too many safety checks on one step",
  no_evidence: "The model's answer could not be read",
  screen_error: "The answer could not be screened, so it was not kept",
  screenshot_too_large: "A screenshot was larger than the limit",
  not_resumable: "The run could not pick up where it paused",
  browser_error: "The browser failed",
  db_error: "The database could not be reached",
  model_error: "The model call failed",
  runner_error: "The runner failed",
  session_error: "The portal session could not be made",
  sign_in_failed: "The runner could not sign in to the portal",
  no_portal_account: "This carrier has no portal account",
  no_portal_load: "The portal has no record of this load",
  forbidden: "The person who started the run is no longer a member",
  disabled: "Portal runs are switched off",
};

export function endedWords(reason: string | null): string | null {
  if (!reason) return null;
  return Object.hasOwn(ENDED, reason) ? ENDED[reason] : codeToWords(reason);
}
