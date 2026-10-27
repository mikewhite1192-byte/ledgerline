import { describe, expect, it } from "vitest";
import { checkCategory } from "./views";
import { endedWords } from "./words";

describe("words for people", () => {
  it("names every way a run can end in plain words, never the code", () => {
    for (const reason of [
      "ok", "not_found", "declined", "approval_expired", "session_expired", "step_budget", "wall_time", "run_cents",
      "call_cents", "spend_cap", "incomplete", "invalid_action", "too_many_checks", "no_evidence", "screen_error",
      "screenshot_too_large", "not_resumable", "browser_error", "db_error", "model_error", "runner_error",
      "session_error", "sign_in_failed", "no_portal_account", "no_portal_load", "forbidden", "disabled",
    ]) {
      expect(endedWords(reason), reason).toMatch(/^[A-Z][^_]*$/);
    }
    expect(endedWords("something_new")).toBe("Something new");
    expect(endedWords(null)).toBeNull();
  });

  it("shows a check as a category, never the platform's message", () => {
    expect(checkCategory("malicious_instructions")).toBe("The platform thinks this page is trying to instruct the agent");
    expect(checkCategory("irrelevant_domain")).toBe("The platform flagged this step (code: irrelevant_domain)");
  });
});
