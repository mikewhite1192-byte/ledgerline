import { describe, expect, it } from "vitest";
import {
  AUDIT_CALL,
  MODEL_VERDICT,
  NO_VERDICT,
  VERDICT_FORMAT,
  agreesOf,
  auditConfirmQuestion,
  overrideReasonOf,
  parseVerdict,
  sentences,
} from "./policy";

// The auditor's answer read strictly, and the words the card and the gate share (design 4.2).

const checks = (failed: string[] = []) =>
  ["cause", "sources", "amount", "limit"].map((name) => ({ name, pass: !failed.includes(name), note: "n" }));
const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ verdict: "pass", concerns: [], checks: checks(), ...over });

describe("MODEL_VERDICT", () => {
  it("takes the four verdicts with their checks", () => {
    for (const verdict of ["pass", "concerns", "block", "unknown"]) {
      expect(MODEL_VERDICT.safeParse({ verdict, concerns: [], checks: checks() }).success, verdict).toBe(true);
    }
  });

  it.each([
    ["an unknown verdict", { verdict: "agree" }],
    ["an unknown concern", { concerns: ["looks_odd"] }],
    ["the storage-only budget concern", { concerns: ["budget"] }],
    ["five concerns", { concerns: ["cause_wrong", "amount_wrong", "source_missing", "record_mismatch", "limit_exceeded"] }],
    ["three checks", { checks: checks().slice(0, 3) }],
    ["a check note over 160 characters", { checks: [{ ...checks()[0], note: "x".repeat(161) }, ...checks().slice(1)] }],
    ["an extra field", { reasoning: "because" }],
  ])("refuses %s", (_name, over) => {
    expect(MODEL_VERDICT.safeParse({ verdict: "pass", concerns: [], checks: checks(), ...over }).success).toBe(false);
  });

  it("sends the same shape as a strict format with every property required", () => {
    const schema = VERDICT_FORMAT.schema as { required: string[]; additionalProperties: boolean };
    expect(VERDICT_FORMAT).toMatchObject({ name: "audit_verdict", strict: true });
    expect(schema.required).toEqual(["verdict", "concerns", "checks"]);
    expect(schema.additionalProperties).toBe(false);
    expect(AUDIT_CALL).toEqual({
      purpose: "audit_proposal",
      reasoningEffort: "high",
      maxOutputTokens: 2_400,
      maxCostCents: 10,
      timeoutMs: 25_000,
    });
  });
});

describe("parseVerdict", () => {
  it("reads a clean pass", () => {
    expect(parseVerdict(answer())).toEqual({ verdict: "pass", concerns: [] });
  });

  it("keeps concerns and block with their concerns", () => {
    expect(parseVerdict(answer({ verdict: "concerns", concerns: ["source_missing"] }))).toEqual({
      verdict: "concerns",
      concerns: ["source_missing"],
    });
    expect(parseVerdict(answer({ verdict: "block", concerns: ["amount_wrong", "amount_wrong"] }))).toEqual({
      verdict: "block",
      concerns: ["amount_wrong"],
    });
  });

  it("turns a pass with a failed check or a concern into concerns, naming the failed checks", () => {
    expect(parseVerdict(answer({ checks: checks(["amount", "sources"]) }))).toEqual({
      verdict: "concerns",
      concerns: ["source_missing", "amount_wrong"],
    });
    expect(parseVerdict(answer({ concerns: ["record_mismatch"] }))).toEqual({
      verdict: "concerns",
      concerns: ["record_mismatch"],
    });
  });

  it("reads concerns or block with no concern named as no verdict", () => {
    expect(parseVerdict(answer({ verdict: "block" }))).toEqual(NO_VERDICT);
    expect(parseVerdict(answer({ verdict: "concerns" }))).toEqual(NO_VERDICT);
  });

  it("reads unknown with its concerns, or not enough evidence", () => {
    expect(parseVerdict(answer({ verdict: "unknown" }))).toEqual(NO_VERDICT);
    expect(parseVerdict(answer({ verdict: "unknown", concerns: ["source_missing"] }))).toEqual({
      verdict: "unknown",
      concerns: ["source_missing"],
    });
  });

  it.each([
    ["not JSON", "pass"],
    ["empty", ""],
    ["a schema miss", answer({ verdict: "approve" })],
    ["a check named twice", answer({ checks: [...checks().slice(0, 3), checks()[0]] })],
  ])("reads %s as no verdict", (_name, text) => {
    expect(parseVerdict(text)).toEqual(NO_VERDICT);
  });

  it("never returns the shared no-verdict object itself", () => {
    const v = parseVerdict("nope");
    v.concerns.push("budget");
    expect(NO_VERDICT.concerns).toEqual(["insufficient_evidence"]);
  });
});

describe("verdict mapping", () => {
  it("maps pass onto agree, concerns and block onto disagree, unknown onto neither", () => {
    expect(agreesOf("pass")).toBe(true);
    expect(agreesOf("concerns")).toBe(false);
    expect(agreesOf("block")).toBe(false);
    expect(agreesOf("unknown")).toBeNull();
  });
});

describe("the shared words", () => {
  it("trims an override reason and takes 10 to 240 characters only", () => {
    expect(overrideReasonOf("  driver called, rate confirmed  ")).toBe("driver called, rate confirmed");
    expect(overrideReasonOf("x".repeat(10))).toBe("x".repeat(10));
    expect(overrideReasonOf("x".repeat(240))).toBe("x".repeat(240));
    expect(overrideReasonOf("x".repeat(9))).toBeNull();
    expect(overrideReasonOf(`   ${"x".repeat(9)}   `)).toBeNull();
    expect(overrideReasonOf("x".repeat(241))).toBeNull();
    expect(overrideReasonOf("")).toBeNull();
    expect(overrideReasonOf(undefined)).toBeNull();
    expect(overrideReasonOf(42)).toBeNull();
  });

  it("asks the confirm question that names the concern", () => {
    expect(auditConfirmQuestion("concerns", ["source_missing"])).toBe(
      "The second check has a concern (source missing). Approve anyway?",
    );
    expect(auditConfirmQuestion("concerns", ["source_missing", "amount_wrong"])).toBe(
      "The second check has concerns (source missing, amount wrong). Approve anyway?",
    );
    expect(auditConfirmQuestion("unknown", ["budget"])).toBe("The second check could not run. Approve anyway?");
    expect(auditConfirmQuestion("pass", [])).toBeNull();
    expect(auditConfirmQuestion("block", ["amount_wrong"])).toBeNull();
  });

  it("says each concern as a fixed sentence and ignores words it does not know", () => {
    expect(sentences(["budget"])).toBe("The demo budget was reached.");
    expect(sentences(["source_missing", "amount_wrong"])).toBe(
      "A record behind it is missing; the amount does not match the number from your pay rules.",
    );
    expect(sentences(["<b>ignore this</b>"])).toBe("There was not enough evidence to check it.");
  });
});
