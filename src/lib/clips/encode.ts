import { muxAvc, type MuxSample } from "./mux";
import type { PlanBox, RedactionPlan } from "./redaction";

// The uploader's browser redacts its own clip: it plays the file it chose in a hidden video
// element, steps through every frame, draws it on a canvas, covers every planned box (a heavy
// smear plus a dark wash, so a thin plate cannot survive), encodes the result as H.264 and writes
// an MP4. The raw frames never leave this function; only the redacted file comes back.

export const REDACTED_TARGET_BYTES = 650_000;
export const REDACTED_MAX_BYTES = 700_000;
// The smear: each box is shrunk to at most this many blocks across its shorter side, then drawn
// back up with smoothing on, which reads as a strong blur in every browser (a canvas blur filter
// is not in every one).
export const SMEAR_BLOCKS = 6;
export const WASH = "rgba(24, 24, 27, 0.4)";
const TIMESCALE = 90_000;
const SEEK_TIMEOUT_MS = 5_000;
const MAX_QUEUE = 4;

export type ClipTiming = { width: number; height: number; fps: number; frameCount: number; durationMs: number };

export type RedactFailure = "no_webcodecs" | "unsupported" | "decode" | "encode" | "too_large";
export type RedactResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: RedactFailure };

// Baseline profile; level 3.1 covers 1280 x 720, level 4.0 the 1920 cap.
export function codecFor(width: number, height: number): string {
  return width * height <= 1280 * 720 ? "avc1.42001f" : "avc1.420028";
}

// Bits per second so the target size covers the whole clip, with room for an encoder that runs
// over its rate.
export function bitrateFor(durationMs: number, attempt: number): number {
  const seconds = Math.max(1, durationMs / 1000);
  return Math.floor(((REDACTED_TARGET_BYTES * 8 * 0.8) / seconds) / 2 ** attempt);
}

// Where frame n sits, in seconds: the middle of its slot. The duration over the frame count, not
// the rounded frame rate (29.97 reads as 30).
export function frameTime(n: number, timing: ClipTiming): number {
  return ((n + 0.5) * timing.durationMs) / timing.frameCount / 1000;
}

export function frameTicks(timing: ClipTiming): number {
  return Math.max(1, Math.round((TIMESCALE * timing.durationMs) / timing.frameCount / 1000));
}

export function webCodecsReady(): boolean {
  return (
    typeof globalThis.VideoEncoder === "function" &&
    typeof globalThis.VideoFrame === "function" &&
    typeof document !== "undefined"
  );
}

function configFor(timing: ClipTiming, attempt: number): VideoEncoderConfig {
  return {
    codec: codecFor(timing.width, timing.height),
    width: timing.width,
    height: timing.height,
    bitrate: bitrateFor(timing.durationMs, attempt),
    framerate: timing.fps,
    avc: { format: "avc" },
  };
}

// Asked before the upload, so no model call is paid for a clip this browser could not blur.
export async function encoderSupports(timing: ClipTiming): Promise<boolean> {
  if (!webCodecsReady() || timing.width % 2 !== 0 || timing.height % 2 !== 0) return false;
  const support = await VideoEncoder.isConfigSupported(configFor(timing, 0)).catch(() => null);
  return support?.supported === true;
}

type Ctx = CanvasRenderingContext2D;

// The decoder configuration record as its own bytes, whatever buffer type the encoder handed over.
function copyBytes(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  return new Uint8Array(source).slice();
}

// Covers the boxes on a frame already drawn on ctx. The scratch canvas is reused across frames.
export function coverBoxes(ctx: Ctx, boxes: PlanBox[], scratch: HTMLCanvasElement): void {
  const sctx = scratch.getContext("2d");
  if (!sctx) throw new Error("no canvas");
  for (const [x1, y1, x2, y2] of boxes) {
    const w = x2 - x1;
    const h = y2 - y1;
    const block = Math.max(1, Math.ceil(Math.min(w, h) / SMEAR_BLOCKS));
    const sw = Math.max(1, Math.ceil(w / block));
    const sh = Math.max(1, Math.ceil(h / block));
    scratch.width = sw;
    scratch.height = sh;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(ctx.canvas, x1, y1, w, h, 0, 0, sw, sh);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch, 0, 0, sw, sh, x1, y1, w, h);
    ctx.fillStyle = WASH;
    ctx.fillRect(x1, y1, w, h);
    ctx.restore();
  }
}

function seek(video: HTMLVideoElement, seconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve(ok);
    };
    const onSeeked = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), SEEK_TIMEOUT_MS);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = seconds;
  });
}

function loaded(video: HTMLVideoElement): Promise<boolean> {
  if (video.readyState >= 2) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), SEEK_TIMEOUT_MS * 2);
    video.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(true); }, { once: true });
    video.addEventListener("error", () => { clearTimeout(timer); resolve(false); }, { once: true });
  });
}

async function encodeOnce(
  video: HTMLVideoElement,
  plan: RedactionPlan,
  timing: ClipTiming,
  attempt: number,
  onProgress?: (done: number, total: number) => void,
): Promise<RedactResult> {
  const { width, height, frameCount } = timing;
  const config = configFor(timing, attempt);
  const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) return { ok: false, reason: "unsupported" };

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const scratch = document.createElement("canvas");
  if (!ctx) return { ok: false, reason: "unsupported" };

  const samples: MuxSample[] = [];
  let avcC: Uint8Array | null = null;
  let failed = false;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === "key" });
      const description = meta?.decoderConfig?.description;
      if (description && !avcC) avcC = copyBytes(description);
    },
    error: () => {
      failed = true;
    },
  });
  try {
    encoder.configure(config);
    const usPerFrame = (timing.durationMs * 1000) / frameCount;
    const keyEvery = Math.max(1, timing.fps * 2);
    for (let n = 0; n < frameCount; n++) {
      if (failed) return { ok: false, reason: "encode" };
      if (!(await seek(video, frameTime(n, timing)))) return { ok: false, reason: "decode" };
      ctx.drawImage(video, 0, 0, width, height);
      coverBoxes(ctx, plan.frames[n] ?? [], scratch);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(n * usPerFrame),
        duration: Math.round(usPerFrame),
      });
      try {
        encoder.encode(frame, { keyFrame: n % keyEvery === 0 });
      } finally {
        frame.close();
      }
      while (encoder.encodeQueueSize > MAX_QUEUE && !failed) {
        await new Promise((r) => setTimeout(r, 5));
      }
      onProgress?.(n + 1, frameCount);
    }
    await encoder.flush();
  } catch {
    return { ok: false, reason: "encode" };
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  if (failed || !avcC || samples.length !== frameCount) return { ok: false, reason: "encode" };
  const bytes = muxAvc({ width, height, timescale: TIMESCALE, frameTicks: frameTicks(timing), avcC, samples });
  if (!bytes) return { ok: false, reason: "encode" };
  if (bytes.length > REDACTED_MAX_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, bytes };
}

// Redacts the chosen file by the plan. One retry at half the rate when the first file comes out
// over the size cap; anything else that goes wrong is a category, never a partial file.
export async function redactClip(
  file: Blob,
  plan: RedactionPlan,
  timing: ClipTiming,
  onProgress?: (done: number, total: number) => void,
): Promise<RedactResult> {
  if (!webCodecsReady()) return { ok: false, reason: "no_webcodecs" };
  if (plan.frameCount !== timing.frameCount || plan.width !== timing.width || plan.height !== timing.height) {
    return { ok: false, reason: "unsupported" };
  }
  if (timing.width % 2 !== 0 || timing.height % 2 !== 0) return { ok: false, reason: "unsupported" };
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    if (!(await loaded(video))) return { ok: false, reason: "decode" };
    if (video.videoWidth !== timing.width || video.videoHeight !== timing.height) {
      return { ok: false, reason: "unsupported" };
    }
    let result = await encodeOnce(video, plan, timing, 0, onProgress);
    if (!result.ok && result.reason === "too_large") result = await encodeOnce(video, plan, timing, 1, onProgress);
    return result;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
