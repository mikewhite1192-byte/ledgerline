import { afterEach, describe, expect, it } from "vitest";
import { JUDGE_SIGN_INS_PER_MINUTE, resetJudgeSignIns, signInBrake, takeJudgeSignIn } from "./judge-throttle";

// The demo sign-in's brake per process: a rolling minute, at most twenty, time passed in.

const T0 = Date.UTC(2026, 10, 2, 15, 0, 0);

afterEach(() => resetJudgeSignIns());

describe("signInBrake", () => {
  it("lets twenty through in a minute and refuses the next", () => {
    expect(JUDGE_SIGN_INS_PER_MINUTE).toBe(20);
    const brake = signInBrake();
    for (let i = 0; i < 20; i++) expect(brake.take(T0 + i * 1_000)).toBe(true);
    expect(brake.take(T0 + 20_000)).toBe(false);
    expect(brake.take(T0 + 59_999)).toBe(false);
  });

  it("lets one more through for each that leaves the rolling minute", () => {
    const brake = signInBrake(2, 60_000);
    expect(brake.take(T0)).toBe(true);
    expect(brake.take(T0 + 10_000)).toBe(true);
    expect(brake.take(T0 + 59_999)).toBe(false);
    expect(brake.take(T0 + 60_000)).toBe(true);
    expect(brake.take(T0 + 60_001)).toBe(false);
    expect(brake.take(T0 + 70_000)).toBe(true);
  });

  it("refuses a time that is not a number, and counts nothing for it", () => {
    const brake = signInBrake(1, 60_000);
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) expect(brake.take(now)).toBe(false);
    expect(brake.take(T0)).toBe(true);
  });
});

describe("takeJudgeSignIn", () => {
  it("is one brake for the process, fresh again after a reset", () => {
    for (let i = 0; i < 20; i++) expect(takeJudgeSignIn(T0)).toBe(true);
    expect(takeJudgeSignIn(T0 + 1)).toBe(false);
    resetJudgeSignIns();
    expect(takeJudgeSignIn(T0 + 2)).toBe(true);
  });
});
