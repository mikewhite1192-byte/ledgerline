import { describe, expect, it } from "vitest";
import {
  actualCost,
  audioReserve,
  capNanocents,
  centsToDisplay,
  CAP_CEILING_CENTS,
  dollarsToDisplay,
  estimateReserve,
  IMAGE_NANOCENTS,
  MEDIA_RESERVE_TOKENS,
  mediaReserveTokens,
  meteredCost,
  NANOCENTS_PER_CENT,
  PDF_PAGE_RESERVE_TOKENS,
  priceFor,
  SAM_NANOCENTS,
  SAM_VIDEO_FRAME_NANOCENTS,
  SAM_VIDEO_MIN_FRAMES,
  savedByCache,
  VIDEO_FRAME_RESERVE_TOKENS,
  VIDEO_SECOND_RESERVE_TOKENS,
  videoFramesCost,
  videoReserveTokens,
  VOICE_NANOCENTS_PER_SECOND,
  wonderCapNanocents,
  type Price,
  type TokenPrice,
} from "./prices";

function tokens(price: Price | null): TokenPrice {
  if (price?.unit !== "tokens") throw new Error("not a token price");
  return price;
}

const SPARK = { unit: "tokens", input: 125_000, cached: 15_000, output: 425_000 };

describe("prices", () => {
  it("lists Meta's Standard prices in nanocents per token, exactly", () => {
    // $1.25, $0.15 and $4.25 per million tokens.
    for (const model of ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1"]) {
      expect(priceFor("spark", "meta", model), model).toEqual(SPARK);
    }
    expect(priceFor("spark_open", "baseten", "meta-models/muse-spark-open-1026")).toEqual(SPARK);
    // $4.00, $0.20 and $20.00 per million tokens.
    expect(priceFor("wonder", "meta", "muse-wonder-1.0")).toEqual({
      unit: "tokens",
      input: 400_000,
      cached: 20_000,
      output: 2_000_000,
    });
    // A million output tokens is 425 cents on Spark and 2,000 on Wonder.
    expect(1_000_000 * tokens(priceFor("spark", "meta", "muse-spark-1.3")).output).toBe(
      425 * NANOCENTS_PER_CENT,
    );
    expect(1_000_000 * tokens(priceFor("wonder", "meta", "muse-wonder-1.0")).output).toBe(
      2_000 * NANOCENTS_PER_CENT,
    );
  });

  it("lists the Spark Contributor tier at its own prices, exactly", () => {
    // $0.10, $0.002 and $0.20 per million tokens.
    expect(priceFor("spark", "meta", "muse-spark-1.3-contributor")).toEqual({
      unit: "tokens",
      input: 10_000,
      cached: 200,
      output: 20_000,
    });
    const contributor = tokens(priceFor("spark", "meta", "muse-spark-1.3-contributor"));
    expect(1_000_000 * contributor.output).toBe(20 * NANOCENTS_PER_CENT);
    // The measured 15-in, 64-out Spark answer: 0.029075 cents Standard, 0.001430 Contributor.
    const usage = { input: 15, cached: 0, output: 64, reasoning: 62 };
    expect(actualCost(contributor, usage)).toBe(15 * 10_000 + 64 * 20_000);
    expect(meteredCost(contributor, { unit: "tokens", usage })).toBe(1_430_000);
    // No other slot has the tier.
    expect(priceFor("wonder", "meta", "muse-wonder-1.0-contributor")).toBeNull();
    expect(priceFor("spark_open", "baseten", "muse-spark-1.3-contributor")).toBeNull();
  });

  it("lists the per-second and per-image prices in nanocents, exactly", () => {
    // $0.18 an hour is 18 cents / 3,600 s.
    expect(VOICE_NANOCENTS_PER_SECOND * 3_600).toBe(18 * NANOCENTS_PER_CENT);
    expect(priceFor("voice", "meta", "muse-voice-transcribe-1.0")).toEqual({
      unit: "audio_seconds",
      perSecond: 5_000_000,
    });
    // $0.01 an image.
    expect(IMAGE_NANOCENTS).toBe(NANOCENTS_PER_CENT);
    expect(priceFor("image", "meta", "muse-image-1.0")).toEqual({ unit: "images", perImage: 1e9 });
    // $2.50 per 1,000 images.
    expect(SAM_NANOCENTS * 1_000).toBe(250 * NANOCENTS_PER_CENT);
    // $0.20 per 1,000 video frames, at least 50 frames a request.
    expect(SAM_VIDEO_FRAME_NANOCENTS * 1_000).toBe(20 * NANOCENTS_PER_CENT);
    expect(SAM_VIDEO_MIN_FRAMES).toBe(50);
    expect(priceFor("sam", "meta", "sam-3.1")).toEqual({
      unit: "segmentation",
      perImage: 250_000_000,
      perFrame: 20_000_000,
      minFrames: 50,
    });
  });

  it("bills a SAM video at least 50 frames, and a still per image", () => {
    const sam = priceFor("sam", "meta", "sam-3.1");
    if (sam?.unit !== "segmentation") throw new Error("no segmentation price");
    // A 10-frame clip is billed 50; the 144-frame demo clip is billed 144 (2.88 cents).
    expect(videoFramesCost(sam, 10)).toBe(50 * 20_000_000);
    expect(videoFramesCost(sam, 144)).toBe(144 * 20_000_000);
    expect(meteredCost(sam, { unit: "video_frames", count: 10 })).toBe(1_000_000_000);
    expect(meteredCost(sam, { unit: "video_frames", count: 144 })).toBe(2_880_000_000);
    expect(meteredCost(sam, { unit: "images", count: 2 })).toBe(500_000_000);
    // The longest clip the table allows (600 frames) stays under the 13-cent redaction cap.
    expect(videoFramesCost(sam, 600)).toBeLessThanOrEqual(13 * NANOCENTS_PER_CENT);
    // A token meter never prices a segmentation call.
    expect(meteredCost(sam, { unit: "audio_seconds", seconds: 1 })).toBeNull();
  });

  it("refuses models it has no price for, unlisted Contributor ids and prototype keys included", () => {
    for (const model of [
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-Contributor",
      "muse-image-1.0",
      "muse-spark",
      "",
      "constructor",
      "__proto__",
    ]) {
      expect(priceFor("spark", "meta", model), model).toBeNull();
    }
    // An id is priced only in its own slot.
    expect(priceFor("spark_open", "baseten", "muse-spark-1.3")).toBeNull();
    expect(priceFor("spark", "meta", "meta-models/muse-spark-open-1026")).toBeNull();
    expect(priceFor("spark", "meta", "meta-models/muse-spark-open")).toBeNull();
    expect(priceFor("spark_open", "baseten", "meta-models/muse-spark-open")).toBeNull();
    expect(priceFor("wonder", "meta", "muse-spark-1.3")).toBeNull();
    expect(priceFor("spark", "meta", "muse-wonder-1.0")).toBeNull();
    expect(priceFor("voice", "meta", "muse-image-1.0")).toBeNull();
    expect(priceFor("image", "meta", "sam-3.1")).toBeNull();
    expect(priceFor("sam", "meta", "__proto__")).toBeNull();
    // Each host prices only its own ids: a Baseten id is not a Fireworks price, and back.
    expect(priceFor("spark_open", "fireworks", "accounts/fireworks/models/muse-spark-open")).toEqual(
      SPARK,
    );
    expect(priceFor("spark_open", "fireworks", "meta-models/muse-spark-open-1026")).toBeNull();
    expect(priceFor("spark_open", "baseten", "accounts/fireworks/models/muse-spark-open")).toBeNull();
    expect(priceFor("spark_open", "meta", "meta-models/muse-spark-open-1026")).toBeNull();
    expect(priceFor("spark", "fireworks", "muse-spark-1.3")).toBeNull();
    expect(priceFor("spark", "baseten", "muse-spark-1.3")).toBeNull();
    expect(priceFor("spark_open", "fireworks", "__proto__")).toBeNull();
  });

  it("reserves a token per two request bytes of input plus every output token", () => {
    const price = tokens(priceFor("spark", "meta", "muse-spark-1.3"));
    // 400 bytes is 200 tokens; 256 output tokens.
    expect(estimateReserve(price, 400, 256)).toBe(200 * 125_000 + 256 * 425_000);
    expect(estimateReserve(price, 400, 256)).toBe(133_800_000);
    // 401 bytes is 201 tokens (rounded up).
    expect(estimateReserve(price, 401, 256)).toBe(201 * 125_000 + 256 * 425_000);
    expect(estimateReserve(price, 401, 256)).toBe(133_925_000);
    // The proof call's budget: 1024 output tokens is under half a cent.
    expect(estimateReserve(price, 300, 1024)).toBe(150 * 125_000 + 1024 * 425_000);
    expect(estimateReserve(price, 300, 1024)).toBeLessThan(NANOCENTS_PER_CENT / 2);
  });

  it("reserves 1,600 input tokens per image and 4,000 per PDF page", () => {
    expect(MEDIA_RESERVE_TOKENS).toBe(1_600);
    expect(PDF_PAGE_RESERVE_TOKENS).toBe(4_000);
    expect(mediaReserveTokens(2, 3)).toBe(2 * 1_600 + 3 * 4_000);
    expect(mediaReserveTokens(2, 3, null)).toBe(2 * 1_600 + 3 * 4_000);
    const price = tokens(priceFor("spark", "meta", "muse-spark-1.3"));
    // 400 bytes of text, two images and a three-page PDF, 256 output tokens.
    expect(estimateReserve(price, 400, 256, mediaReserveTokens(2, 3))).toBe(
      (200 + 15_200) * 125_000 + 256 * 425_000,
    );
  });

  it("reserves a video by its whole seconds and its frames, 1.5 times the measured rate", () => {
    expect(VIDEO_SECOND_RESERVE_TOKENS).toBe(380);
    expect(VIDEO_FRAME_RESERVE_TOKENS).toBe(48);
    // The demo clip: 18 s and 144 frames measured about 4,550 video tokens.
    expect(videoReserveTokens(144, 18_000)).toBe(18 * 380 + 144 * 48);
    expect(videoReserveTokens(144, 18_000)).toBeGreaterThan(4_550 * 1.5);
    // 2.1 s rounds up to 3 s.
    expect(videoReserveTokens(10, 2_100)).toBe(3 * 380 + 10 * 48);
    expect(mediaReserveTokens(0, 0, { frames: 144, durationMs: 18_000 })).toBe(18 * 380 + 144 * 48);
    // The longest clip read (20 s, 600 frames) with 2,048 output tokens stays under the 10-cent
    // reading cap.
    const price = tokens(priceFor("spark", "meta", "muse-spark-1.3"));
    expect(estimateReserve(price, 4_000, 2_048, videoReserveTokens(600, 20_000))).toBeLessThan(10 * NANOCENTS_PER_CENT);
  });

  it("reserves every second of audio, rounded up, and one more", () => {
    // 2.18 s at 16 kHz: 3 s rounded up, plus 1.
    expect(audioReserve(VOICE_NANOCENTS_PER_SECOND, 34_901, 16_000)).toBe(4 * 5_000_000);
    // Exactly 3 s at 24 kHz: 3 plus 1.
    expect(audioReserve(VOICE_NANOCENTS_PER_SECOND, 72_000, 24_000)).toBe(4 * 5_000_000);
    // The 600 s limit reserves 601 s: about 3 cents.
    expect(audioReserve(VOICE_NANOCENTS_PER_SECOND, 600 * 16_000, 16_000)).toBe(3_005_000_000);
  });

  it("costs an answer by what it was metered in, and nothing else", () => {
    const spark = priceFor("spark", "meta", "muse-spark-1.3")!;
    const voice = priceFor("voice", "meta", "muse-voice-transcribe-1.0")!;
    const image = priceFor("image", "meta", "muse-image-1.0")!;
    const sam = priceFor("sam", "meta", "sam-3.1")!;
    const usage = { input: 15, cached: 0, output: 64, reasoning: 62 };
    expect(meteredCost(spark, { unit: "tokens", usage })).toBe(29_075_000);
    // The measured transcription: 2,240 ms is metered as 2 whole seconds.
    expect(meteredCost(voice, { unit: "audio_seconds", seconds: 2 })).toBe(10_000_000);
    expect(meteredCost(image, { unit: "images", count: 1 })).toBe(NANOCENTS_PER_CENT);
    expect(meteredCost(image, { unit: "images", count: 0 })).toBe(0);
    expect(meteredCost(sam, { unit: "images", count: 1 })).toBe(250_000_000);
    // A mismatch is not a cost.
    expect(meteredCost(spark, { unit: "images", count: 1 })).toBeNull();
    expect(meteredCost(voice, { unit: "tokens", usage })).toBeNull();
    expect(meteredCost(image, { unit: "audio_seconds", seconds: 1 })).toBeNull();
  });

  it("charges uncached input, cached input and output (reasoning is inside output)", () => {
    const price = tokens(priceFor("spark", "meta", "muse-spark-1.3"));
    // in=134 cached=0 out=212: 16,750,000 + 90,100,000 nanocents, shown rounded up.
    const example = actualCost(price, { input: 134, cached: 0, output: 212, reasoning: 150 });
    expect(example).toBe(134 * 125_000 + 212 * 425_000);
    expect(centsToDisplay(example)).toBe("0.1069");
    // The measured call: 15 in, 64 out of which 62 reasoning. Reasoning adds nothing extra.
    const measured = actualCost(price, { input: 15, cached: 0, output: 64, reasoning: 62 });
    expect(measured).toBe(15 * 125_000 + 64 * 425_000);
    expect(measured).toBe(29_075_000);
    // Cached tokens are billed at the cached rate, not on top of input.
    expect(actualCost(price, { input: 1000, cached: 600, output: 0, reasoning: 0 })).toBe(
      400 * 125_000 + 600 * 15_000,
    );
  });

  it("reads the cap as whole cents up to the ceiling, and refuses anything else", () => {
    expect(capNanocents("12000")).toBe(12_000 * NANOCENTS_PER_CENT);
    expect(capNanocents("1")).toBe(NANOCENTS_PER_CENT);
    expect(capNanocents(String(CAP_CEILING_CENTS))).toBe(40_000 * NANOCENTS_PER_CENT);
    for (const bad of [
      undefined,
      "",
      "0",
      "00",
      "-1",
      "40001",
      "120.00",
      "1e4",
      " 12000",
      "12000 ",
      "0x10",
      "abc",
    ]) {
      expect(capNanocents(bad), String(bad)).toBeNull();
    }
    // The largest cap stays a safe integer.
    expect(Number.isSafeInteger(capNanocents("40000"))).toBe(true);
  });

  it("reads the Wonder cap as whole cents up to the overall cap, and refuses anything else", () => {
    const overall = capNanocents("12000");
    expect(wonderCapNanocents("3000", overall)).toBe(3_000 * NANOCENTS_PER_CENT);
    expect(wonderCapNanocents("12000", overall)).toBe(12_000 * NANOCENTS_PER_CENT);
    expect(wonderCapNanocents("1", overall)).toBe(NANOCENTS_PER_CENT);
    for (const bad of [undefined, "", "0", "-1", "12001", "30.00", " 3000", "abc"]) {
      expect(wonderCapNanocents(bad, overall), String(bad)).toBeNull();
    }
    // No overall cap means no Wonder cap either.
    expect(wonderCapNanocents("3000", null)).toBeNull();
    // Production's pair: Wonder's $150 inside the $400 ceiling.
    expect(wonderCapNanocents("15000", capNanocents("40000"))).toBe(15_000 * NANOCENTS_PER_CENT);
  });

  it("rounds displays up, never down", () => {
    expect(centsToDisplay(0)).toBe("0.0000");
    expect(centsToDisplay(1)).toBe("0.0001");
    expect(centsToDisplay(91_700_000)).toBe("0.0917");
    expect(centsToDisplay(91_700_001)).toBe("0.0918");
    expect(centsToDisplay(2 * NANOCENTS_PER_CENT)).toBe("2.0000");
    expect(dollarsToDisplay(0)).toBe("$0.00");
    expect(dollarsToDisplay(1)).toBe("$0.01");
    expect(dollarsToDisplay(12_000 * NANOCENTS_PER_CENT)).toBe("$120.00");
    expect(dollarsToDisplay(12_345 * NANOCENTS_PER_CENT + 1)).toBe("$123.46");
  });
});

describe("savedByCache", () => {
  it("is the cached tokens at the full input price less what they were billed, for every token price", () => {
    const priced: [string, string, string, number][] = [
      ["spark", "meta", "muse-spark-1.3", 110_000],
      ["spark", "meta", "muse-spark-1.3-contributor", 9_800],
      ["wonder", "meta", "muse-wonder-1.0", 380_000],
      ["spark_open", "baseten", "meta-models/muse-spark-open-1026", 110_000],
      ["spark_open", "fireworks", "accounts/fireworks/models/muse-spark-open", 110_000],
    ];
    for (const [target, provider, model, perToken] of priced) {
      const price = tokens(priceFor(target as never, provider as never, model));
      expect(savedByCache(price, 0), model).toBe(0);
      expect(savedByCache(price, 1_912), model).toBe(1_912 * perToken);
      expect(Number.isSafeInteger(savedByCache(price, 1_912)), model).toBe(true);
      // Never more than the input would have cost at the full price.
      expect(savedByCache(price, 2_480)).toBeLessThan(actualCost(price, { input: 2_480, cached: 0, output: 0, reasoning: 0 }));
    }
  });

  it("matches the drop in cost when the same input is read from the cache", () => {
    const price = tokens(priceFor("spark", "meta", "muse-spark-1.3"));
    const usage = { input: 2_480, cached: 0, output: 300, reasoning: 200 };
    const uncached = actualCost(price, usage);
    const cached = actualCost(price, { ...usage, cached: 1_912 });
    expect(uncached - cached).toBe(savedByCache(price, 1_912));
  });
});
