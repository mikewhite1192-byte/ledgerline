import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../src/config/flags";
import { evalRefusal, parseEvalArgs } from "./eval-args";

const saved = { ...flags.evalRun };
afterEach(() => {
  Object.assign(flags.evalRun, saved);
  vi.unstubAllEnvs();
});

describe("eval args", () => {
  it("defaults to every arm, every case and the switch's limit", () => {
    expect(parseEvalArgs([])).toEqual({ readme: false, arms: ["spark", "wonder", "spark_open"], cases: "all", fresh: false, maxCents: flags.evalRun.maxRunCents });
    expect(parseEvalArgs(["--arms", "spark_open,spark", "--cases", "10", "--fresh", "--max-cents", "250"])).toEqual({
      readme: false,
      arms: ["spark", "spark_open"],
      cases: "10",
      fresh: true,
      maxCents: 250,
    });
    expect(parseEvalArgs(["--readme"]).readme).toBe(true);
  });

  it("anything not in the usage is refused, not ignored", () => {
    for (const argv of [
      ["--arms", "spark,spark"],
      ["--arms", "spark_closed"],
      ["--arms"],
      ["--cases", "5"],
      ["--max-cents", "0"],
      ["--max-cents", "1.5"],
      ["--max-cents", String(flags.evalRun.maxRunCents + 1)],
      ["--fresh", "--fresh"],
      ["--readme", "--fresh"],
      ["--live"],
    ]) {
      expect(() => parseEvalArgs(argv), argv.join(" ")).toThrow();
    }
  });

  it("a run is refused with the switch off, on Aurora or in production", () => {
    expect(flags.evalRun.enabled).toBe(false);
    expect(evalRefusal()).toMatch(/switch is off/);
    flags.evalRun.enabled = true;
    vi.stubEnv("DB_CLUSTER_ARN", "arn:aws:rds:us-east-2:000000000000:cluster:example");
    expect(evalRefusal()).toMatch(/DB_CLUSTER_ARN/);
    vi.stubEnv("DB_CLUSTER_ARN", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(evalRefusal()).toMatch(/production/);
  });
});
