import type { SegmentMatch } from "../ai/types";

// Where the blur goes. The two segmentation calls (faces, plates) answer with boxes per frame; the
// clip row keeps those boxes (never a pixel), and the plan is computed from them the same way on
// the server, in the uploader's browser and in the viewer's overlay. Pure.

// [x1, y1, x2, y2] in the clip's own pixels, whole numbers, x1 < x2 and y1 < y2.
export type PlanBox = [number, number, number, number];

// One stored box: [frame, x1, y1, x2, y2, confidence or null]. Frames count from 0.
export type StoredBox = [number, number, number, number, number, number | null];

export type StoredRedaction = { face: StoredBox[]; plate: StoredBox[] };

export type ClipSize = { width: number; height: number; frameCount: number };

export type RedactionPlan = ClipSize & {
  // One entry per frame, in order; an empty list is a frame with nothing to blur.
  frames: PlanBox[][];
  coverage: { faceFrames: number; plateFrames: number; boxes: number };
};

// More boxes than this in one frame for one concept are stored as their union: a larger blur is
// always safe, and it keeps the row (and every read of it) small.
export const MAX_BOXES_PER_FRAME = 4;
// Each box grows by this share of its own size on every side, and by at least DILATE_MIN_PX.
export const DILATE_SHARE = 0.15;
export const DILATE_MIN_PX = 6;

const isWhole = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

function union(boxes: PlanBox[]): PlanBox {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

function clamp(box: PlanBox, width: number, height: number): PlanBox | null {
  const x1 = Math.max(0, Math.min(width, box[0]));
  const y1 = Math.max(0, Math.min(height, box[1]));
  const x2 = Math.max(0, Math.min(width, box[2]));
  const y2 = Math.max(0, Math.min(height, box[3]));
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

// The answer's boxes as the row keeps them: rounded outward to whole pixels and clamped, frames in
// order, at most MAX_BOXES_PER_FRAME per frame. A frame past the clip is dropped (the parser
// already refuses those, this is the second lock).
export function storedBoxes(frames: ReadonlyMap<number, SegmentMatch[]>, size: ClipSize): StoredBox[] {
  const out: StoredBox[] = [];
  const order = [...frames.keys()].filter((f) => isWhole(f, 0, size.frameCount - 1)).sort((a, b) => a - b);
  for (const frame of order) {
    const matches = frames.get(frame) ?? [];
    const boxes: { box: PlanBox; c: number | null }[] = [];
    for (const m of matches) {
      const box = clamp(
        [Math.floor(m.box.x1), Math.floor(m.box.y1), Math.ceil(m.box.x2), Math.ceil(m.box.y2)],
        size.width,
        size.height,
      );
      if (!box) continue;
      const c = typeof m.confidence === "number" && Number.isFinite(m.confidence)
        ? Math.round(Math.min(1, Math.max(0, m.confidence)) * 100) / 100
        : null;
      boxes.push({ box, c });
    }
    if (boxes.length === 0) continue;
    if (boxes.length > MAX_BOXES_PER_FRAME) {
      const cs = boxes.map((b) => b.c).filter((c): c is number => c !== null);
      out.push([frame, ...union(boxes.map((b) => b.box)), cs.length > 0 ? Math.min(...cs) : null]);
    } else {
      for (const b of boxes) out.push([frame, ...b.box, b.c]);
    }
  }
  return out;
}

function parseBoxes(value: unknown, size: ClipSize): StoredBox[] | null {
  if (!Array.isArray(value) || value.length > size.frameCount * MAX_BOXES_PER_FRAME) return null;
  const out: StoredBox[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 6) return null;
    const [frame, x1, y1, x2, y2, c] = item as unknown[];
    if (
      !isWhole(frame, 0, size.frameCount - 1) ||
      !isWhole(x1, 0, size.width) ||
      !isWhole(y1, 0, size.height) ||
      !isWhole(x2, 0, size.width) ||
      !isWhole(y2, 0, size.height) ||
      (x2 as number) <= (x1 as number) ||
      (y2 as number) <= (y1 as number) ||
      !(c === null || (typeof c === "number" && c >= 0 && c <= 1))
    ) {
      return null;
    }
    out.push([frame, x1, y1, x2, y2, c] as StoredBox);
  }
  return out;
}

// The stored redaction read back, or null when it is not exactly the shape this file writes. The
// caller treats null as "cannot redact": unknown is never "nothing to blur".
export function parseStoredRedaction(value: unknown, size: ClipSize): StoredRedaction | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "face" || keys[1] !== "plate") return null;
  const v = value as Record<string, unknown>;
  const face = parseBoxes(v.face, size);
  const plate = parseBoxes(v.plate, size);
  return face && plate ? { face, plate } : null;
}

export function dilate(box: PlanBox): PlanBox {
  const dx = Math.max(DILATE_MIN_PX, Math.ceil((box[2] - box[0]) * DILATE_SHARE));
  const dy = Math.max(DILATE_MIN_PX, Math.ceil((box[3] - box[1]) * DILATE_SHARE));
  return [box[0] - dx, box[1] - dy, box[2] + dx, box[3] + dy];
}

const overlaps = (a: PlanBox, b: PlanBox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// Overlapping boxes become one, until none overlap. Sorted so the same input gives the same plan.
export function mergeBoxes(boxes: PlanBox[]): PlanBox[] {
  let out = boxes.map((b) => [...b] as PlanBox);
  let changed = true;
  while (changed) {
    changed = false;
    const next: PlanBox[] = [];
    for (const box of out) {
      const hit = next.findIndex((n) => overlaps(n, box));
      if (hit === -1) {
        next.push(box);
      } else {
        next[hit] = union([next[hit], box]);
        changed = true;
      }
    }
    out = next;
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
}

// The plan: every stored box dilated, carried to the frame before and after it (a tracker's box
// can lag a fast move by a frame), merged where boxes overlap, and clamped to the frame.
export function planRedaction(stored: StoredRedaction, size: ClipSize): RedactionPlan {
  const raw: PlanBox[][] = Array.from({ length: size.frameCount }, () => []);
  for (const [frame, x1, y1, x2, y2] of [...stored.face, ...stored.plate]) {
    const box = dilate([x1, y1, x2, y2]);
    for (const f of [frame - 1, frame, frame + 1]) {
      if (f >= 0 && f < size.frameCount) raw[f].push(box);
    }
  }
  const frames = raw.map((boxes) =>
    mergeBoxes(boxes.map((b) => clamp(b, size.width, size.height)).filter((b): b is PlanBox => b !== null)),
  );
  return {
    ...size,
    frames,
    coverage: {
      faceFrames: new Set(stored.face.map((b) => b[0])).size,
      plateFrames: new Set(stored.plate.map((b) => b[0])).size,
      boxes: frames.reduce((n, f) => n + f.length, 0),
    },
  };
}
