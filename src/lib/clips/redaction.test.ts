import { describe, expect, it } from "vitest";
import type { SegmentMatch } from "../ai/types";
import {
  dilate,
  MAX_BOXES_PER_FRAME,
  mergeBoxes,
  parseStoredRedaction,
  planRedaction,
  storedBoxes,
  type StoredRedaction,
} from "./redaction";

const SIZE = { width: 640, height: 360, frameCount: 10 };
const match = (x1: number, y1: number, x2: number, y2: number, confidence?: number): SegmentMatch => ({
  box: { x1, y1, x2, y2 },
  ...(confidence !== undefined ? { confidence } : {}),
  mask: null,
});

describe("storedBoxes", () => {
  it("rounds outward, clamps to the frame, orders frames and drops frames past the clip", () => {
    const frames = new Map<number, SegmentMatch[]>([
      [3, [match(10.6, 20.2, 50.1, 60.9, 0.8632)]],
      [0, [match(-5, -5, 700, 400)]],
      [10, [match(1, 1, 2, 2, 0.9)]],
      [2, [match(5, 5, 5, 9, 0.9)]],
    ]);
    expect(storedBoxes(frames, SIZE)).toEqual([
      [0, 0, 0, 640, 360, null],
      [3, 10, 20, 51, 61, 0.86],
    ]);
  });

  it("stores more than four boxes in one frame as their union at the lowest confidence", () => {
    const many = Array.from({ length: MAX_BOXES_PER_FRAME + 1 }, (_, i) => match(i * 20, 10, i * 20 + 10, 30, 0.5 + i / 10));
    expect(storedBoxes(new Map([[1, many]]), SIZE)).toEqual([[1, 0, 10, 90, 30, 0.5]]);
  });
});

describe("parseStoredRedaction", () => {
  const good: StoredRedaction = { face: [[0, 1, 2, 30, 40, 0.9]], plate: [[9, 600, 300, 640, 360, null]] };

  it("reads back exactly what storedBoxes writes", () => {
    expect(parseStoredRedaction(JSON.parse(JSON.stringify(good)), SIZE)).toEqual(good);
    expect(parseStoredRedaction({ face: [], plate: [] }, SIZE)).toEqual({ face: [], plate: [] });
  });

  it("refuses anything else, so an unreadable redaction is never read as nothing to blur", () => {
    const bad = [
      null,
      [],
      { face: [] },
      { face: [], plate: [], extra: [] },
      { face: [[10, 1, 2, 30, 40, 0.9]], plate: [] },
      { face: [[0, 1, 2, 641, 40, 0.9]], plate: [] },
      { face: [[0, 30, 2, 30, 40, 0.9]], plate: [] },
      { face: [[0, 1.5, 2, 30, 40, 0.9]], plate: [] },
      { face: [[0, 1, 2, 30, 40, 1.2]], plate: [] },
      { face: [[0, 1, 2, 30, 40]], plate: [] },
      { face: "[]", plate: [] },
      { face: Array.from({ length: 41 }, () => [0, 1, 2, 30, 40, null]), plate: [] },
    ];
    for (const value of bad) expect(parseStoredRedaction(value, SIZE), JSON.stringify(value)).toBeNull();
  });
});

describe("planRedaction", () => {
  it("grows each box, carries it a frame each way, merges overlaps and clamps to the frame", () => {
    expect(dilate([100, 100, 200, 140])).toEqual([85, 94, 215, 146]);
    const plan = planRedaction(
      { face: [[5, 100, 100, 200, 140, 0.9]], plate: [[5, 190, 120, 260, 150, null], [0, 0, 0, 10, 10, null]] },
      SIZE,
    );
    expect(plan.frames).toHaveLength(10);
    expect(plan.frames[4]).toEqual(plan.frames[5]);
    expect(plan.frames[6]).toEqual(plan.frames[5]);
    expect(plan.frames[5]).toEqual([[85, 94, 271, 156]]);
    expect(plan.frames[0]).toEqual([[0, 0, 16, 16]]);
    expect(plan.frames[1]).toEqual([[0, 0, 16, 16]]);
    expect(plan.frames[2]).toEqual([]);
    expect(plan.coverage).toEqual({ faceFrames: 1, plateFrames: 2, boxes: 5 });
  });

  it("merges boxes that only touch through a merge, and gives the same plan for any order", () => {
    const a = mergeBoxes([
      [0, 0, 10, 10],
      [20, 0, 30, 10],
      [5, 5, 25, 8],
    ]);
    expect(a).toEqual([[0, 0, 30, 10]]);
    expect(mergeBoxes([[50, 50, 60, 60], [0, 0, 5, 5]])).toEqual([
      [0, 0, 5, 5],
      [50, 50, 60, 60],
    ]);
  });
});
