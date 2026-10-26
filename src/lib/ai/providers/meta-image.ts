import type { CallOutcome, ImageResult } from "../types";
import { asArray, asRecord } from "./http";
import { fromBase64 } from "./media";

// Muse Image (https://dev.meta.ai/docs/image-generation,
// https://dev.meta.ai/docs/api-reference/images/schemas). Always base64 in the answer, never a
// URL that expires or can be passed on. Billed per image returned.
export const META_IMAGES_URL = "https://api.meta.ai/v1/images/generations";

export type ImageFormat = "png" | "jpeg" | "webp";

export type ImageOptions = {
  n: number;
  size: string | null;
  outputFormat: ImageFormat;
  reasoningStrength: "low" | "high";
};

const MIMES: Record<ImageFormat, ImageResult["images"][number]["mime"]> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function imageBody(model: string, prompt: string, options: ImageOptions) {
  return {
    model,
    prompt,
    n: options.n,
    ...(options.size ? { size: options.size } : {}),
    response_format: "b64_json",
    output_format: options.outputFormat,
    reasoning_strength: options.reasoningStrength,
  };
}

// A 200 answer. Every entry in data is a returned image and is charged, so the count is
// data.length even when an entry cannot be decoded (that one is left out of the result). No
// data array means the charge is not known: unknown, its reservation kept. More entries than
// the n asked for would charge more than was reserved, so that answer is unknown too, its
// reservation kept and none of its images handed back.
export function parseImage(
  requested: ImageFormat,
  n: number,
): (json: unknown, httpStatus: number) => CallOutcome<ImageResult["images"]> {
  return (json, httpStatus) => {
    const body = asRecord(json);
    if (!body || !Array.isArray(body.data) || body.data.length > n) {
      return { kind: "unknown", category: "unknown", httpStatus };
    }
    const format =
      typeof body.output_format === "string" && Object.hasOwn(MIMES, body.output_format)
        ? (body.output_format as ImageFormat)
        : requested;
    const images: ImageResult["images"] = [];
    for (const raw of asArray(body.data)) {
      const bytes = fromBase64(asRecord(raw)?.b64_json);
      if (bytes) images.push({ bytes, mime: MIMES[format] });
    }
    return {
      kind: "answered",
      status: "ok",
      httpStatus,
      upstreamId: null,
      metered: { unit: "images", count: body.data.length },
      value: images,
    };
  };
}
