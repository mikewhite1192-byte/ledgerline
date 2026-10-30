import { createHash } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, segment, type AiDeps, type SegmentMatch, type SegmentResult } from "../ai";
import type { Session } from "../auth/claims";
import type { CropBox, CropMethod, CropPoint, CropSkippedCategory, CropUnavailableCategory } from "./types";

// The crop before a photo is read: one SAM 3.1 call finds the paper in the photo, and the server
// draws it flat. Steps: normalize the photo (EXIF orientation applied, metadata gone, longest side
// at most 2,000 px, JPEG), which is the raster the segmenter sees, so its coordinates are ours;
// one segment call; choose the largest confident box; take the mask's four corners when the mask
// decodes, sits where the box says and makes a sound quad, else the box with a small margin; warp
// that quad to a rectangle; encode JPEG. Every doubt is a category and the read uses the raw
// photo; nothing here throws. The answer's mask format is UNVERIFIED (docs/design-sam-crop.md U1 to
// U6), so each guess about it is checked against the box, and a failed check means the box.

export const CROP_PROMPT = "paper document";
export const CROP_MIN_CONFIDENCE = 0.5;
// The wrapper's smallest bound; one image costs 0.25 cents, matched or not.
export const CROP_MAX_COST_CENTS = 1;
export const CROP_TIMEOUT_MS = 15_000;
// The same cap as an upload (0013), which crop_length checks.
export const CROP_MAX_BYTES = 700_000;

const FRAME_MAX_SIDE = 2_000;
const INPUT_MAX_PIXELS = 25_000_000;
const OUT_MAX_SIDE = 1_600;
const OUT_MIN_SIDE = 200;
const BOX_MIN_SHARE = 0.05;
const BOX_MAX_SHARE = 0.97;
const QUAD_MIN_AREA_SHARE = 0.6;
const ANGLE_MIN = 50;
const ANGLE_MAX = 130;
const BOX_MARGIN = 0.02;
// A quad's set pixels over its area: a mask decoded wrong is noise, about half set.
const FILL_MIN = 0.85;
const FILL_MAX = 1.15;

type Sharp = typeof import("sharp").default;

export type CropImageMime = "image/jpeg" | "image/png" | "image/webp";

export type CropDeps = { segment?: typeof segment; ai?: AiDeps };

export type CropInput = { documentId: string; bytes: Uint8Array; mime: CropImageMime; traceId: string };

export type CropOutcome =
  | { status: "off" }
  | {
      status: "cropped";
      bytes: Uint8Array;
      mime: "image/jpeg";
      hash: string;
      method: CropMethod;
      quad: CropPoint[] | null;
      box: CropBox;
      confidence: number | null;
      callId: string;
    }
  | {
      status: "skipped";
      category: CropSkippedCategory;
      box: CropBox | null;
      confidence: number | null;
      callId: string | null;
    }
  | { status: "unavailable"; category: CropUnavailableCategory };

export type Raster = { data: Uint8Array; width: number; height: number; channels: 1 | 2 | 3 | 4 };

type Frame = { jpeg: Uint8Array; raster: Raster };
type SamBox = SegmentMatch["box"];

// --- The geometry, pure ---

// The projective map (eight numbers; the ninth is 1) taking each point of `from` to the point of
// `to` at the same index: an 8 x 8 linear system, Gauss-Jordan with partial pivoting. Null when
// no such map exists (three points in a line).
export function homography(from: CropPoint[], to: CropPoint[]): number[] | null {
  if (from.length !== 4 || to.length !== 4) return null;
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = from[i];
    const { x, y } = to[i];
    m.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    m.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col || m[r][col] === 0) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 9; c++) m[r][c] -= f * m[col][c];
    }
  }
  const h = m.map((row, i) => row[8] / row[i]);
  return h.every(Number.isFinite) ? h : null;
}

export function project(h: number[], p: CropPoint): CropPoint {
  const w = h[6] * p.x + h[7] * p.y + 1;
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

// The quad (in pixel edges: pixel (c, r) covers c to c + 1 and r to r + 1, corners in the order
// top left, top right, bottom right, bottom left) drawn flat into width x height. Each output
// pixel's center maps back to a source point, sampled bilinearly between the four nearest pixel
// centers and clamped at the image's edge. Null when the map does not exist or folds.
export function warp(src: Raster, quad: CropPoint[], width: number, height: number): Raster | null {
  const rect = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const h = homography(rect, quad);
  if (!h) return null;
  // The denominator is affine in the output point, so positive at the four corners is positive
  // everywhere between them.
  if (!rect.every((p) => h[6] * p.x + h[7] * p.y + 1 > 0)) return null;
  const { data, channels: ch } = src;
  const sw = src.width;
  const maxX = src.width - 1;
  const maxY = src.height - 1;
  const out = new Uint8Array(width * height * ch);
  for (let v = 0; v < height; v++) {
    const cv = v + 0.5;
    for (let u = 0; u < width; u++) {
      const cu = u + 0.5;
      const w = h[6] * cu + h[7] * cv + 1;
      let sx = (h[0] * cu + h[1] * cv + h[2]) / w - 0.5;
      let sy = (h[3] * cu + h[4] * cv + h[5]) / w - 0.5;
      sx = sx > 0 ? (sx < maxX ? sx : maxX) : 0;
      sy = sy > 0 ? (sy < maxY ? sy : maxY) : 0;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * ch;
      const i10 = (y0 * sw + x1) * ch;
      const i01 = (y1 * sw + x0) * ch;
      const i11 = (y1 * sw + x1) * ch;
      const o = (v * width + u) * ch;
      for (let c = 0; c < ch; c++) {
        const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
        const bottom = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
        out[o + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { data: out, width, height, channels: ch };
}

const distance = (a: CropPoint, b: CropPoint) => Math.hypot(a.x - b.x, a.y - b.y);

function area(quad: CropPoint[]): number {
  let twice = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

// Width is the mean of the top and bottom edges, height the mean of the sides; the longest side
// is scaled into 200 to 1,600 px.
export function outputSize(quad: CropPoint[]): { width: number; height: number } {
  const w = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2;
  const h = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
  const longest = Math.max(w, h);
  const scale = longest > OUT_MAX_SIDE ? OUT_MAX_SIDE / longest : longest < OUT_MIN_SIDE ? OUT_MIN_SIDE / longest : 1;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

// A quad the warp may use: corners top left, top right, bottom right, bottom left, turning the
// same way at each (strictly convex), every angle 50 to 130 degrees, an area at least 60% of the
// box's, and an extent that matches the box within 5% (at least 4 px) on every side, so a mask
// placed wrong is never warped.
export function quadUsable(quad: CropPoint[], box: SamBox): boolean {
  if (quad.length !== 4 || !quad.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
  for (let i = 0; i < 4; i++) {
    const prev = quad[(i + 3) % 4];
    const p = quad[i];
    const next = quad[(i + 1) % 4];
    const turn = (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x);
    if (!(turn > 0)) return false;
    const ax = prev.x - p.x;
    const ay = prev.y - p.y;
    const bx = next.x - p.x;
    const by = next.y - p.y;
    const angle = (Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) * 180) / Math.PI;
    if (angle < ANGLE_MIN || angle > ANGLE_MAX) return false;
  }
  const bw = box.x2 - box.x1;
  const bh = box.y2 - box.y1;
  if (!(area(quad) >= QUAD_MIN_AREA_SHARE * bw * bh)) return false;
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const tolX = Math.max(4, 0.05 * bw);
  const tolY = Math.max(4, 0.05 * bh);
  return (
    Math.abs(Math.min(...xs) - box.x1) <= tolX &&
    Math.abs(Math.max(...xs) - box.x2) <= tolX &&
    Math.abs(Math.min(...ys) - box.y1) <= tolY &&
    Math.abs(Math.max(...ys) - box.y2) <= tolY
  );
}

// --- The mask (UNVERIFIED U1 and U2) ---

const B85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
const B85_VALUE = new Map([...B85].map((ch, i) => [ch, i]));

// Base85 in the RFC 1924 alphabet (Python's b85encode): five characters are four bytes, big
// endian; a last group of 2 to 4 characters is one byte fewer, read as if padded with the last
// character. Null on a character outside the alphabet, a lone last character or a group over
// 32 bits.
export function decodeBase85(text: string): Uint8Array | null {
  const tail = text.length % 5;
  if (tail === 1) return null;
  const padded = tail === 0 ? text : text + "~".repeat(5 - tail);
  const out = new Uint8Array((padded.length / 5) * 4);
  for (let g = 0; g < padded.length; g += 5) {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const digit = B85_VALUE.get(padded[g + i]);
      if (digit === undefined) return null;
      value = value * 85 + digit;
    }
    if (value > 0xffffffff) return null;
    const at = (g / 5) * 4;
    out[at] = Math.floor(value / 0x1000000) & 0xff;
    out[at + 1] = (value >>> 16) & 0xff;
    out[at + 2] = (value >>> 8) & 0xff;
    out[at + 3] = value & 0xff;
  }
  return tail === 0 ? out : out.subarray(0, out.length - (5 - tail));
}

export type MaskBits = { bits: Uint8Array; width: number; height: number; set: number };

// A one_bit mask: height x width bits row by row, a byte's highest bit first, one byte per pixel
// here (0 or 1). Null for the lossless encoding (not decoded), a shape larger than any frame, or
// a payload that does not decode to exactly the bytes the shape needs.
export function decodeMask(mask: NonNullable<SegmentMatch["mask"]>): MaskBits | null {
  const { width, height } = mask;
  if (mask.encoding !== "one_bit") return null;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null;
  if (width > FRAME_MAX_SIDE + 1 || height > FRAME_MAX_SIDE + 1) return null;
  const packed = decodeBase85(mask.payload);
  if (!packed || packed.length !== Math.ceil((width * height) / 8)) return null;
  const bits = new Uint8Array(width * height);
  let set = 0;
  for (let i = 0; i < bits.length; i++) {
    const bit = (packed[i >> 3] >> (7 - (i & 7))) & 1;
    bits[i] = bit;
    set += bit;
  }
  return { bits, width, height, set };
}

// Where the mask's pixel (0, 0) sits in the frame. A mask the frame's size at 0, 0 covers the
// frame. A mask the box's size (its far edges read either way, exclusive or inclusive) sits at the
// box's corner, whether x and y give that corner or 0, 0 (the documented example's box-sized mask
// at 0, 0). Anything else is ambiguous: null, and the crop uses the box.
export function maskOrigin(
  mask: { x: number; y: number; width: number; height: number },
  box: SamBox,
  frame: { width: number; height: number },
): CropPoint | null {
  if (mask.x === 0 && mask.y === 0 && mask.width === frame.width && mask.height === frame.height) {
    return { x: 0, y: 0 };
  }
  const bw = box.x2 - box.x1;
  const bh = box.y2 - box.y1;
  const boxSized = (mask.width === bw || mask.width === bw + 1) && (mask.height === bh || mask.height === bh + 1);
  if (!boxSized || !Number.isInteger(box.x1) || !Number.isInteger(box.y1)) return null;
  if ((mask.x === 0 && mask.y === 0) || (mask.x === box.x1 && mask.y === box.y1)) return { x: box.x1, y: box.y1 };
  return null;
}

// The set pixels with the least x + y, the greatest x - y, the greatest x + y and the least
// x - y: top left, top right, bottom right, bottom left, each at its pixel's outer corner. Null
// when nothing is set.
export function cornersOf(m: { bits: Uint8Array; width: number; height: number }): CropPoint[] | null {
  let tl: CropPoint | null = null;
  let tr: CropPoint | null = null;
  let br: CropPoint | null = null;
  let bl: CropPoint | null = null;
  for (let y = 0; y < m.height; y++) {
    const row = y * m.width;
    for (let x = 0; x < m.width; x++) {
      if (m.bits[row + x] !== 1) continue;
      if (!tl || x + y < tl.x + tl.y) tl = { x, y };
      if (!tr || x - y > tr.x - tr.y) tr = { x, y };
      if (!br || x + y > br.x + br.y) br = { x, y };
      if (!bl || x - y < bl.x - bl.y) bl = { x, y };
    }
  }
  if (!tl || !tr || !br || !bl) return null;
  return [
    { x: tl.x, y: tl.y },
    { x: tr.x + 1, y: tr.y },
    { x: br.x + 1, y: br.y + 1 },
    { x: bl.x, y: bl.y + 1 },
  ];
}

// The paper's four corners in the frame from the match's mask, or null (no mask, a mask that
// does not decode or place, a quad that is not sound, or a fill that says the bits are not a
// solid shape): the caller then cuts out the box.
export function maskQuad(match: SegmentMatch, frame: { width: number; height: number }): CropPoint[] | null {
  if (!match.mask) return null;
  const origin = maskOrigin(match.mask, match.box, frame);
  if (!origin) return null;
  const decoded = decodeMask(match.mask);
  if (!decoded) return null;
  const corners = cornersOf(decoded);
  if (!corners) return null;
  const quad = corners.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y }));
  if (!quadUsable(quad, match.box)) return null;
  const fill = decoded.set / area(quad);
  return fill >= FILL_MIN && fill <= FILL_MAX ? quad : null;
}

// --- Choosing the match ---

export type Choice =
  | { ok: true; match: SegmentMatch; confidence: number | null }
  | { ok: false; category: CropSkippedCategory; match: SegmentMatch | null; confidence: number | null };

const perMille = (c: number | undefined) => (c === undefined ? null : Math.round(Math.min(1, Math.max(0, c)) * 1000));

const confident = (m: SegmentMatch) =>
  m.confidence === undefined ||
  (Number.isFinite(m.confidence) && m.confidence >= CROP_MIN_CONFIDENCE && m.confidence <= 1);

const boxArea = (b: SamBox) => (b.x2 - b.x1) * (b.y2 - b.y1);

// No match: no_match. An answer about another size of image: size_mismatch (also any confident
// box outside the frame: its coordinates are not ours). None confident: low_confidence (the most
// confident kept for the record). Then the largest box: under 5% of the frame too_small, over 97%
// already_flat.
export function chooseMatch(answer: SegmentResult, frame: { width: number; height: number }): Choice {
  if (answer.matches.length === 0) return { ok: false, category: "no_match", match: null, confidence: null };
  if (answer.imageWidth !== frame.width || answer.imageHeight !== frame.height) {
    return { ok: false, category: "size_mismatch", match: null, confidence: null };
  }
  const kept = answer.matches.filter(confident);
  if (kept.length === 0) {
    const best = answer.matches.reduce((a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a));
    return { ok: false, category: "low_confidence", match: best, confidence: perMille(best.confidence) };
  }
  const inside = (b: SamBox) =>
    [b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) &&
    b.x1 >= 0 &&
    b.y1 >= 0 &&
    b.x1 < b.x2 &&
    b.y1 < b.y2 &&
    b.x2 <= frame.width &&
    b.y2 <= frame.height;
  if (!kept.every((m) => inside(m.box))) {
    return { ok: false, category: "size_mismatch", match: null, confidence: null };
  }
  const match = kept.reduce((a, b) => (boxArea(b.box) > boxArea(a.box) ? b : a));
  const confidence = perMille(match.confidence);
  const share = boxArea(match.box) / (frame.width * frame.height);
  if (share < BOX_MIN_SHARE) return { ok: false, category: "too_small", match, confidence };
  if (share > BOX_MAX_SHARE) return { ok: false, category: "already_flat", match, confidence };
  return { ok: true, match, confidence };
}

// The box with a 2% margin on each side, kept inside the frame, as a quad in pixel edges.
export function boxQuad(box: SamBox, frame: { width: number; height: number }): CropPoint[] {
  const mx = (box.x2 - box.x1) * BOX_MARGIN;
  const my = (box.y2 - box.y1) * BOX_MARGIN;
  const left = Math.max(0, Math.floor(box.x1 - mx));
  const top = Math.max(0, Math.floor(box.y1 - my));
  const right = Math.min(frame.width, Math.ceil(box.x2 + mx));
  const bottom = Math.min(frame.height, Math.ceil(box.y2 + my));
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

// --- The crop ---

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function unavailableOf(err: unknown): CropUnavailableCategory {
  if (!(err instanceof AiError)) return "unknown";
  switch (err.category) {
    case "timeout":
    case "unavailable":
    case "network":
    case "rate_limited":
      return err.category;
    case "cap":
    case "job_cap":
    case "too_expensive":
    case "billing":
      return "budget";
    default:
      return "unknown";
  }
}

const errorName = (err: unknown) => (err instanceof AiError ? err.category : ((err as Error)?.name ?? "unknown"));

async function loadSharp(): Promise<Sharp | null> {
  try {
    return (await import("sharp")).default;
  } catch {
    return null;
  }
}

async function normalize(sharp: Sharp, bytes: Uint8Array): Promise<Frame> {
  const jpeg = await sharp(bytes, { limitInputPixels: INPUT_MAX_PIXELS })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({ width: FRAME_MAX_SIDE, height: FRAME_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    jpeg: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength),
    raster: {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  };
}

// JPEG at quality 85, then 70 once; null when neither fits the cap.
async function encode(sharp: Sharp, r: Raster): Promise<Uint8Array | null> {
  for (const quality of [85, 70]) {
    const out = await sharp(r.data, { raw: { width: r.width, height: r.height, channels: r.channels } })
      .jpeg({ quality })
      .toBuffer();
    if (out.byteLength <= CROP_MAX_BYTES) return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
  return null;
}

export async function cropDocument(input: CropInput, session: Session, deps: CropDeps = {}): Promise<CropOutcome> {
  // The switch is re-read here, at the outside call, whatever the caller already checked.
  if (!flags.documentCrop) return { status: "off" };
  const id = input.documentId;
  const sharp = await loadSharp();
  if (!sharp) {
    console.error(`documents: crop ${id} failed category=no_library`);
    return { status: "unavailable", category: "no_library" };
  }
  let frame: Frame;
  try {
    frame = await normalize(sharp, input.bytes);
  } catch (err) {
    console.error(`documents: crop ${id} failed category=bad_image error=${errorName(err)}`);
    return { status: "skipped", category: "bad_image", box: null, confidence: null, callId: null };
  }
  const size = { width: frame.raster.width, height: frame.raster.height };
  let answer: SegmentResult;
  try {
    answer = await (deps.segment ?? segment)(
      {
        image: { mime: "image/jpeg", bytes: frame.jpeg },
        prompt: CROP_PROMPT,
        maskEncoding: "one_bit",
        includeConfidence: true,
        purpose: "document_crop",
        maxCostCents: CROP_MAX_COST_CENTS,
        timeoutMs: CROP_TIMEOUT_MS,
        traceId: input.traceId,
      },
      session,
      deps.ai ?? {},
    );
  } catch (err) {
    console.error(`documents: crop ${id} failed category=${errorName(err)}`);
    return { status: "unavailable", category: unavailableOf(err) };
  }
  const callId = answer.callId;
  const boxOf = (m: SegmentMatch | null): CropBox | null => (m ? { ...m.box, ...size } : null);
  try {
    const choice = chooseMatch(answer, size);
    if (!choice.ok) {
      return { status: "skipped", category: choice.category, box: boxOf(choice.match), confidence: choice.confidence, callId };
    }
    const quad = maskQuad(choice.match, size);
    const source = quad ?? boxQuad(choice.match.box, size);
    const out = outputSize(source);
    const flat = warp(frame.raster, source, out.width, out.height);
    if (!flat) throw new Error("warp found no map");
    const bytes = await encode(sharp, flat);
    const box = boxOf(choice.match) as CropBox;
    if (!bytes) return { status: "skipped", category: "too_large", box, confidence: choice.confidence, callId };
    return {
      status: "cropped",
      bytes,
      mime: "image/jpeg",
      hash: sha256(bytes),
      method: quad ? "quad" : "box",
      quad,
      box,
      confidence: choice.confidence,
      callId,
    };
  } catch (err) {
    console.error(`documents: crop ${id} failed category=decode_error error=${errorName(err)}`);
    return { status: "skipped", category: "decode_error", box: null, confidence: null, callId };
  }
}
