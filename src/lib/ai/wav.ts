// Reads a WAV file's header without decoding the audio, so a transcription is refused before
// any reservation unless it is what the API takes: RIFF/WAVE, PCM (format tag 1), mono, 16-bit,
// 16,000 or 24,000 Hz, and within our limits of 600 seconds and 20 MB.
// (https://dev.meta.ai/docs/api-reference/voice/transcribe)

export const WAV_MAX_BYTES = 20 * 1024 * 1024;
export const WAV_MAX_SECONDS = 600;
const SAMPLE_RATES = new Set([16_000, 24_000]);

export type WavInfo = { sampleRate: number; samples: number };

function tag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

// The sample rate and sample count, or null for anything else: another container or encoding,
// stereo, 8-bit or float samples, a data chunk longer than the file (truncated), a streaming
// header with no length, or audio past the limits.
export function readWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44 || bytes.length > WAV_MAX_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") return null;

  let format: { sampleRate: number } | null = null;
  let at = 12;
  // Chunks: a four-letter id, a little-endian length, the body, padded to an even length.
  while (at + 8 <= bytes.length) {
    const id = tag(bytes, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > bytes.length) return null;
    if (id === "fmt ") {
      if (size < 16) return null;
      const formatTag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (formatTag !== 1 || channels !== 1 || bits !== 16 || blockAlign !== 2) return null;
      if (!SAMPLE_RATES.has(sampleRate)) return null;
      format = { sampleRate };
    } else if (id === "data") {
      // The format comes first in a well-formed file.
      if (!format || size % 2 !== 0) return null;
      const samples = size / 2;
      if (samples === 0 || samples > WAV_MAX_SECONDS * format.sampleRate) return null;
      return { sampleRate: format.sampleRate, samples };
    }
    at = body + size + (size % 2);
  }
  return null;
}
