import type { AiTarget, AiUsage, Metered } from "./types";

// Prices in nanocents (1 cent = 1,000,000,000 nanocents), so every listed price is an exact
// integer. $1.25 per million tokens is 125 cents / 1,000,000 = 125,000 nanocents a token.
// The $150 credit is 1.5e13 nanocents, far under 2^53, so every sum stays a safe integer through
// the pg parser and the Data API's JSON. Source for every Meta price:
// https://dev.meta.ai/docs/pricing-rate-limits.
export const NANOCENTS_PER_CENT = 1_000_000_000;

// The Meta credit, in cents. A cap above it is refused: the vendor's spend limit only notifies.
export const CREDIT_CENTS = 15_000;

// Muse Voice Transcribe: $0.18 per hour of audio, metered in whole seconds rounded down.
export const VOICE_NANOCENTS_PER_SECOND = 5_000_000;
// Muse Image: $0.01 per image generated and returned.
export const IMAGE_NANOCENTS = 1_000_000_000;
// SAM 3.1 image segmentation: $2.50 per 1,000 images, whether anything matched or not.
export const SAM_NANOCENTS = 250_000_000;

// The input tokens reserved for each image sent to a text model. Meta's docs put a 1280-pixel
// image at about 1,300 to 1,500 tokens; a 400 x 300 PNG measured 167.
export const MEDIA_RESERVE_TOKENS = 1_600;
// The input tokens reserved for each PDF page. Meta's docs give no figure; a one-page US Letter
// PDF with two lines of text measured 2,524 (the page image plus its extracted text), so a dense
// page gets room on top of that.
export const PDF_PAGE_RESERVE_TOKENS = 4_000;
// Meta reads page images from the first 50 pages of a PDF.
export const PDF_MAX_PAGES = 50;

export type TokenPrice = { unit: "tokens"; input: number; cached: number; output: number };
export type Price =
  | TokenPrice
  | { unit: "audio_seconds"; perSecond: number }
  | { unit: "images"; perImage: number };

// Standard tier: $1.25 input, $0.15 cached input, $4.25 output per million. Reasoning tokens are
// inside output_tokens and billed at the output rate, so they need no term of their own.
const MUSE_SPARK_STANDARD: TokenPrice = {
  unit: "tokens",
  input: 125_000,
  cached: 15_000,
  output: 425_000,
};

// Contributor tier: $0.10 input, $0.002 cached input, $0.20 output per million. Meta may train on
// what is sent to it, so it is reached only through META_CONTRIBUTOR_MODE (./targets.ts), for
// synthetic data.
const MUSE_SPARK_CONTRIBUTOR: TokenPrice = {
  unit: "tokens",
  input: 10_000,
  cached: 200,
  output: 20_000,
};

// Muse Wonder: $4.00 input, $0.20 cached input, $20.00 output per million. Standard only.
const MUSE_WONDER: TokenPrice = {
  unit: "tokens",
  input: 400_000,
  cached: 20_000,
  output: 2_000_000,
};

// Keyed by the exact model ids GET /v1/models lists, per target. A model id missing from its
// target's table is refused before any call, so a typo in a branch variable fails closed. The
// Contributor row is priced here but never named by a variable: ./targets.ts swaps it in only
// when META_CONTRIBUTOR_MODE is "true".
const PRICES: Record<AiTarget, Record<string, Price>> = {
  spark: {
    "muse-spark-1.3": MUSE_SPARK_STANDARD,
    "muse-spark-1.2": MUSE_SPARK_STANDARD,
    "muse-spark-1.1": MUSE_SPARK_STANDARD,
    "muse-spark-1.3-contributor": MUSE_SPARK_CONTRIBUTOR,
  },
  wonder: { "muse-wonder-1.0": MUSE_WONDER },
  // Muse Spark Open on Baseten: the same per-million prices as Muse Spark
  // (https://www.baseten.co/library/muse-spark-open/).
  spark_open: {
    "meta-models/muse-spark-open-1026": { ...MUSE_SPARK_STANDARD },
  },
  voice: {
    "muse-voice-transcribe-1.0": { unit: "audio_seconds", perSecond: VOICE_NANOCENTS_PER_SECOND },
  },
  image: { "muse-image-1.0": { unit: "images", perImage: IMAGE_NANOCENTS } },
  sam: { "sam-3.1": { unit: "images", perImage: SAM_NANOCENTS } },
};

export function priceFor(target: AiTarget, model: string): Price | null {
  const table = PRICES[target];
  return table && Object.hasOwn(table, model) ? table[model] : null;
}

// The input tokens reserved for a request's attachments.
export function mediaReserveTokens(images: number, pdfPages: number): number {
  return images * MEDIA_RESERVE_TOKENS + pdfPages * PDF_PAGE_RESERVE_TOKENS;
}

// The worst case of a text call, reserved before it: a generous guess at the input plus every
// output token the call may produce. Input is a token per two bytes of the request body without
// its attachment data, plus mediaTokens for the attachments (mediaReserveTokens). English runs
// about four characters a token, but chat template tokens and JSON tool schemas tokenize denser,
// and a bigger reserve keeps spend under the cap.
export function estimateReserve(
  price: TokenPrice,
  textBytes: number,
  maxOutputTokens: number,
  mediaTokens = 0,
): number {
  return (Math.ceil(textBytes / 2) + mediaTokens) * price.input + maxOutputTokens * price.output;
}

// A transcription's worst case: every second of the audio, rounded up, and one more.
export function audioReserve(perSecond: number, samples: number, sampleRate: number): number {
  return (Math.ceil(samples / sampleRate) + 1) * perSecond;
}

// What the provider charges for the tokens it reported. Cached input is part of input.
export function actualCost(price: TokenPrice, usage: AiUsage): number {
  return (
    (usage.input - usage.cached) * price.input +
    usage.cached * price.cached +
    usage.output * price.output
  );
}

// The cost of any answer, from what the provider reported. Null when what was reported is not
// what this price is metered by, which settles the call as unknown with its reservation kept.
export function meteredCost(price: Price, metered: Metered): number | null {
  if (price.unit === "tokens" && metered.unit === "tokens") return actualCost(price, metered.usage);
  if (price.unit === "audio_seconds" && metered.unit === "audio_seconds") {
    return metered.seconds * price.perSecond;
  }
  if (price.unit === "images" && metered.unit === "images") return metered.count * price.perImage;
  return null;
}

// AI_SPEND_CAP_CENTS as nanocents, or null when it is unset, not a whole number of cents, zero,
// or above the credit. Null refuses every call.
export function capNanocents(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,5}$/.test(value)) return null;
  const cents = Number(value);
  if (cents > CREDIT_CENTS) return null;
  return cents * NANOCENTS_PER_CENT;
}

// AI_WONDER_CAP_CENTS as nanocents: a second hard stop for Muse Wonder inside the overall cap.
// Null when it is unset, not a whole number of cents, zero, or above the overall cap (or the
// overall cap is itself refused). Null refuses Wonder calls only.
export function wonderCapNanocents(
  value: string | undefined,
  overallNanocents: number | null,
): number | null {
  const cap = capNanocents(value);
  if (cap === null || overallNanocents === null || cap > overallNanocents) return null;
  return cap;
}

// Rounded up, never down: a display of spend must not look smaller than the ledger.
function roundUp(nanocents: number, unit: number): number {
  return Math.floor((nanocents + unit - 1) / unit);
}

function fixed(units: number, places: number): string {
  const scale = 10 ** places;
  const whole = Math.floor(units / scale);
  return places === 0 ? `${whole}` : `${whole}.${String(units % scale).padStart(places, "0")}`;
}

// 91,700,000 nanocents is "0.0917" cents.
export function centsToDisplay(nanocents: number, places = 4): string {
  return fixed(roundUp(nanocents, NANOCENTS_PER_CENT / 10 ** places), places);
}

// 1.2e13 nanocents is "$120.00".
export function dollarsToDisplay(nanocents: number): string {
  return `$${fixed(roundUp(nanocents, NANOCENTS_PER_CENT), 2)}`;
}
