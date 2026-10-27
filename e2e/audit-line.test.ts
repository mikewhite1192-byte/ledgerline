import { describe, expect, it } from "vitest";
import { AUDITOR_OFF, BUDGET_REACHED, checkAuditLine, VERDICTS } from "./audit-line";

const ON_DEPLOYED = { auditorOn: true, deployed: true };
const ON_LOCAL = { auditorOn: true, deployed: false };

describe("checkAuditLine", () => {
  it("with the auditor on, accepts each of its three verdicts, deployed or local", () => {
    for (const verdict of VERDICTS) {
      expect(checkAuditLine(verdict, ON_DEPLOYED)).toBe("verdict");
      expect(checkAuditLine(verdict, ON_LOCAL)).toBe("verdict");
    }
  });

  it("on the deployed site, a spent demo budget skips the verdict check instead of failing it", () => {
    expect(checkAuditLine(BUDGET_REACHED, ON_DEPLOYED)).toBe("budget_skip");
  });

  it("locally, a spent demo budget is a failure: every run starts with the budget unspent", () => {
    expect(checkAuditLine(BUDGET_REACHED, ON_LOCAL)).toBe("wrong");
  });

  it("with the auditor on, any other line fails, a plain Not checked and Auditor off among them", () => {
    for (const shown of ["Not checked", AUDITOR_OFF, "", "Checked by Muse Wonder", "Not checked: demo budget"]) {
      expect(checkAuditLine(shown, ON_DEPLOYED), shown).toBe("wrong");
      expect(checkAuditLine(shown, ON_LOCAL), shown).toBe("wrong");
    }
  });

  it("with the auditor off, only Auditor off passes, and a spent budget is not skipped", () => {
    for (const deployed of [true, false]) {
      expect(checkAuditLine(AUDITOR_OFF, { auditorOn: false, deployed })).toBe("off");
      for (const shown of [...VERDICTS, "Not checked", BUDGET_REACHED]) {
        expect(checkAuditLine(shown, { auditorOn: false, deployed }), shown).toBe("wrong");
      }
    }
  });
});
