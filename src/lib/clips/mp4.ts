// Reads what a clip is from its MP4 header, without decoding a frame: the video track's codec,
// coded size, frame rate, frame count and duration. Pure (no Buffer, no file system), so the
// browser and the server read a file the same way. Anything it cannot read for certain is
// refused: unknown is not a clip.

export const MP4_LIMITS = {
  maxBytes: 700_000,
  minDurationMs: 1_000,
  maxDurationMs: 20_000,
  maxFrames: 600,
  minSide: 64,
  maxSide: 1_920,
  maxFps: 30,
} as const;

export type Mp4Limits = { [K in keyof typeof MP4_LIMITS]: number };

export type Mp4Codec = "avc1" | "avc3" | "hvc1" | "hev1";

export type Mp4Header = {
  codec: Mp4Codec;
  width: number;
  height: number;
  // Rounded to a whole number: 30000/1001 reads as 30. Frame times use durationMs / frameCount.
  fps: number;
  frameCount: number;
  durationMs: number;
};

export type Mp4Refusal =
  | "not_mp4"
  | "codec"
  | "variable_rate"
  | "rotated"
  | "dimensions"
  | "too_short"
  | "too_long"
  | "too_many_frames"
  | "too_large";

export type Mp4Read = { ok: true; header: Mp4Header } | { ok: false; reason: Mp4Refusal };

const CODECS: readonly string[] = ["avc1", "avc3", "hvc1", "hev1"];
// The MP4 brands a phone, a camera, ffmpeg or our own muxer write as the file's major brand. The
// one list for the upload check here and the model wrapper's check before a call, so a file one
// takes the other never refuses after the clip is kept.
export const MP4_BRANDS: readonly string[] = ["isom", "iso2", "iso5", "iso6", "mp41", "mp42", "avc1"];
const MAX_DEPTH = 8;
// The identity transform in a track header, 16.16 and 2.30 fixed point.
const IDENTITY = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

type Box = { type: string; start: number; end: number };

class Malformed extends Error {}

function fail(): never {
  throw new Malformed();
}

function u32(view: DataView, at: number, end: number): number {
  if (at < 0 || at + 4 > end) fail();
  return view.getUint32(at);
}

function u16(view: DataView, at: number, end: number): number {
  if (at < 0 || at + 2 > end) fail();
  return view.getUint16(at);
}

function u64(view: DataView, at: number, end: number): number {
  const hi = u32(view, at, end);
  const lo = u32(view, at + 4, end);
  const value = hi * 2 ** 32 + lo;
  if (!Number.isSafeInteger(value)) fail();
  return value;
}

function fourcc(bytes: Uint8Array, at: number, end: number): string {
  if (at < 0 || at + 4 > end) fail();
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

// The boxes laid end to end between start and end. A box that runs past its parent is malformed.
function children(bytes: Uint8Array, view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at < end) {
    if (end - at < 8) fail();
    let size = u32(view, at, end);
    const type = fourcc(bytes, at + 4, end);
    let header = 8;
    if (size === 1) {
      size = u64(view, at + 8, end);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) fail();
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

function only(boxes: Box[], type: string): Box {
  const found = boxes.filter((b) => b.type === type);
  if (found.length !== 1) fail();
  return found[0];
}

function path(bytes: Uint8Array, view: DataView, from: Box, types: string[]): Box {
  let box = from;
  if (types.length > MAX_DEPTH) fail();
  for (const type of types) box = only(children(bytes, view, box.start, box.end), type);
  return box;
}

type Track = {
  codec: string;
  width: number;
  height: number;
  timescale: number;
  counts: number[];
  deltas: number[];
  sizes: number;
  identity: boolean;
};

function readTrack(bytes: Uint8Array, view: DataView, trak: Box): Track | null {
  const mdia = path(bytes, view, trak, ["mdia"]);
  const hdlr = path(bytes, view, mdia, ["hdlr"]);
  if (fourcc(bytes, hdlr.start + 8, hdlr.end) !== "vide") return null;

  const tkhd = path(bytes, view, trak, ["tkhd"]);
  const tkVersion = bytes[tkhd.start];
  // version, flags, times, track id, reserved, duration, reserved, layer, group, volume, reserved
  const matrixAt = tkhd.start + (tkVersion === 1 ? 52 : 40);
  const identity = IDENTITY.every((v, i) => u32(view, matrixAt + i * 4, tkhd.end) === v);

  const mdhd = path(bytes, view, mdia, ["mdhd"]);
  const mdVersion = bytes[mdhd.start];
  if (mdVersion !== 0 && mdVersion !== 1) fail();
  const timescale = u32(view, mdhd.start + (mdVersion === 1 ? 20 : 12), mdhd.end);
  if (timescale === 0) fail();

  const stbl = path(bytes, view, mdia, ["minf", "stbl"]);
  const tables = children(bytes, view, stbl.start, stbl.end);
  const stsd = only(tables, "stsd");
  if (u32(view, stsd.start + 4, stsd.end) !== 1) fail();
  const entry = children(bytes, view, stsd.start + 8, stsd.end);
  if (entry.length !== 1) fail();
  const sample = entry[0];
  // A visual sample entry: reserved, data reference, pre-defined and reserved, then the size.
  const width = u16(view, sample.start + 24, sample.end);
  const height = u16(view, sample.start + 26, sample.end);

  const stts = only(tables, "stts");
  const entries = u32(view, stts.start + 4, stts.end);
  if (entries === 0 || stts.start + 8 + entries * 8 > stts.end) fail();
  const counts: number[] = [];
  const deltas: number[] = [];
  for (let i = 0; i < entries; i++) {
    counts.push(u32(view, stts.start + 8 + i * 8, stts.end));
    deltas.push(u32(view, stts.start + 12 + i * 8, stts.end));
  }

  const stsz = only(tables, "stsz");
  const sizes = u32(view, stsz.start + 8, stsz.end);
  return { codec: sample.type, width, height, timescale, counts, deltas, sizes, identity };
}

function read(bytes: Uint8Array, limits: Mp4Limits): Mp4Read {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = children(bytes, view, 0, bytes.length);
  // The file type box first, with a plain 8-byte header, so its major brand is the four bytes at
  // offset 8: where the model wrapper reads it.
  if (top.length === 0 || top[0].type !== "ftyp" || top[0].start !== 8) return { ok: false, reason: "not_mp4" };
  if (!MP4_BRANDS.includes(fourcc(bytes, 8, top[0].end))) return { ok: false, reason: "not_mp4" };
  const moov = only(top, "moov");
  const tracks = children(bytes, view, moov.start, moov.end)
    .filter((b) => b.type === "trak")
    .map((t) => readTrack(bytes, view, t))
    .filter((t): t is Track => t !== null);
  if (tracks.length !== 1) return { ok: false, reason: "not_mp4" };
  const t = tracks[0];
  if (!CODECS.includes(t.codec)) return { ok: false, reason: "codec" };
  if (!t.identity) return { ok: false, reason: "rotated" };

  const frameCount = t.counts.reduce((a, b) => a + b, 0);
  if (frameCount === 0 || t.sizes !== frameCount) fail();
  // Constant frame rate: every sample lasts the same number of ticks.
  const delta = t.deltas[0];
  if (delta === 0 || t.deltas.some((d) => d !== delta)) return { ok: false, reason: "variable_rate" };
  const durationMs = Math.round((frameCount * delta * 1000) / t.timescale);
  const fps = Math.round(t.timescale / delta);

  if (
    t.width < limits.minSide ||
    t.width > limits.maxSide ||
    t.height < limits.minSide ||
    t.height > limits.maxSide ||
    fps < 1 ||
    fps > limits.maxFps
  ) {
    return { ok: false, reason: "dimensions" };
  }
  if (frameCount > limits.maxFrames) return { ok: false, reason: "too_many_frames" };
  if (durationMs > limits.maxDurationMs) return { ok: false, reason: "too_long" };
  if (durationMs < limits.minDurationMs) return { ok: false, reason: "too_short" };
  return {
    ok: true,
    header: { codec: t.codec as Mp4Codec, width: t.width, height: t.height, fps, frameCount, durationMs },
  };
}

export function readMp4Header(bytes: Uint8Array, limits: Mp4Limits = MP4_LIMITS): Mp4Read {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return { ok: false, reason: "not_mp4" };
  if (bytes.length > limits.maxBytes) return { ok: false, reason: "too_large" };
  try {
    return read(bytes, limits);
  } catch (err) {
    if (err instanceof Malformed) return { ok: false, reason: "not_mp4" };
    throw err;
  }
}
