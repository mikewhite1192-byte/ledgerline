// The size a PNG says it is, read from its first 24 bytes with no image library: the 8-byte
// signature, then the IHDR chunk (length 13, type "IHDR", width and height as big-endian 32-bit
// integers at bytes 16 to 24). Anything else is null, so a file that is not a PNG never passes.

export const PAY_CARD_WIDTH = 1080;
export const PAY_CARD_HEIGHT = 1350;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) return null;
  for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return null;
  if (u32(bytes, 8) !== 13) return null;
  for (let i = 0; i < IHDR.length; i++) if (bytes[12 + i] !== IHDR[i]) return null;
  return { width: u32(bytes, 16), height: u32(bytes, 20) };
}

// A pay card: a PNG of exactly the card's size, at most maxBytes long.
export function isPayCardPng(bytes: Uint8Array, maxBytes: number): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > maxBytes) return false;
  const size = pngSize(bytes);
  return size !== null && size.width === PAY_CARD_WIDTH && size.height === PAY_CARD_HEIGHT;
}
