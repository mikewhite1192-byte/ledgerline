import { afterEach, describe, expect, it, vi } from "vitest";
import { actualCost, priceFor, type TokenPrice } from "./prices";
import {
  CONTRIBUTOR_IDS,
  contributorMode,
  isTarget,
  modelFor,
  modelIdFor,
  TARGETS,
} from "./targets";

const ENV = {
  META_MODEL_SPARK: "muse-spark-1.3",
  META_MODEL_WONDER: "muse-wonder-1.0",
  META_MODEL_VOICE: "muse-voice-transcribe-1.0",
  META_MODEL_IMAGE: "muse-image-1.0",
  META_MODEL_SAM: "sam-3.1",
  BASETEN_MODEL_ID: "meta-models/muse-spark-open-1026",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("TARGETS", () => {
  it("names each slot's provider, variable and call kind", () => {
    expect(TARGETS).toEqual({
      spark: { provider: "meta", env: "META_MODEL_SPARK", kind: "text" },
      wonder: { provider: "meta", env: "META_MODEL_WONDER", kind: "text" },
      spark_open: { provider: "baseten", env: "BASETEN_MODEL_ID", kind: "text" },
      voice: { provider: "meta", env: "META_MODEL_VOICE", kind: "transcribe" },
      image: { provider: "meta", env: "META_MODEL_IMAGE", kind: "image" },
      sam: { provider: "meta", env: "META_MODEL_SAM", kind: "segment" },
    });
    expect(isTarget("spark_open")).toBe(true);
    for (const bad of ["meta", "baseten", "toString", "__proto__", 1, null]) {
      expect(isTarget(bad), String(bad)).toBe(false);
    }
  });
});

describe("contributorMode", () => {
  it("is off when unset or false and on only for true", () => {
    expect(contributorMode(undefined)).toBe(false);
    expect(contributorMode("false")).toBe(false);
    expect(contributorMode("true")).toBe(true);
  });

  it("is null, refusing every call, for anything else", () => {
    for (const junk of ["", "TRUE", "True", "1", "0", "yes", "on", " true", "true ", "false\n"]) {
      expect(contributorMode(junk), JSON.stringify(junk)).toBeNull();
    }
  });
});

describe("modelIdFor", () => {
  it("reads each slot's variable when Contributor mode is off", () => {
    for (const mode of [undefined, "false"]) {
      const env = { ...ENV, META_CONTRIBUTOR_MODE: mode };
      expect(modelIdFor("spark", env)).toBe("muse-spark-1.3");
      expect(modelIdFor("wonder", env)).toBe("muse-wonder-1.0");
      expect(modelIdFor("spark_open", env)).toBe("meta-models/muse-spark-open-1026");
    }
  });

  it("swaps Spark, and only Spark, to its Contributor id when the mode is on", () => {
    const env = { ...ENV, META_CONTRIBUTOR_MODE: "true" };
    expect(modelIdFor("spark", env)).toBe("muse-spark-1.3-contributor");
    expect(modelIdFor("wonder", env)).toBe("muse-wonder-1.0");
    expect(modelIdFor("voice", env)).toBe("muse-voice-transcribe-1.0");
    expect(modelIdFor("image", env)).toBe("muse-image-1.0");
    expect(modelIdFor("sam", env)).toBe("sam-3.1");
    expect(modelIdFor("spark_open", env)).toBe("meta-models/muse-spark-open-1026");
  });

  it("refuses a junk mode, a Contributor id set directly, and a Spark id with no Contributor tier", () => {
    for (const target of Object.keys(TARGETS) as (keyof typeof TARGETS)[]) {
      expect(modelIdFor(target, { ...ENV, META_CONTRIBUTOR_MODE: "yes" }), target).toBeNull();
    }
    // The Contributor id is reached through the switch, never by naming it.
    for (const mode of [undefined, "false", "true"]) {
      const env = {
        ...ENV,
        META_MODEL_SPARK: "muse-spark-1.3-contributor",
        META_CONTRIBUTOR_MODE: mode,
      };
      expect(modelIdFor("spark", env), String(mode)).toBeNull();
    }
    // An older Spark has no Contributor id listed: the mode cannot be honored, so it refuses.
    const older = { ...ENV, META_MODEL_SPARK: "muse-spark-1.2" };
    expect(modelIdFor("spark", older)).toBe("muse-spark-1.2");
    expect(modelIdFor("spark", { ...older, META_CONTRIBUTOR_MODE: "true" })).toBeNull();
  });

  it("refuses every target, as a junk mode does, when the mode is on in production", () => {
    const production = { ...ENV, DB_CLUSTER_ARN: "arn:aws:rds:us-east-2:000000000000:cluster:x" };
    const on = { ...production, META_CONTRIBUTOR_MODE: "true" };
    for (const target of Object.keys(TARGETS) as (keyof typeof TARGETS)[]) {
      expect(modelIdFor(target, on), target).toBeNull();
    }
    // Unset or "false" in production works as it does anywhere else.
    for (const mode of [undefined, "false"]) {
      const env = { ...production, META_CONTRIBUTOR_MODE: mode };
      for (const target of Object.keys(TARGETS) as (keyof typeof TARGETS)[]) {
        const variable = TARGETS[target].env as keyof typeof ENV;
        expect(modelIdFor(target, env), `${target} ${String(mode)}`).toBe(ENV[variable]);
      }
    }
    // An empty DB_CLUSTER_ARN is not production: the mode still works.
    expect(modelIdFor("spark", { ...ENV, DB_CLUSTER_ARN: "", META_CONTRIBUTOR_MODE: "true" })).toBe(
      "muse-spark-1.3-contributor",
    );
  });

  it("lists a priced Contributor id for every Standard id it replaces", () => {
    for (const [standard, contributor] of Object.entries(CONTRIBUTOR_IDS)) {
      expect(priceFor("spark", standard), standard).not.toBeNull();
      expect(priceFor("spark", contributor), contributor).not.toBeNull();
    }
  });
});

describe("modelFor", () => {
  it("prices the model actually called", () => {
    vi.stubEnv("META_MODEL_SPARK", "muse-spark-1.3");
    vi.stubEnv("META_CONTRIBUTOR_MODE", "true");
    const called = modelFor("spark", "tokens");
    expect(called?.model).toBe("muse-spark-1.3-contributor");
    // 2,000 input (500 cached) and 1,000 output tokens: 1,500 x 10,000 + 500 x 200 + 1,000 x
    // 20,000 = 35,100,000 nanocents, about 0.035 cents (Standard is 0.6 cents).
    const usage = { input: 2_000, cached: 500, output: 1_000, reasoning: 400 };
    expect(actualCost(called!.price as TokenPrice, usage)).toBe(35_100_000);
    vi.stubEnv("META_CONTRIBUTOR_MODE", "false");
    const standard = modelFor("spark", "tokens");
    expect(standard?.model).toBe("muse-spark-1.3");
    expect(actualCost(standard!.price as TokenPrice, usage)).toBe(
      1_500 * 125_000 + 500 * 15_000 + 1_000 * 425_000,
    );
  });

  it("refuses a slot whose price is metered another way", () => {
    vi.stubEnv("META_MODEL_VOICE", "muse-voice-transcribe-1.0");
    vi.stubEnv("META_CONTRIBUTOR_MODE", "false");
    expect(modelFor("voice", "audio_seconds")?.model).toBe("muse-voice-transcribe-1.0");
    expect(modelFor("voice", "tokens")).toBeNull();
    vi.stubEnv("META_MODEL_VOICE", "");
    expect(modelFor("voice", "audio_seconds")).toBeNull();
  });

  it("calls Wonder only as muse-wonder-1.0, never a Contributor id, mode off or on", () => {
    vi.stubEnv("DB_CLUSTER_ARN", "");
    for (const mode of ["false", "true"]) {
      vi.stubEnv("META_CONTRIBUTOR_MODE", mode);
      vi.stubEnv("META_MODEL_WONDER", "muse-wonder-1.0");
      expect(modelFor("wonder", "tokens")?.model, mode).toBe("muse-wonder-1.0");
      vi.stubEnv("META_MODEL_WONDER", "muse-wonder-1.0-contributor");
      expect(modelFor("wonder", "tokens"), mode).toBeNull();
    }
  });
});
