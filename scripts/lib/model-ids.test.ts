import { describe, expect, it } from "vitest";
import { compareModels, liveIds, META_MODEL_VARS } from "./model-ids";

const LIVE = {
  object: "list",
  data: [
    { id: "muse-spark-1.3", object: "model" },
    { id: "muse-wonder-1.0", object: "model" },
    { id: "muse-voice-transcribe-1.0", object: "model" },
    { id: "muse-image-1.0", object: "model" },
    { id: "sam-3.1", object: "model" },
    { id: 42 },
  ],
};

const ENV = {
  META_MODEL_SPARK: "muse-spark-1.3",
  META_MODEL_WONDER: "muse-wonder-1.0",
  META_MODEL_VOICE: "muse-voice-transcribe-1.0",
  META_MODEL_IMAGE: "muse-image-1.0",
  META_MODEL_SAM: "sam-3.1",
};

describe("liveIds", () => {
  it("reads the string ids and skips anything else", () => {
    expect([...(liveIds(LIVE) ?? [])]).toEqual([
      "muse-spark-1.3",
      "muse-wonder-1.0",
      "muse-voice-transcribe-1.0",
      "muse-image-1.0",
      "sam-3.1",
    ]);
  });

  it("is null for an answer that is not a model list", () => {
    expect(liveIds(null)).toBeNull();
    expect(liveIds({ data: "x" })).toBeNull();
    expect(liveIds([])).toBeNull();
  });
});

describe("compareModels", () => {
  it("marks every configured id that is live", () => {
    const checks = compareModels(liveIds(LIVE)!, ENV);
    expect(checks.map((c) => c.variable)).toEqual([...META_MODEL_VARS]);
    expect(checks.every((c) => c.live)).toBe(true);
  });

  it("marks an unset variable and a near-miss id as missing", () => {
    const checks = compareModels(liveIds(LIVE)!, {
      ...ENV,
      META_MODEL_WONDER: undefined,
      // A prefix of a live id is not that id.
      META_MODEL_SPARK: "muse-spark-1",
      META_MODEL_SAM: "  ",
    });
    expect(checks.filter((c) => !c.live).map((c) => [c.variable, c.value])).toEqual([
      ["META_MODEL_SPARK", "muse-spark-1"],
      ["META_MODEL_WONDER", null],
      ["META_MODEL_SAM", null],
    ]);
  });
});
