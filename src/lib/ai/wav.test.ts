import { describe, expect, it } from "vitest";
import { makeWav } from "./test-fixtures";
import { readWav, WAV_MAX_BYTES, WAV_MAX_SECONDS } from "./wav";

describe("readWav", () => {
  it("reads 16 kHz and 24 kHz mono 16-bit PCM", () => {
    expect(readWav(makeWav({ sampleRate: 16_000, seconds: 2 }))).toEqual({
      sampleRate: 16_000,
      samples: 32_000,
    });
    expect(readWav(makeWav({ sampleRate: 24_000, seconds: 0.5 }))).toEqual({
      sampleRate: 24_000,
      samples: 12_000,
    });
  });

  it("skips the chunks a recorder writes before the format, odd lengths padded", () => {
    const wav = makeWav({
      seconds: 1,
      leading: [
        { id: "FLLR", body: new Uint8Array(4_044) },
        { id: "LIST", body: new Uint8Array(3) },
      ],
    });
    expect(readWav(wav)).toEqual({ sampleRate: 16_000, samples: 16_000 });
  });

  it("refuses stereo, 8-bit, float, other rates and other containers", () => {
    expect(readWav(makeWav({ channels: 2 }))).toBeNull();
    expect(readWav(makeWav({ bits: 8 }))).toBeNull();
    expect(readWav(makeWav({ bits: 32, formatTag: 3 }))).toBeNull();
    expect(readWav(makeWav({ formatTag: 3 }))).toBeNull();
    expect(readWav(makeWav({ sampleRate: 44_100 }))).toBeNull();
    expect(readWav(makeWav({ sampleRate: 8_000 }))).toBeNull();
    const notWave = makeWav();
    notWave.set(
      [..."AVI "].map((c) => c.charCodeAt(0)),
      8,
    );
    expect(readWav(notWave)).toBeNull();
    expect(readWav(new Uint8Array(20))).toBeNull();
  });

  it("refuses a truncated file, a streaming header and empty audio", () => {
    const wav = makeWav({ seconds: 1 });
    expect(readWav(wav.subarray(0, wav.length - 2))).toBeNull();
    expect(readWav(makeWav({ seconds: 1, claimedDataBytes: 0xffffffff }))).toBeNull();
    expect(readWav(makeWav({ seconds: 0 }))).toBeNull();
  });

  it("takes exactly 600 seconds and refuses one sample more", () => {
    expect(readWav(makeWav({ sampleRate: 16_000, seconds: WAV_MAX_SECONDS }))?.samples).toBe(
      9_600_000,
    );
    expect(readWav(makeWav({ sampleRate: 16_000, seconds: 601 }))).toBeNull();
    // 600 s at 24 kHz is over 20 MB, so the size limit refuses it first.
    expect(makeWav({ sampleRate: 24_000, seconds: 600 }).length).toBeGreaterThan(WAV_MAX_BYTES);
    expect(readWav(makeWav({ sampleRate: 24_000, seconds: 600 }))).toBeNull();
  });
});
