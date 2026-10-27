import sharp from "sharp";
import { GLYPH_HEIGHT, paintText, textWidth, type Rgba } from "./font";
import { PHOTO_MAX_BYTES } from "./manifest";

// The SAMPLE mark our own code puts on every photo, whatever the model printed: a dark band
// across the bottom 6% with white SAMPLE in the dot font, then the SAMPLE sentence in the webp's
// EXIF ImageDescription. Pure (pixels in, pixels or bytes out); stamp.test.ts reads the band back.

const WORD = "SAMPLE";
// The band is #111111 at 72% over the photo.
const BAND = 17;
const BAND_ALPHA_PCT = 72;
const WHITE = [255, 255, 255, 255] as const;
// Quality steps tried in order until the file fits its cap.
const QUALITIES = [80, 74, 68, 62, 56];

export function bandHeight(height: number): number {
  return Math.max(8, Math.round(height * 0.06));
}

export function stampScale(band: number): number {
  return Math.max(1, Math.floor((band * 0.6) / GLYPH_HEIGHT));
}

// One channel under the band.
export function underBand(value: number): number {
  return Math.floor((value * (100 - BAND_ALPHA_PCT) + BAND * BAND_ALPHA_PCT + 50) / 100);
}

// Where the word sits: centered in the band on whole pixels.
export function stampLayout(width: number, height: number) {
  const band = bandHeight(height);
  const scale = stampScale(band);
  return {
    band,
    scale,
    left: Math.floor((width - textWidth(WORD) * scale) / 2),
    top: height - band + Math.floor((band - GLYPH_HEIGHT * scale) / 2),
  };
}

// Stamps an RGBA image in place and returns it. Alpha is left as it was.
export function stampRgba(img: Rgba): Rgba {
  if (img.data.length !== img.width * img.height * 4) throw new Error("not an RGBA buffer");
  const { band, scale, left, top } = stampLayout(img.width, img.height);
  for (let y = img.height - band; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const at = (y * img.width + x) * 4;
      img.data[at] = underBand(img.data[at]);
      img.data[at + 1] = underBand(img.data[at + 1]);
      img.data[at + 2] = underBand(img.data[at + 2]);
    }
  }
  paintText(img, WORD, left, top, scale, WHITE);
  return img;
}

// Any image sharp reads, decoded to RGBA (optionally resized to exactly width x height, cropping
// to fill).
export async function toRgba(
  bytes: Uint8Array,
  size?: { width: number; height: number },
): Promise<Rgba> {
  let pipeline = sharp(bytes).rotate();
  if (size) pipeline = pipeline.resize(size.width, size.height, { fit: "cover" });
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error("not RGBA");
  return { data, width: info.width, height: info.height };
}

// Lossless PNG of an RGBA image (tests and the pre-stamp check).
export async function pngOf(img: Rgba): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toBuffer();
}

// A webp with no EXIF, at quality 80: what the verify read sees.
export async function plainWebp(img: Rgba): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .removeAlpha()
    .webp({ quality: 80 })
    .toBuffer();
}

// Even the lowest quality step does not fit the byte cap.
export class TooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`the image does not fit in ${maxBytes} bytes`);
    this.name = "TooLargeError";
  }
}

// The kept file: webp with the description in EXIF, at quality 80, stepping down until it fits
// the cap. Throws a TooLargeError when even the lowest step does not fit.
export async function encodeWebp(
  img: Rgba,
  description: string,
  maxBytes: number = PHOTO_MAX_BYTES,
): Promise<Buffer> {
  for (const quality of QUALITIES) {
    const out = await sharp(img.data, {
      raw: { width: img.width, height: img.height, channels: 4 },
    })
      .removeAlpha()
      .webp({ quality })
      .withExif({ IFD0: { ImageDescription: description } })
      .toBuffer();
    if (out.length <= maxBytes) return out;
  }
  throw new TooLargeError(maxBytes);
}

// The ImageDescription (tag 0x010E) from a raw EXIF block, as sharp's metadata() returns it:
// an optional "Exif\0\0" prefix, then a TIFF header and IFD0. Null when absent or malformed.
export function exifDescription(exif: Buffer): string | null {
  let base = 0;
  if (exif.length >= 6 && exif.toString("latin1", 0, 6) === "Exif\0\0") base = 6;
  if (exif.length < base + 8) return null;
  const order = exif.toString("latin1", base, base + 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (at: number) => (le ? exif.readUInt16LE(at) : exif.readUInt16BE(at));
  const u32 = (at: number) => (le ? exif.readUInt32LE(at) : exif.readUInt32BE(at));
  if (u16(base + 2) !== 42) return null;
  const ifd = base + u32(base + 4);
  if (ifd + 2 > exif.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > exif.length) return null;
    if (u16(entry) !== 0x010e) continue;
    // Type 2 is ASCII; the count includes the closing NUL.
    if (u16(entry + 2) !== 2) return null;
    const n = u32(entry + 4);
    const at = n <= 4 ? entry + 8 : base + u32(entry + 8);
    if (at + n > exif.length) return null;
    return exif.toString("latin1", at, at + n).replace(/\0+$/, "");
  }
  return null;
}

// The ImageDescription of an encoded image, or null.
export async function imageDescription(bytes: Uint8Array): Promise<string | null> {
  const { exif } = await sharp(bytes).metadata();
  return exif ? exifDescription(exif) : null;
}
