import { describe, expect, it } from "vitest";
import {
  DEMO_SECRET_NAME,
  demoLogins,
  JUDGE_SECRET_NAME,
  parseDemoUserArgs,
  planPasswords,
} from "./demo-logins";

// A password source that counts, so every new password is told apart.
function counter() {
  let n = 0;
  return () => `new-${++n}`;
}

const ALL = demoLogins({ resetPasswords: false, judge: true, clerk: true });

describe("parseDemoUserArgs", () => {
  it("reads the three flags and nothing else", () => {
    expect(parseDemoUserArgs([])).toEqual({ resetPasswords: false, judge: false, clerk: false });
    expect(parseDemoUserArgs(["--judge", "--clerk", "--reset-passwords"])).toEqual({
      resetPasswords: true,
      judge: true,
      clerk: true,
    });
    expect(() => parseDemoUserArgs(["--judges"])).toThrow(/unknown option --judges/);
    expect(() => parseDemoUserArgs(["judge"])).toThrow(/unknown option/);
  });
});

describe("demoLogins", () => {
  it("keeps the two carriers' admin logins by default", () => {
    const logins = demoLogins({ resetPasswords: false, judge: false, clerk: false });
    expect(logins.map((l) => [l.key, l.email, l.role, l.secret])).toEqual([
      ["blue-ridge", "ops@blueridge.example", "admin", "demo"],
      ["prairie-wind", "ops@prairiewind.example", "admin", "demo"],
    ]);
  });

  it("adds the clerk as staff and the demo visitor as a judge, both on Blue Ridge, after its admin", () => {
    expect(ALL.map((l) => [l.key, l.email, l.role, l.carrier.slug, l.secret])).toEqual([
      ["blue-ridge", "ops@blueridge.example", "admin", "blue-ridge", "demo"],
      ["prairie-wind", "ops@prairiewind.example", "admin", "prairie-wind", "demo"],
      ["blue-ridge-clerk", "clerk@blueridge.example", "staff", "blue-ridge", "demo"],
      ["judge", "judge@blueridge.example", "judge", "blue-ridge", "judge"],
    ]);
    expect(DEMO_SECRET_NAME).toBe("payday-copilot/demo-logins");
    expect(JUDGE_SECRET_NAME).toBe("payday-copilot/judge-login");
  });
});

describe("planPasswords", () => {
  const stored = {
    demo: {
      "blue-ridge": { email: "ops@blueridge.example", password: "br" },
      "prairie-wind": { email: "ops@prairiewind.example", password: "pw" },
      "blue-ridge-clerk": { email: "clerk@blueridge.example", password: "cl" },
      "someone-else": { email: "kept@example.test", password: "kept" },
    },
    judge: { email: "judge@blueridge.example", password: "jd" },
  };

  it("applies every stored password on every run and writes no secret", () => {
    const plan = planPasswords(ALL, stored, false, counter());
    expect(plan.writeDemo).toBe(false);
    expect(plan.writeJudge).toBe(false);
    expect(plan.apply).toEqual([
      { email: "ops@blueridge.example", password: "br" },
      { email: "ops@prairiewind.example", password: "pw" },
      { email: "clerk@blueridge.example", password: "cl" },
      { email: "judge@blueridge.example", password: "jd" },
    ]);
  });

  it("gives a new password only to a login with none recorded, and keeps every other key", () => {
    const plan = planPasswords(ALL, { demo: { ...stored.demo, "blue-ridge-clerk": undefined } }, false, counter());
    expect(plan.writeDemo).toBe(true);
    expect(plan.writeJudge).toBe(true);
    expect(plan.demo).toEqual({
      ...stored.demo,
      "blue-ridge-clerk": { email: "clerk@blueridge.example", password: "new-1" },
    });
    expect(plan.judge).toEqual({ email: "judge@blueridge.example", password: "new-2" });
    expect(plan.apply.map((p) => p.password)).toEqual(["br", "pw", "new-1", "new-2"]);
  });

  it("treats a password saved under another email, or empty, as unknown", () => {
    const plan = planPasswords(
      ALL,
      {
        demo: {
          ...stored.demo,
          "blue-ridge": { email: "ops@elsewhere.example", password: "br" },
          "prairie-wind": { email: "ops@prairiewind.example", password: "" },
        },
        judge: { email: "judge@blueridge.example" },
      },
      false,
      counter(),
    );
    expect(plan.apply.map((p) => p.password)).toEqual(["new-1", "new-2", "cl", "new-3"]);
    expect(plan.writeDemo).toBe(true);
    expect(plan.writeJudge).toBe(true);
  });

  it("gives every login a new password with --reset-passwords", () => {
    const plan = planPasswords(ALL, stored, true, counter());
    expect(plan.apply.map((p) => p.password)).toEqual(["new-1", "new-2", "new-3", "new-4"]);
    expect(plan.demo["someone-else"]).toEqual(stored.demo["someone-else"]);
  });

  it("keeps the demo visitor's password out of demo-logins and its own secret to that one login", () => {
    const plan = planPasswords(ALL, {}, false, counter());
    expect(Object.keys(plan.demo)).toEqual(["blue-ridge", "prairie-wind", "blue-ridge-clerk"]);
    expect(plan.judge).toEqual({ email: "judge@blueridge.example", password: "new-4" });
    // Without --judge the judge's secret is neither read into the plan nor written.
    const plain = planPasswords(demoLogins({ resetPasswords: false, judge: false, clerk: false }), {}, false, counter());
    expect(plain.judge).toBeUndefined();
    expect(plain.writeJudge).toBe(false);
  });

  it("stops on a demo-logins secret it cannot read rather than overwrite it", () => {
    for (const demo of ["text", null, [], 7]) {
      expect(() => planPasswords(ALL, { demo }, false, counter())).toThrow(/not a JSON object/);
    }
  });
});
