// The three background pictures a pay card is drawn over, made once by this repo's own script
// (scripts/make-pay-card-art.ts) and committed under public/pay-cards/. Each one was read back by
// a model and kept only with no text and no digits on it, so the art can never put a figure on a
// card. art.test.ts pins each file by its sha256.

export const PAY_CARD_ART = ["art-01", "art-02", "art-03"] as const;
export type PayCardArt = (typeof PAY_CARD_ART)[number];

export function isPayCardArt(value: unknown): value is PayCardArt {
  return typeof value === "string" && (PAY_CARD_ART as readonly string[]).includes(value);
}

// Where the page loads a picture from.
export function artPath(art: PayCardArt): string {
  return `/pay-cards/${art}.webp`;
}

// The same driver always gets the same picture, and a board of drivers gets a mix (FNV-1a over
// the driver's id).
export function artFor(driverId: string): PayCardArt {
  let h = 0x811c9dc5;
  for (let i = 0; i < driverId.length; i++) {
    h ^= driverId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PAY_CARD_ART[h % PAY_CARD_ART.length];
}
