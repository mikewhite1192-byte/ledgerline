import { describe, expect, it } from "vitest";
import { imageBody, META_IMAGES_URL, parseImage } from "./meta-image";

const B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

describe("imageBody", () => {
  it("always asks for base64, never a URL", () => {
    expect(META_IMAGES_URL).toBe("https://api.meta.ai/v1/images/generations");
    expect(
      imageBody("muse-image-1.0", "a flatbed at dusk", {
        n: 2,
        size: "1024x768",
        outputFormat: "webp",
        reasoningStrength: "high",
      }),
    ).toEqual({
      model: "muse-image-1.0",
      prompt: "a flatbed at dusk",
      n: 2,
      size: "1024x768",
      response_format: "b64_json",
      output_format: "webp",
      reasoning_strength: "high",
    });
    expect(
      imageBody("muse-image-1.0", "x", {
        n: 1,
        size: null,
        outputFormat: "png",
        reasoningStrength: "low",
      }),
    ).not.toHaveProperty("size");
  });
});

describe("parseImage", () => {
  it("decodes each image with the answer's format and charges each one returned", () => {
    const outcome = parseImage("png", 2)(
      { created: 1, output_format: "jpeg", data: [{ b64_json: B64 }, { b64_json: B64 }] },
      200,
    );
    expect(outcome).toEqual({
      kind: "answered",
      status: "ok",
      httpStatus: 200,
      upstreamId: null,
      metered: { unit: "images", count: 2 },
      value: [
        { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/jpeg" },
        { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/jpeg" },
      ],
    });
  });

  it("charges what came back, not what was asked, and an undecodable entry still counts", () => {
    // Asked for four, got two, one of them a URL instead of base64.
    const outcome = parseImage("png", 4)(
      { data: [{ b64_json: B64 }, { url: "https://x.example/i.png" }] },
      200,
    );
    expect(outcome).toMatchObject({ metered: { unit: "images", count: 2 } });
    expect(outcome.kind === "answered" && outcome.value).toEqual([
      { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/png" },
    ]);
    // An unlisted format falls back to the one asked for.
    const odd = parseImage("webp", 1)({ output_format: "tiff", data: [{ b64_json: B64 }] }, 200);
    expect(odd.kind === "answered" && odd.value[0].mime).toBe("image/webp");
  });

  it("is unknown without a data array", () => {
    for (const json of [null, {}, { data: "x" }]) {
      expect(parseImage("png", 1)(json, 200)).toEqual({
        kind: "unknown",
        category: "unknown",
        httpStatus: 200,
      });
    }
  });

  it("is unknown, with no images handed back, when more came back than were asked for", () => {
    const three = { data: [{ b64_json: B64 }, { b64_json: B64 }, { b64_json: B64 }] };
    expect(parseImage("png", 2)(three, 200)).toEqual({
      kind: "unknown",
      category: "unknown",
      httpStatus: 200,
    });
    // As many as asked for is charged as usual.
    expect(parseImage("png", 3)(three, 200)).toMatchObject({
      kind: "answered",
      metered: { unit: "images", count: 3 },
    });
  });
});
