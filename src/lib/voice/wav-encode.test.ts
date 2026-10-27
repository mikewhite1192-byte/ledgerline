import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWav } from "../ai/wav";
import { flags } from "../../config/flags";
import { encodeWav, VOICE_SAMPLE_RATE } from "./wav-encode";

// The browser's WAV encoder: the header the transcription call takes, every sample in place,
// out-of-range and missing samples made safe, and the demo's sample clips readable and under the
// caps.

describe("encodeWav", () => {
  it("writes a 16 kHz mono 16-bit PCM header the model's reader accepts", () => {
    const wav = encodeWav(new Float32Array(16_000));
    expect(wav.byteLength).toBe(44 + 32_000);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 16))).toBe("WAVEfmt ");
    expect(String.fromCharCode(...wav.slice(36, 40))).toBe("data");
    expect(readWav(wav)).toEqual({ sampleRate: VOICE_SAMPLE_RATE, samples: 16_000 });
  });

  it("keeps each sample, clips past full scale and turns a non-number into silence", () => {
    const wav = encodeWav([0, 1, -1, 0.5, 2, -3, Number.NaN, Number.POSITIVE_INFINITY]);
    const view = new DataView(wav.buffer);
    const at = (i: number) => view.getInt16(44 + i * 2, true);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(at)).toEqual([0, 32767, -32768, 16384, 32767, -32768, 0, 0]);
  });

  it("writes a 24 kHz header when asked and refuses a rate that is not a whole positive number", () => {
    expect(readWav(encodeWav(new Float32Array(240), 24_000))).toEqual({ sampleRate: 24_000, samples: 240 });
    expect(() => encodeWav([0], 0)).toThrow();
    expect(() => encodeWav([0], 16_000.5)).toThrow();
  });
});

describe("the sample clips", () => {
  const names = ["voice-es-advance", "voice-en-advance", "voice-es-pay-question", "voice-es-injection"];
  it.each(names)("%s is a WAV the model takes, under both upload caps", (name) => {
    const bytes = new Uint8Array(readFileSync(join(process.cwd(), "public", "samples", `${name}.wav`)));
    const wav = readWav(bytes);
    expect(wav?.sampleRate).toBe(VOICE_SAMPLE_RATE);
    expect(bytes.byteLength).toBeLessThan(flags.voiceLimits.maxOriginalBytes);
    expect(bytes.byteLength).toBeLessThan(flags.voiceLimits.maxWavBytes);
    expect(((wav?.samples ?? 0) * 1000) / VOICE_SAMPLE_RATE).toBeLessThan(flags.voiceLimits.maxDurationMs);
  });
});
