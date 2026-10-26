// Synthetic media for the wrapper's tests: built in memory, never read from or written to disk.

// A PCM WAV: silence unless samples are given. The header fields can be overridden to build the
// files the reader must refuse.
export function makeWav(
  options: {
    sampleRate?: number;
    seconds?: number;
    channels?: number;
    bits?: number;
    formatTag?: number;
    // Extra chunks before "fmt " (a LIST or FLLR chunk, as real recorders write).
    leading?: { id: string; body: Uint8Array }[];
    // A data length that claims more than the file holds.
    claimedDataBytes?: number;
  } = {},
): Uint8Array {
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const blockAlign = (channels * bits) / 8;
  const dataBytes = Math.round((options.seconds ?? 1) * sampleRate) * blockAlign;
  const chunks: Uint8Array[] = [];
  const header = (id: string, size: number) => {
    const h = new Uint8Array(8);
    h.set([...id].map((c) => c.charCodeAt(0)));
    new DataView(h.buffer).setUint32(4, size, true);
    return h;
  };
  for (const c of options.leading ?? []) {
    chunks.push(header(c.id, c.body.length), c.body);
    if (c.body.length % 2) chunks.push(new Uint8Array(1));
  }
  const fmt = new Uint8Array(16);
  const v = new DataView(fmt.buffer);
  v.setUint16(0, options.formatTag ?? 1, true);
  v.setUint16(2, channels, true);
  v.setUint32(4, sampleRate, true);
  v.setUint32(8, sampleRate * blockAlign, true);
  v.setUint16(12, blockAlign, true);
  v.setUint16(14, bits, true);
  chunks.push(header("fmt ", 16), fmt);
  chunks.push(header("data", options.claimedDataBytes ?? dataBytes), new Uint8Array(dataBytes));
  const bodyLength = 4 + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(8 + bodyLength);
  out.set(header("RIFF", bodyLength));
  out.set(
    [..."WAVE"].map((c) => c.charCodeAt(0)),
    8,
  );
  let at = 12;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// The first bytes of each accepted file type, padded: enough for the type checks, not a picture.
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
export const PDF_BYTES = new Uint8Array([
  ...[..."%PDF-1.4\n1 0 obj << /Type /Page >>\n"].map((c) => c.charCodeAt(0)),
]);
