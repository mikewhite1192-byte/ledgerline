// Float samples (-1 to 1, one channel) to a RIFF/WAVE file of 16-bit PCM: the one format the
// transcription call takes. Pure, with no browser or Node API, so the uploader in the browser and
// the tests use the same bytes.

export const VOICE_SAMPLE_RATE = 16_000;
const HEADER_BYTES = 44;

function writeTag(view: DataView, at: number, tag: string): void {
  for (let i = 0; i < 4; i += 1) view.setUint8(at + i, tag.charCodeAt(i));
}

// A sample outside -1..1 is clipped and anything not a number is silence.
function toInt16(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const s = Math.max(-1, Math.min(1, sample));
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

export function encodeWav(samples: ArrayLike<number>, sampleRate: number = VOICE_SAMPLE_RATE): Uint8Array {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error("sample rate is not valid");
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);
  writeTag(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(view, 8, "WAVE");
  writeTag(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeTag(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(HEADER_BYTES + i * 2, toInt16(samples[i]), true);
  }
  return out;
}
