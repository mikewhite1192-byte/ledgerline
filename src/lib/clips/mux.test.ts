import { describe, expect, it } from "vitest";
import { readMp4Header } from "./mp4";
import { muxAvc, type MuxInput } from "./mux";

const input = (overrides: Partial<MuxInput> = {}): MuxInput => ({
  width: 640,
  height: 360,
  timescale: 8000,
  frameTicks: 1000,
  avcC: Uint8Array.of(1, 0x64, 0, 0x1f, 0xff, 0xe1, 0),
  samples: Array.from({ length: 16 }, (_, i) => ({ data: Uint8Array.of(0, 0, 0, 2, 0x65, i), key: i % 8 === 0 })),
  ...overrides,
});

describe("muxAvc", () => {
  it("writes a file the header reader reads back exactly, with the samples in order at the end", () => {
    const bytes = muxAvc(input());
    expect(bytes).not.toBeNull();
    expect(readMp4Header(bytes!)).toEqual({
      ok: true,
      header: { codec: "avc1", width: 640, height: 360, fps: 8, frameCount: 16, durationMs: 2000 },
    });
    const data = input().samples.flatMap((s) => [...s.data]);
    expect([...bytes!.slice(bytes!.length - data.length)]).toEqual(data);
    // The index comes before the data so a player can start at once.
    const text = String.fromCharCode(...bytes!.slice(0, 64));
    expect(text.indexOf("ftyp")).toBe(4);
    const all = Array.from(bytes!, (b) => String.fromCharCode(b)).join("");
    expect(all.indexOf("moov")).toBeLessThan(all.indexOf("mdat"));
  });

  it("refuses no samples, a first sample that is not a key frame, and a size out of range", () => {
    expect(muxAvc(input({ samples: [] }))).toBeNull();
    expect(muxAvc(input({ samples: [{ data: Uint8Array.of(1), key: false }] }))).toBeNull();
    expect(muxAvc(input({ width: 0 }))).toBeNull();
    expect(muxAvc(input({ height: 70_000 }))).toBeNull();
  });
});
