import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type SegmentMatch, type SegmentResult } from "../ai";
import { FALLBACKS } from "../ai/targets";
import type { Session } from "../auth/claims";
import {
  CROP_MAX_BYTES,
  CROP_MAX_COST_CENTS,
  CROP_PROMPT,
  CROP_TIMEOUT_MS,
  base85Length,
  boxQuad,
  chooseMatch,
  cornersOf,
  cropDocument,
  decodeBase85,
  decodeMask,
  homography,
  maskOrigin,
  maskQuad,
  outputSize,
  project,
  quadUsable,
  warp,
  type CropDeps,
  type Raster,
} from "./crop";
import type { CropPoint } from "./types";

// The crop with no network: images drawn here, a fake segment call that counts its calls, and
// masks written by this file's own encoder (RFC 1924 base85, a byte's highest bit first), so a
// wrong guess about the real answer's format shows up as a box crop, never a wrong one.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const TRACE = "44444444-4444-4444-8444-444444444444";
const CALL = "55555555-5555-4555-8555-555555555555";
const saved = flags.documentCrop;

const B85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

// Python's b85encode, unpadded: four bytes to five characters, a short last group one more
// character than its bytes.
function encodeBase85(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = bytes.subarray(i, i + 4);
    const padded = new Uint8Array(4);
    padded.set(chunk);
    let value = padded[0] * 0x1000000 + padded[1] * 0x10000 + padded[2] * 0x100 + padded[3];
    let group = "";
    for (let k = 0; k < 5; k++) {
      group = B85[value % 85] + group;
      value = Math.floor(value / 85);
    }
    out += group.slice(0, chunk.length + 1);
  }
  return out;
}

function packBits(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

function oneBit(bits: Uint8Array, width: number, height: number, x = 0, y = 0): NonNullable<SegmentMatch["mask"]> {
  return { x, y, width, height, encoding: "one_bit", payload: encodeBase85(packBits(bits)) };
}

// Pixels whose centers lie inside the convex polygon (corners clockwise on screen).
function polygonBits(poly: CropPoint[], width: number, height: number): Uint8Array {
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let inside = true;
      for (let i = 0; i < poly.length && inside; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        inside = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x) >= 0;
      }
      bits[y * width + x] = inside ? 1 : 0;
    }
  }
  return bits;
}

const rectBits = (width: number, height: number) => new Uint8Array(width * height).fill(1);

// A gray canvas with the set bits drawn white, as a PNG made with sharp.
async function canvas(bits: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const raw = new Uint8Array(width * height * 3);
  for (let i = 0; i < bits.length; i++) raw.fill(bits[i] ? 255 : 96, i * 3, i * 3 + 3);
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer());
}

async function gray(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } } }).png().toBuffer(),
  );
}

// Seeded noise: nothing compresses it, so an encoded crop of it is large.
async function noise(width: number, height: number): Promise<Uint8Array> {
  const raw = new Uint8Array(width * height * 3);
  let s = 12345;
  for (let i = 0; i < raw.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    raw[i] = s >>> 24;
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer());
}

function answer(matches: SegmentMatch[], width: number | null, height: number | null): SegmentResult {
  return { callId: CALL, imageWidth: width, imageHeight: height, matches, costNanocents: 250_000_000 };
}

function fakeSegment(result: SegmentResult | Error) {
  return vi.fn<NonNullable<CropDeps["segment"]>>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

const input = (bytes: Uint8Array, mime: "image/png" | "image/jpeg" | "image/webp" = "image/png") => ({
  documentId: "d1",
  bytes,
  mime,
  traceId: TRACE,
});

const whiteShare = async (bytes: Uint8Array) => {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  let white = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] >= 200) white += 1;
  return { share: white / (info.width * info.height), width: info.width, height: info.height };
};

beforeEach(() => {
  flags.documentCrop = true;
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  flags.documentCrop = saved;
  vi.restoreAllMocks();
});

describe("homography and warp", () => {
  const rect = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 200 },
    { x: 0, y: 200 },
  ];
  const quad = [
    { x: 31.5, y: 12 },
    { x: 290, y: 40.25 },
    { x: 270, y: 250 },
    { x: 12, y: 199 },
  ];

  it("maps each corner of a known quad to the rectangle's within 0.01 px", () => {
    const h = homography(quad, rect);
    if (!h) throw new Error("no map");
    quad.forEach((p, i) => {
      const q = project(h, p);
      expect(Math.abs(q.x - rect[i].x)).toBeLessThan(0.01);
      expect(Math.abs(q.y - rect[i].y)).toBeLessThan(0.01);
    });
  });

  it("finds no map when three corners are in a line", () => {
    expect(homography([rect[0], { x: 150, y: 0 }, rect[1], rect[2]], rect)).toBeNull();
  });

  it("reproduces every pixel through the identity quad", () => {
    const width = 23;
    const height = 17;
    const data = new Uint8Array(width * height * 3).map((_, i) => (i * 37) % 256);
    const src: Raster = { data, width, height, channels: 3 };
    const out = warp(src, [rect[0], { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }], width, height);
    expect(out && Array.from(out.data)).toEqual(Array.from(data));
  });

  it("sizes the output from the mean edges, the longest side kept within 200 to 1,600", () => {
    expect(outputSize(rect)).toEqual({ width: 300, height: 200 });
    expect(outputSize(rect.map((p) => ({ x: p.x * 10, y: p.y * 10 })))).toEqual({ width: 1600, height: 1067 });
    expect(outputSize(rect.map((p) => ({ x: p.x / 3, y: p.y / 3 })))).toEqual({ width: 200, height: 133 });
  });
});

describe("the mask", () => {
  it("decodes base85 the way Python's b85encode writes it", () => {
    expect(Buffer.from(decodeBase85("Xk~0{Zv") ?? []).toString()).toBe("hello");
    expect(Array.from(decodeBase85("00000|NsC00R") ?? [])).toEqual([0, 0, 0, 0, 255, 255, 255, 255, 1]);
    expect(decodeBase85("")).toEqual(new Uint8Array(0));
    // A lone last character, one outside the alphabet, a group over 32 bits.
    expect(decodeBase85("000001")).toBeNull();
    expect(decodeBase85("00 00")).toBeNull();
    expect(decodeBase85("~~~~~")).toBeNull();
  });

  it("round-trips this file's encoder and refuses a payload of the wrong length", () => {
    const width = 13;
    const height = 7;
    const bits = new Uint8Array(width * height).map((_, i) => (i % 3 === 0 || i % 7 === 0 ? 1 : 0));
    const decoded = decodeMask(oneBit(bits, width, height));
    expect(decoded && Array.from(decoded.bits)).toEqual(Array.from(bits));
    expect(decoded?.set).toBe(bits.reduce((a, b) => a + b, 0));
    expect(decodeMask(oneBit(bits, width, height + 1))).toBeNull();
    expect(decodeMask({ ...oneBit(bits, width, height), payload: oneBit(bits, width, height).payload + "00000" })).toBeNull();
    expect(decodeMask({ ...oneBit(bits, width, height), encoding: "lossless" })).toBeNull();
    expect(decodeMask(oneBit(new Uint8Array(0), 0, 0))).toBeNull();
  });

  it("knows the one payload length each byte count encodes to, and refuses an oversized payload before decoding it", () => {
    for (let n = 0; n <= 41; n++) {
      const text = encodeBase85(new Uint8Array(n).fill(0x5a));
      expect(base85Length(n)).toBe(text.length);
      expect(decodeBase85(text)?.length).toBe(n);
    }
    const width = 13;
    const height = 7;
    const good = oneBit(rectBits(width, height), width, height);
    expect(good.payload.length).toBe(base85Length(Math.ceil((width * height) / 8)));
    expect(decodeMask(good)?.set).toBe(width * height);
    // A million characters where the shape needs fifteen, and one character short.
    expect(decodeMask({ ...good, payload: "0".repeat(1_000_000) })).toBeNull();
    expect(decodeMask({ ...good, payload: good.payload.slice(0, -1) })).toBeNull();
    // A payload that throws when any character is read: the decoder reads it, the length check
    // alone refuses it, so the oversized answer is never decoded.
    const untouchable = new Proxy(
      { length: 1_000_000 },
      {
        get(target, key) {
          if (key === "length") return target.length;
          throw new Error("payload read");
        },
      },
    ) as unknown as string;
    expect(() => decodeBase85(untouchable)).toThrow("payload read");
    expect(decodeMask({ ...good, payload: untouchable })).toBeNull();
  });

  it("places a mask only where it can tell: the whole frame, or the box at its corner or at 0, 0", () => {
    const frame = { width: 400, height: 300 };
    const box = { x1: 50, y1: 40, x2: 250, y2: 200 };
    expect(maskOrigin({ x: 0, y: 0, width: 400, height: 300 }, box, frame)).toEqual({ x: 0, y: 0 });
    expect(maskOrigin({ x: 0, y: 0, width: 200, height: 160 }, box, frame)).toEqual({ x: 50, y: 40 });
    expect(maskOrigin({ x: 0, y: 0, width: 201, height: 161 }, box, frame)).toEqual({ x: 50, y: 40 });
    expect(maskOrigin({ x: 50, y: 40, width: 200, height: 160 }, box, frame)).toEqual({ x: 50, y: 40 });
    expect(maskOrigin({ x: 10, y: 40, width: 200, height: 160 }, box, frame)).toBeNull();
    expect(maskOrigin({ x: 0, y: 0, width: 220, height: 160 }, box, frame)).toBeNull();
    expect(maskOrigin({ x: 5, y: 0, width: 400, height: 300 }, box, frame)).toBeNull();
  });

  it("finds a tilted raster's corners within a pixel", () => {
    const corners = [
      { x: 40, y: 30 },
      { x: 200, y: 50 },
      { x: 185, y: 170 },
      { x: 25, y: 150 },
    ];
    const found = cornersOf({ bits: polygonBits(corners, 240, 200), width: 240, height: 200 });
    if (!found) throw new Error("no corners");
    found.forEach((p, i) => {
      expect(Math.abs(p.x - corners[i].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y - corners[i].y)).toBeLessThanOrEqual(1);
    });
    expect(cornersOf({ bits: new Uint8Array(4), width: 2, height: 2 })).toBeNull();
  });

  it("takes only a sound quad: convex, square enough, large enough and the box's extent", () => {
    const box = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const square = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(quadUsable(square, box)).toBe(true);
    // Concave: the bottom right corner pulled inside.
    expect(quadUsable([square[0], square[1], { x: 30, y: 30 }, square[3]], box)).toBe(false);
    // Thin: 5% of the box.
    expect(quadUsable([square[0], square[1], { x: 100, y: 5 }, { x: 0, y: 5 }], box)).toBe(false);
    // A corner under 50 degrees (the bottom left pulled up to y = 15).
    expect(quadUsable([square[0], square[1], square[2], { x: 0, y: 15 }], box)).toBe(false);
    // A leaning page, every angle 68 to 112 degrees: still sound.
    expect(quadUsable([{ x: 40, y: 0 }, { x: 100, y: 0 }, { x: 60, y: 100 }, { x: 0, y: 100 }], box)).toBe(true);
    // Corners in the wrong order (counterclockwise on screen).
    expect(quadUsable([...square].reverse(), box)).toBe(false);
    // Sound, but nowhere near the box: a mask placed wrong.
    expect(quadUsable(square.map((p) => ({ x: p.x + 30, y: p.y })), box)).toBe(false);
  });

  it("uses the box when the mask is not a solid shape, whatever its corners say", () => {
    const frame = { width: 100, height: 100 };
    const box = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const checker = new Uint8Array(100 * 100).map((_, i) => ((i + Math.floor(i / 100)) % 2 === 0 ? 1 : 0));
    expect(maskQuad({ box, mask: oneBit(rectBits(100, 100), 100, 100) }, frame)).toHaveLength(4);
    expect(maskQuad({ box, mask: oneBit(checker, 100, 100) }, frame)).toBeNull();
    expect(maskQuad({ box, mask: null }, frame)).toBeNull();
  });
});

describe("choosing the match", () => {
  const frame = { width: 400, height: 300 };
  const match = (box: SegmentMatch["box"], confidence?: number): SegmentMatch => ({
    box,
    ...(confidence === undefined ? {} : { confidence }),
    mask: null,
  });

  it("takes the largest confident box, a box with no confidence included", () => {
    const small = match({ x1: 10, y1: 10, x2: 110, y2: 110 }, 0.9);
    const large = match({ x1: 50, y1: 40, x2: 350, y2: 260 });
    const unsure = match({ x1: 0, y1: 0, x2: 390, y2: 290 }, 0.2);
    expect(chooseMatch(answer([small, large, unsure], 400, 300), frame)).toEqual({ ok: true, match: large, confidence: null });
  });

  it("names each refusal", () => {
    const at = (m: SegmentMatch[], w: number | null = 400, h: number | null = 300) =>
      chooseMatch(answer(m, w, h), frame);
    expect(at([], null, null)).toMatchObject({ ok: false, category: "no_match" });
    expect(at([match({ x1: 50, y1: 40, x2: 350, y2: 260 }, 0.3)])).toMatchObject({
      ok: false,
      category: "low_confidence",
      confidence: 300,
    });
    expect(at([match({ x1: 10, y1: 10, x2: 40, y2: 40 }, 0.9)])).toMatchObject({ ok: false, category: "too_small" });
    expect(at([match({ x1: 0, y1: 0, x2: 400, y2: 300 }, 0.9)])).toMatchObject({ ok: false, category: "already_flat" });
    expect(at([match({ x1: 50, y1: 40, x2: 350, y2: 260 }, 0.9)], 800, 600)).toMatchObject({
      ok: false,
      category: "size_mismatch",
    });
    expect(at([match({ x1: 50, y1: 40, x2: 450, y2: 260 }, 0.9)])).toMatchObject({ ok: false, category: "size_mismatch" });
  });

  it("cuts out the box with a 2% margin, inside the frame", () => {
    expect(boxQuad({ x1: 100, y1: 50, x2: 300, y2: 250 }, frame)).toEqual([
      { x: 96, y: 46 },
      { x: 304, y: 46 },
      { x: 304, y: 254 },
      { x: 96, y: 254 },
    ]);
    expect(boxQuad({ x1: 2, y1: 1, x2: 398, y2: 299 }, frame)[2]).toEqual({ x: 400, y: 300 });
  });
});

describe("cropDocument", () => {
  const poly = [
    { x: 90, y: 60 },
    { x: 400, y: 40 },
    { x: 430, y: 320 },
    { x: 60, y: 300 },
  ];

  it("warps a tilted white page flat, after exactly one segment call with the bounds it needs", async () => {
    const bits = polygonBits(poly, 480, 360);
    const segment = fakeSegment(
      answer([{ box: { x1: 60, y1: 40, x2: 430, y2: 320 }, confidence: 0.91, mask: oneBit(bits, 480, 360) }], 480, 360),
    );
    const out = await cropDocument(input(await canvas(bits, 480, 360)), SESSION, { segment });
    expect(segment).toHaveBeenCalledTimes(1);
    const [request, session] = segment.mock.calls[0];
    expect(request).toMatchObject({
      prompt: CROP_PROMPT,
      maskEncoding: "one_bit",
      includeConfidence: true,
      purpose: "document_crop",
      maxCostCents: CROP_MAX_COST_CENTS,
      timeoutMs: CROP_TIMEOUT_MS,
      traceId: TRACE,
      image: { mime: "image/jpeg" },
    });
    expect(session).toBe(SESSION);
    if (out.status !== "cropped") throw new Error(`not cropped: ${JSON.stringify(out)}`);
    expect(out).toMatchObject({ method: "quad", mime: "image/jpeg", confidence: 910, callId: CALL });
    expect(out.box).toEqual({ x1: 60, y1: 40, x2: 430, y2: 320, width: 480, height: 360 });
    out.quad?.forEach((p, i) => {
      expect(Math.abs(p.x - poly[i].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y - poly[i].y)).toBeLessThanOrEqual(1);
    });
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
    const seen = await whiteShare(out.bytes);
    expect(Math.abs(seen.width - 341)).toBeLessThanOrEqual(2);
    expect(Math.abs(seen.height - 262)).toBeLessThanOrEqual(2);
    expect(seen.share).toBeGreaterThan(0.99);
  });

  it("sends the segmenter the photo upright, with no metadata, at most 2,000 px on a side", async () => {
    const turned = new Uint8Array(
      await sharp({ create: { width: 3000, height: 1200, channels: 3, background: { r: 90, g: 90, b: 90 } } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );
    const segment = fakeSegment(answer([], null, null));
    const out = await cropDocument(input(turned, "image/jpeg"), SESSION, { segment });
    expect(out).toEqual({ status: "skipped", category: "no_match", box: null, confidence: null, callId: CALL });
    const sent = await sharp(segment.mock.calls[0][0].image.bytes).metadata();
    expect({ width: sent.width, height: sent.height, format: sent.format }).toEqual({
      width: 800,
      height: 2000,
      format: "jpeg",
    });
    expect(sent.orientation).toBeUndefined();
    expect(sent.exif).toBeUndefined();
  });

  it("cuts out the box when the mask is missing, misplaced or not a quad", async () => {
    const bits = polygonBits(poly, 480, 360);
    const image = await canvas(bits, 480, 360);
    const box = { x1: 60, y1: 40, x2: 430, y2: 320 };
    // An L shape: its corners make no sound quad.
    const ell = new Uint8Array(480 * 360).map((_, i) => {
      const x = i % 480;
      const y = Math.floor(i / 480);
      return x >= 60 && x < 430 && y >= 40 && y < 320 && (x < 160 || y >= 220) ? 1 : 0;
    });
    for (const mask of [null, oneBit(bits, 480, 360, 7, 0), oneBit(ell, 480, 360)]) {
      const segment = fakeSegment(answer([{ box, confidence: 0.8, mask }], 480, 360));
      const out = await cropDocument(input(image), SESSION, { segment });
      expect(segment).toHaveBeenCalledTimes(1);
      expect(out).toMatchObject({ status: "cropped", method: "box", quad: null, confidence: 800 });
      if (out.status !== "cropped") continue;
      const seen = await sharp(out.bytes).metadata();
      // The box, 370 x 280, plus a 2% margin each side.
      expect({ width: seen.width, height: seen.height }).toEqual({ width: 386, height: 292 });
    }
  });

  it.each([
    ["no_match", answer([], null, null)],
    ["low_confidence", answer([{ box: { x1: 50, y1: 40, x2: 350, y2: 260 }, confidence: 0.3, mask: null }], 400, 300)],
    ["too_small", answer([{ box: { x1: 10, y1: 10, x2: 40, y2: 40 }, confidence: 0.9, mask: null }], 400, 300)],
    ["already_flat", answer([{ box: { x1: 0, y1: 0, x2: 400, y2: 300 }, confidence: 0.9, mask: null }], 400, 300)],
    ["size_mismatch", answer([{ box: { x1: 50, y1: 40, x2: 350, y2: 260 }, confidence: 0.9, mask: null }], 300, 400)],
  ] as const)("skips with %s after exactly one call", async (category, result) => {
    const segment = fakeSegment(result);
    const out = await cropDocument(input(await gray(400, 300)), SESSION, { segment });
    expect(segment).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ status: "skipped", category, callId: CALL });
  });

  // [stored category, the error, its name in the log, whether the try is given back]
  it.each([
    ["timeout", new AiError("timeout"), "timeout", false],
    ["unavailable", new AiError("unavailable", 503), "unavailable", false],
    ["network", new AiError("network"), "network", false],
    ["rate_limited", new AiError("rate_limited", 429), "rate_limited", false],
    ["budget", new AiError("billing", 402), "billing", false],
    ["budget", new AiError("cap"), "cap", true],
    ["budget", new AiError("job_cap"), "job_cap", true],
    ["budget", new AiError("too_expensive"), "too_expensive", true],
    ["unknown", new AiError("disabled"), "disabled", true],
    ["unknown", new AiError("not_configured"), "not_configured", true],
    ["unknown", new AiError("bad_request"), "bad_request", false],
    ["unknown", new AiError("unknown"), "unknown", false],
    ["unknown", new Error("boom"), "Error", false],
  ] as const)("has no answer (%s from %s) when the call fails, after exactly one call", async (category, err, name, refund) => {
    const segment = fakeSegment(err);
    const out = await cropDocument(input(await gray(400, 300)), SESSION, { segment });
    expect(segment).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: "unavailable", category, refund });
    // The stored word as category=, the error's name as error=, never its text.
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(`documents: crop d1 failed category=${category} error=${name}`);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("boom");
  });

  it("gives a try back only for refusals no request can follow: the segment target has no standby host", () => {
    expect(FALLBACKS.sam).toBeUndefined();
  });

  it("skips a crop over the size cap after exactly one call", { timeout: 60_000 }, async () => {
    const segment = fakeSegment(answer([{ box: { x1: 20, y1: 20, x2: 1680, y2: 1680 }, confidence: 0.9, mask: null }], 1700, 1700));
    const out = await cropDocument(input(await noise(1700, 1700), "image/jpeg"), SESSION, { segment });
    expect(segment).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ status: "skipped", category: "too_large", callId: CALL });
    expect(CROP_MAX_BYTES).toBe(700_000);
  });

  it("skips a file it cannot decode without any call", async () => {
    const segment = fakeSegment(answer([], null, null));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3, 4]);
    expect(await cropDocument(input(png), SESSION, { segment })).toEqual({
      status: "skipped",
      category: "bad_image",
      box: null,
      confidence: null,
      callId: null,
    });
    expect(segment).not.toHaveBeenCalled();
  });

  it("makes no call while the switch is off", async () => {
    flags.documentCrop = false;
    const segment = fakeSegment(answer([], null, null));
    expect(await cropDocument(input(await gray(400, 300)), SESSION, { segment })).toEqual({ status: "off" });
    expect(segment).not.toHaveBeenCalled();
  });
});
