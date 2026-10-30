import { describe, expect, it } from "vitest";
import { editBody, imageBody, META_IMAGE_EDITS_URL, META_IMAGES_URL, parseImage, parseImageEdit } from "./meta-image";

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

describe("editBody", () => {
  it("sends the picture inline as a data URL and asks for one image back as base64", () => {
    expect(META_IMAGE_EDITS_URL).toBe("https://api.meta.ai/v1/images/edits");
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(editBody("muse-image-1.0", "Circle the total.", { mime: "image/jpeg", bytes })).toEqual({
      model: "muse-image-1.0",
      prompt: "Circle the total.",
      images: [{ image_url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` }],
      n: 1,
      response_format: "b64_json",
    });
  });
});

describe("parseImageEdit", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

  it("reads the type from the bytes and charges the one image", () => {
    for (const [bytes, mime] of [
      [PNG, "image/png"],
      [WEBP, "image/webp"],
    ] as const) {
      expect(parseImageEdit({ created: 1, data: [{ b64_json: b64(bytes) }] }, 200)).toEqual({
        kind: "answered",
        status: "ok",
        httpStatus: 200,
        upstreamId: null,
        metered: { unit: "images", count: 1 },
        value: [{ bytes, mime }],
      });
    }
  });

  it("still charges an entry that is not a picture or not base64, and hands back nothing for it", () => {
    for (const entry of [{ b64_json: b64(new Uint8Array([1, 2, 3, 4])) }, { url: "https://x.example/i.png" }]) {
      const outcome = parseImageEdit({ data: [entry] }, 200);
      expect(outcome).toMatchObject({ kind: "answered", metered: { unit: "images", count: 1 }, value: [] });
    }
  });

  it("is unknown without a data array or with more than one image", () => {
    for (const json of [null, {}, { data: "x" }, { data: [{ b64_json: b64(PNG) }, { b64_json: b64(PNG) }] }]) {
      expect(parseImageEdit(json, 200)).toEqual({ kind: "unknown", category: "unknown", httpStatus: 200 });
    }
  });
});
