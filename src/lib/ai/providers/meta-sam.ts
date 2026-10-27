import type { AiImageMime, CallOutcome, SegmentMatch } from "../types";
import { asArray, asRecord, upstreamIdFrom } from "./http";
import { dataUrl } from "./media";

// SAM 3.1 segmentation of a still and tracking through a video, both through the Responses
// endpoint (https://dev.meta.ai/docs/media-segmentation, https://dev.meta.ai/docs/sam/segmenting,
// https://dev.meta.ai/docs/sam/reading-segmentation). A still is billed per image, matched or not;
// a video per frame processed, at least 50 a request.
export { META_RESPONSES_URL as META_SAM_URL } from "./meta";

export type SamOptions = { maskEncoding: "lossless" | "one_bit"; includeConfidence: boolean };

export type SamVideoOptions = SamOptions & { propagation: "both" | "forward" | "backward" };

export type SamAnswer = {
  imageWidth: number | null;
  imageHeight: number | null;
  matches: SegmentMatch[];
};

export function samBody(
  model: string,
  image: { mime: AiImageMime; bytes: Uint8Array },
  prompt: string,
  options: SamOptions,
) {
  return {
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: dataUrl(image.mime, image.bytes) },
        ],
      },
    ],
    // Metadata values are strings.
    metadata: {
      mask_encoding: options.maskEncoding,
      ...(options.includeConfidence ? { include_confidence: "true" } : {}),
    },
    store: false,
  };
}

// One token's fields, read by key, never by position, as the docs say. Null when a field repeats.
function fields(body: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const pair of body.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    const key = pair.slice(0, eq);
    if (out.has(key)) return null;
    out.set(key, pair.slice(eq + 1));
  }
  return out;
}

const count = (v: string | undefined): number | null =>
  v !== undefined && /^\d{1,6}$/.test(v) ? Number(v) : null;
const coordinate = (v: string | undefined): number | null =>
  v !== undefined && /^-?\d{1,6}(\.\d+)?$/.test(v) ? Number(v) : null;

type Box = { box: SegmentMatch["box"]; width: number; height: number; confidence?: number };

function readBox(body: string): Box | null {
  const f = fields(body);
  if (!f) return null;
  const x1 = coordinate(f.get("x1"));
  const y1 = coordinate(f.get("y1"));
  const x2 = coordinate(f.get("x2"));
  const y2 = coordinate(f.get("y2"));
  const width = count(f.get("w"));
  const height = count(f.get("h"));
  if (x1 === null || y1 === null || x2 === null || y2 === null || !width || !height) return null;
  const c = f.get("c");
  let confidence: number | undefined;
  if (c !== undefined) {
    confidence = Number(c);
    if (!/^\d(\.\d+)?$/.test(c) || confidence > 1) return null;
  }
  return {
    box: { x1, y1, x2, y2 },
    width,
    height,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

// `x=..;y=..;data=H,W,<marker><payload>`. The payload is base85 and may hold any of its
// characters, ";" and "=" included, so everything after "data=" is the data field.
function readMask(body: string): SegmentMatch["mask"] {
  const at = body.indexOf(";data=");
  if (at < 0) return null;
  const f = fields(body.slice(0, at));
  const data = body.slice(at + ";data=".length);
  const shape = /^(\d{1,6}),(\d{1,6}),([~!])(.+)$/s.exec(data);
  const x = count(f?.get("x"));
  const y = count(f?.get("y"));
  if (!f || !shape || x === null || y === null) return null;
  return {
    x,
    y,
    height: Number(shape[1]),
    width: Number(shape[2]),
    encoding: shape[3] === "~" ? "lossless" : "one_bit",
    payload: shape[4],
  };
}

// Each record is a box token and the mask token after it. A token runs from its opening "<|box;"
// or "<|mask;" to the next token, frame marker or line end, less its closing "|>" and any record
// number after it. Null when the text does not follow that grammar.
export function parseSegmentation(text: string): SamAnswer | null {
  const matches: SegmentMatch[] = [];
  let size: { width: number; height: number } | null = null;
  const starts = /<\|(box|mask);/g;
  const found = [...text.matchAll(starts)];
  // Anything but frame markers, record numbers and whitespace outside the tokens is not ours.
  const outside = text
    .split(/<\|(?:box|mask);/)[0]
    .replace(/<\d+f>/g, "")
    .replace(/\d+/g, "")
    .trim();
  if (outside !== "") return null;
  for (let i = 0; i < found.length; i++) {
    const kind = found[i][1];
    const start = (found[i].index ?? 0) + found[i][0].length;
    const end = i + 1 < found.length ? (found[i + 1].index ?? text.length) : text.length;
    const raw = text.slice(start, end);
    const close = /\|>(?:\s|<\d+f>|\d)*$/.exec(raw);
    if (!close) return null;
    const body = raw.slice(0, close.index);
    if (kind === "box") {
      const box = readBox(body);
      if (!box) return null;
      if (size && (size.width !== box.width || size.height !== box.height)) return null;
      size = { width: box.width, height: box.height };
      matches.push({
        box: box.box,
        ...(box.confidence !== undefined ? { confidence: box.confidence } : {}),
        mask: null,
      });
    } else {
      const last = matches.at(-1);
      // A mask belongs to the box just before it, one each.
      if (!last || last.mask !== null) return null;
      const mask = readMask(body);
      if (!mask) return null;
      last.mask = mask;
    }
  }
  return { imageWidth: size?.width ?? null, imageHeight: size?.height ?? null, matches };
}

// The answer's text: every output_text part of every message, in order.
function outputText(body: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const raw of asArray(body.output)) {
    const item = asRecord(raw);
    if (item?.type !== "message") continue;
    for (const part of asArray(item.content)) {
      const p = asRecord(part);
      if (p?.type === "output_text" && typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("");
}

// A 200 answer. The image is charged whether or not anything matched, so the cost is known as
// soon as the answer is complete; an answer that is not complete or not readable is unknown, its
// reservation (equal to the price) kept.
export function parseSam(json: unknown, httpStatus: number): CallOutcome<SamAnswer> {
  const body = asRecord(json);
  if (!body || body.status !== "completed") {
    return { kind: "unknown", category: "unknown", httpStatus };
  }
  const answer = parseSegmentation(outputText(body));
  if (!answer) return { kind: "unknown", category: "unknown", httpStatus };
  return {
    kind: "answered",
    status: "ok",
    httpStatus,
    upstreamId: upstreamIdFrom(body.id),
    metered: { unit: "images", count: 1 },
    value: answer,
  };
}

export function samVideoBody(
  model: string,
  video: { bytes: Uint8Array },
  prompt: string,
  options: SamVideoOptions,
) {
  return {
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_video", video_url: dataUrl("video/mp4", video.bytes) },
        ],
      },
    ],
    metadata: {
      mask_encoding: options.maskEncoding,
      ...(options.includeConfidence ? { include_confidence: "true" } : {}),
      propagation_direction: options.propagation,
    },
    store: false,
  };
}

export type SamVideoAnswer = {
  frames: Map<number, SegmentMatch[]>;
  width: number | null;
  height: number | null;
  framesProcessed: number;
};

// A video answer is one line per frame: a frame marker `<Nf>`, then that frame's records, each
// a record number, a box token and its mask token. Every record in every frame has the one size.
// Null when the text does not follow that grammar, a frame repeats, or a frame number is past
// lastFrame.
export function parseSegmentationFrames(
  text: string,
  lastFrame: number,
): Omit<SamVideoAnswer, "framesProcessed"> | null {
  const parts = text.split(/<(\d{1,6})f>/);
  if (parts[0].trim() !== "") return null;
  const frames = new Map<number, SegmentMatch[]>();
  const seen = new Set<number>();
  let size: { width: number; height: number } | null = null;
  for (let i = 1; i < parts.length; i += 2) {
    const index = Number(parts[i]);
    if (index > lastFrame || seen.has(index)) return null;
    seen.add(index);
    const answer = parseSegmentation(parts[i + 1]);
    if (!answer) return null;
    if (answer.matches.length === 0) continue;
    const here = { width: answer.imageWidth ?? 0, height: answer.imageHeight ?? 0 };
    if (size && (size.width !== here.width || size.height !== here.height)) return null;
    size = here;
    frames.set(index, answer.matches);
  }
  return { frames, width: size?.width ?? null, height: size?.height ?? null };
}

// A 200 video answer. The cost is the frames the provider says it processed, so an answer that
// does not report them as a positive whole number is unknown, its reservation kept, like one
// that is not complete or does not parse.
export function parseSamVideo(
  lastFrame: number,
): (json: unknown, httpStatus: number) => CallOutcome<SamVideoAnswer> {
  return (json, httpStatus) => {
    const body = asRecord(json);
    const processed = asRecord(body?.usage)?.video_frames_processed;
    if (
      !body ||
      body.status !== "completed" ||
      typeof processed !== "number" ||
      !Number.isSafeInteger(processed) ||
      processed < 1
    ) {
      return { kind: "unknown", category: "unknown", httpStatus };
    }
    const answer = parseSegmentationFrames(outputText(body), lastFrame);
    if (!answer) return { kind: "unknown", category: "unknown", httpStatus };
    return {
      kind: "answered",
      status: "ok",
      httpStatus,
      upstreamId: upstreamIdFrom(body.id),
      metered: { unit: "video_frames", count: processed },
      value: { ...answer, framesProcessed: processed },
    };
  };
}
