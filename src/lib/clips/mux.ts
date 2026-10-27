// Writes one H.264 track into an MP4 file: the redacted clip the browser uploads. Pure (no
// Buffer), so it runs in the browser after the encoder and in tests. The samples are what an
// H.264 encoder emits in "avc" format (each NAL unit length-prefixed), and avcC is the decoder
// configuration record that comes with the first one. Constant frame rate, no audio, the index
// (moov) before the data so a player can start at once.

export type MuxSample = { data: Uint8Array; key: boolean };

export type MuxInput = {
  width: number;
  height: number;
  // Ticks per second and ticks per frame: 8 fps is { timescale: 8000, frameTicks: 1000 }.
  timescale: number;
  frameTicks: number;
  avcC: Uint8Array;
  samples: MuxSample[];
};

const MOVIE_TIMESCALE = 1000;
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

type Part = Uint8Array;

function ascii(s: string): Part {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function u8(n: number): Part {
  return Uint8Array.of(n & 0xff);
}

function u16(n: number): Part {
  return Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
}

function u32(n: number): Part {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function zeros(n: number): Part {
  return new Uint8Array(n);
}

function concat(parts: Part[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function box(type: string, ...parts: Part[]): Uint8Array {
  const body = concat(parts);
  return concat([u32(body.length + 8), ascii(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Part[]): Uint8Array {
  return box(type, u8(version), u8(flags >>> 16), u16(flags & 0xffff), ...parts);
}

const matrix = () => concat(MATRIX.map(u32));

function valid(input: MuxInput): boolean {
  const whole = (n: number, max: number) => Number.isInteger(n) && n > 0 && n <= max;
  return (
    whole(input.width, 0xffff) &&
    whole(input.height, 0xffff) &&
    whole(input.timescale, 0xffffffff) &&
    whole(input.frameTicks, 0xffffffff) &&
    input.avcC instanceof Uint8Array &&
    input.avcC.length > 0 &&
    input.samples.length > 0 &&
    input.samples[0].key &&
    input.samples.every((s) => s.data instanceof Uint8Array && s.data.length > 0)
  );
}

function moov(input: MuxInput, dataOffset: number): Uint8Array {
  const { width, height, timescale, frameTicks, samples } = input;
  const mediaDuration = samples.length * frameTicks;
  const movieDuration = Math.round((mediaDuration * MOVIE_TIMESCALE) / timescale);
  const keys = samples.flatMap((s, i) => (s.key ? [i + 1] : []));

  const mvhd = fullBox(
    "mvhd", 0, 0,
    u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(movieDuration),
    u32(0x00010000), u16(0x0100), zeros(10), matrix(), zeros(24), u32(2),
  );
  // Flags 3: the track is enabled and in the movie.
  const tkhd = fullBox(
    "tkhd", 0, 3,
    u32(0), u32(0), u32(1), u32(0), u32(movieDuration), zeros(8),
    u16(0), u16(0), u16(0), u16(0), matrix(), u32(width * 0x10000), u32(height * 0x10000),
  );
  // Language "und", packed as three five-bit letters.
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii("vide"), zeros(12), ascii("VideoHandler"), zeros(1));
  const vmhd = fullBox("vmhd", 0, 1, zeros(8));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const avc1 = box(
    "avc1",
    zeros(6), u16(1), zeros(16), u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff),
    box("avcC", input.avcC),
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), avc1);
  const stts = fullBox("stts", 0, 0, u32(1), u32(samples.length), u32(frameTicks));
  // Every sample a key frame needs no table; otherwise list the key frames, numbered from 1.
  const stss = keys.length === samples.length ? [] : [fullBox("stss", 0, 0, u32(keys.length), ...keys.map(u32))];
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(samples.length), u32(1));
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length)));
  const stco = fullBox("stco", 0, 0, u32(1), u32(dataOffset));
  const stbl = box("stbl", stsd, stts, ...stss, stsc, stsz, stco);
  const minf = box("minf", vmhd, dinf, stbl);
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  return box("moov", mvhd, trak);
}

// The MP4 file, or null when the input cannot make one (no samples, a first sample that is not a
// key frame, a size out of range).
export function muxAvc(input: MuxInput): Uint8Array | null {
  if (!valid(input)) return null;
  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
  // The data offset is known once the index's size is: the offset itself is fixed width.
  const size = moov(input, 0).length;
  const dataOffset = ftyp.length + size + 8;
  const data = concat(input.samples.map((s) => s.data));
  if (dataOffset + data.length > 0xffffffff) return null;
  return concat([ftyp, moov(input, dataOffset), u32(data.length + 8), ascii("mdat"), data]);
}
