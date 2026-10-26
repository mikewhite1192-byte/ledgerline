import { PDF_MAX_PAGES } from "../prices";
import type { AiImageMime } from "../types";

// Images and PDFs sent inline. Pure helpers: no network, no file system.

export const IMAGE_MIMES: readonly AiImageMime[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}

// The length of dataUrl(mime, bytes) without building it: base64 is four characters per three
// bytes, padded. Every character is ASCII and none is escaped in JSON, so it is also the number
// of request-body bytes the attachment adds.
export function dataUrlLength(mime: string, byteLength: number): number {
  return `data:${mime};base64,`.length + 4 * Math.ceil(byteLength / 3);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((b, i) => bytes[at + i] === b);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// Whether the bytes begin the way the declared type's files do. A mislabeled or corrupt file is
// refused before any reservation instead of reaching the model as a 400.
export function looksLike(mime: AiImageMime | "application/pdf", bytes: Uint8Array): boolean {
  switch (mime) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case "application/pdf":
      return startsWith(bytes, ascii("%PDF-"));
  }
}

// The page count a PDF declares (its /Type /Page objects), capped at the 50 pages Meta reads as
// images. When none can be read, or the file has a compressed object stream (/ObjStm, which can
// hide any number of page objects behind one that is exposed), the cap: the reserve is a worst
// case, never a guess low.
export function pdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (text.includes("/ObjStm")) return PDF_MAX_PAGES;
  const found = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return found === 0 ? PDF_MAX_PAGES : Math.min(found, PDF_MAX_PAGES);
}

// Standard base64, padded, nothing else (no whitespace, no URL-safe alphabet). Null otherwise.
export function fromBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  return new Uint8Array(Buffer.from(value, "base64"));
}
