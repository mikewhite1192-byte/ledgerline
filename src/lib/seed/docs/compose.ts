import sharp from "sharp";
import { GLYPH_HEIGHT, paintText, textWidth, type Rgba } from "./font";
import { PHOTO_HEIGHT, PHOTO_WIDTH } from "./manifest";
import { toRgba } from "./stamp";

// The fallback receipt, also the zero-credit path: the receipt's exact lines drawn in the dot
// font on a paper card with a soft shadow, flat and top-down on the blank paper background (or a
// plain off-white gradient when there is none). Deterministic given the background. Used for any
// photo that fails its gate three times, and runnable with no key.

export type ComposeOptions = { width: number; height: number; scale: number; shadow: boolean };

export const COMPOSE_FULL: ComposeOptions = {
  width: PHOTO_WIDTH,
  height: PHOTO_HEIGHT,
  scale: 5,
  shadow: true,
};

const INK = [34, 34, 34, 255] as const;
const CARD = [250, 248, 243] as const;
const CARD_ALPHA_PCT = 95;
const SHADOW_ALPHA = 110;
// Dots between lines and around the text.
const LINE_GAP = 4;
const PAD = 4;

export type ReceiptLayout = {
  card: { left: number; top: number; width: number; height: number };
  textLeft: number;
  textTop: number;
  lineHeight: number;
};

// Where the card and each line go: the card centered across, a little above center so it clears
// the stamp band. Throws when the text does not fit.
export function receiptLayout(lines: readonly string[], opts: ComposeOptions): ReceiptLayout {
  if (lines.length === 0) throw new Error("no lines to draw");
  const s = opts.scale;
  const pad = PAD * s * 2;
  const lineHeight = (GLYPH_HEIGHT + LINE_GAP) * s;
  const textW = Math.max(...lines.map(textWidth)) * s;
  const textH = lines.length * GLYPH_HEIGHT * s + (lines.length - 1) * LINE_GAP * s;
  const width = textW + 2 * pad;
  const height = textH + 2 * pad;
  if (width > opts.width || height > opts.height) throw new Error("the receipt does not fit");
  const left = Math.floor((opts.width - width) / 2);
  const top = Math.floor((opts.height - height) * 0.42);
  return {
    card: { left, top, width, height },
    textLeft: left + pad,
    textTop: top + pad,
    lineHeight,
  };
}

// A vertical off-white gradient, used when no paper background exists.
export function gradient(width: number, height: number): Rgba {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const r = Math.round(236 - 14 * t);
    const g = Math.round(233 - 15 * t);
    const b = Math.round(226 - 16 * t);
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  return { data, width, height };
}

// Blends one color at a whole-percent alpha over a pixel, in place.
function blend(img: Rgba, at: number, rgb: readonly number[], alphaPct: number): void {
  for (let c = 0; c < 3; c++) {
    img.data[at + c] = Math.floor((rgb[c] * alphaPct + img.data[at + c] * (100 - alphaPct) + 50) / 100);
  }
}

async function shadowLayer(layout: ReceiptLayout, opts: ComposeOptions): Promise<Buffer> {
  const { width, height } = opts;
  const mask = Buffer.alloc(width * height * 4);
  const dx = 3 * opts.scale;
  const dy = 5 * opts.scale;
  const { card } = layout;
  for (let y = Math.max(0, card.top + dy); y < Math.min(height, card.top + card.height + dy); y++) {
    for (let x = Math.max(0, card.left + dx); x < Math.min(width, card.left + card.width + dx); x++) {
      mask[(y * width + x) * 4 + 3] = SHADOW_ALPHA;
    }
  }
  return sharp(mask, { raw: { width, height, channels: 4 } })
    .blur(Math.max(0.3, 4 * opts.scale))
    .raw()
    .toBuffer();
}

// The receipt as RGBA pixels: background, shadow, card, then the text, one line at a time.
export async function composeReceipt(
  lines: readonly string[],
  background: Uint8Array | null,
  opts: ComposeOptions = COMPOSE_FULL,
): Promise<Rgba> {
  const layout = receiptLayout(lines, opts);
  const img = background
    ? await toRgba(background, { width: opts.width, height: opts.height })
    : gradient(opts.width, opts.height);

  if (opts.shadow) {
    const shadow = await shadowLayer(layout, opts);
    for (let i = 0; i < opts.width * opts.height; i++) {
      const a = shadow[i * 4 + 3];
      if (a === 0) continue;
      const pct = Math.round((a * 100) / 255);
      blend(img, i * 4, [0, 0, 0], pct);
    }
  }

  const { card } = layout;
  for (let y = card.top; y < card.top + card.height; y++) {
    for (let x = card.left; x < card.left + card.width; x++) {
      blend(img, (y * opts.width + x) * 4, CARD, CARD_ALPHA_PCT);
    }
  }

  lines.forEach((line, i) => {
    paintText(img, line, layout.textLeft, layout.textTop + i * layout.lineHeight, opts.scale, INK);
  });
  return img;
}
