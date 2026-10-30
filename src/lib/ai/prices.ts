import type { AiProvider, AiTarget, AiUsage, Metered } from "./types";

// Prices in nanocents (1 cent = 1,000,000,000 nanocents), so every listed price is an exact
// integer. $1.25 per million tokens is 125 cents / 1,000,000 = 125,000 nanocents a token.
// The $400 cap ceiling is 4e13 nanocents, far under 2^53, so every sum stays a safe integer
// through the pg parser and the Data API's JSON. Source for every Meta price:
// https://dev.meta.ai/docs/pricing-rate-limits.
export const NANOCENTS_PER_CENT = 1_000_000_000;

// The highest AI_SPEND_CAP_CENTS may be, in cents ($400). The $150 Meta credit is spent first
// and the card on file covers the rest, up to the cap. A cap above it is refused: the caps are
// the only real stop, since the vendor's spend limit only notifies. Kept equal to infra's
// AI_CAP_CEILING_CENTS.
export const CAP_CEILING_CENTS = 40_000;

// Muse Voice Transcribe: $0.18 per hour of audio, metered in whole seconds rounded down.
export const VOICE_NANOCENTS_PER_SECOND = 5_000_000;
// Muse Image: $0.01 per image generated and returned.
export const IMAGE_NANOCENTS = 1_000_000_000;
// SAM 3.1 image segmentation: $2.50 per 1,000 images, whether anything matched or not.
export const SAM_NANOCENTS = 250_000_000;
// SAM 3.1 video tracking: $0.20 per 1,000 frames processed, and every video request is billed at
// least 50 frames (a 10-frame clip measured video_frames_processed 50).
export const SAM_VIDEO_FRAME_NANOCENTS = 20_000_000;
export const SAM_VIDEO_MIN_FRAMES = 50;

// Hosted web search on Muse Spark: $2.50 per 1,000 searches, on top of the tokens.
export const WEB_SEARCH_QUERY_NANOCENTS = 250_000_000;
// The input tokens reserved for each web search the request allows. The pages a search returns
// are read as input inside the same answer, and each later step reads all of them again, so the
// input grows faster than the search count. Measured on Muse Spark on 2026-10-28 UTC: one search
// billed 2,004 input tokens and two searches 6,019 (low context) and 6,041 (medium), about 2,000
// tokens of results a search. Three searches would bill about 12,000; 8,000 a search keeps the
// reserve a worst case with room to spare.
export const WEB_SEARCH_RESERVE_TOKENS = 8_000;

// The input tokens reserved for each image sent to a text model. Meta's docs put a 1280-pixel
// image at about 1,300 to 1,500 tokens; a 400 x 300 PNG measured 167.
export const MEDIA_RESERVE_TOKENS = 1_600;
// The input tokens reserved for each 1280 x 800 browser screenshot in a computer-use step.
export const SCREENSHOT_RESERVE_TOKENS = MEDIA_RESERVE_TOKENS;
// The input tokens the platform adds to every request that carries the computer tool. Counted on
// Muse Spark at 2,082 (the same request with and without the tool); reserved with a fifth on top.
export const COMPUTER_TOOL_RESERVE_TOKENS = 2_500;
// The input tokens reserved for each PDF page. Meta's docs give no figure; a one-page US Letter
// PDF with two lines of text measured 2,524 (the page image plus its extracted text), so a dense
// page gets room on top of that.
export const PDF_PAGE_RESERVE_TOKENS = 4_000;
// Meta reads page images from the first 50 pages of a PDF.
export const PDF_MAX_PAGES = 50;
// The input tokens reserved for a video sent to a text model. Meta's docs give no rate, and the
// token-count endpoint does not count video (it answered 436 for a clip billed 4,959). Measured
// on the 18-second, 144-frame demo clip: 4,959 input tokens, about 4,550 of them video. Whether
// the rate follows seconds or frames is not documented, so the reserve takes 1.5 times the
// measured figure for both (253 per second, 32 per frame) and adds them.
export const VIDEO_SECOND_RESERVE_TOKENS = 380;
export const VIDEO_FRAME_RESERVE_TOKENS = 48;

export type TokenPrice = { unit: "tokens"; input: number; cached: number; output: number };
// SAM bills a still per image and a video per frame, with a floor per video request.
export type SegmentationPrice = {
  unit: "segmentation";
  perImage: number;
  perFrame: number;
  minFrames: number;
};
export type Price =
  | TokenPrice
  | { unit: "audio_seconds"; perSecond: number }
  | { unit: "images"; perImage: number }
  | SegmentationPrice;

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

// Keyed by target, then by the host that serves it, then by the exact model id that host lists
// (GET /v1/models for Meta). A model id missing from its host's table is refused before any
// call, so a typo in a branch variable fails closed, and a Baseten id put in the Fireworks
// variable is refused instead of reaching Fireworks. The Contributor row is priced here but never
// named by a variable: ./targets.ts swaps it in only when META_CONTRIBUTOR_MODE is "true".
const PRICES: Record<AiTarget, Partial<Record<AiProvider, Record<string, Price>>>> = {
  spark: {
    meta: {
      "muse-spark-1.3": MUSE_SPARK_STANDARD,
      "muse-spark-1.2": MUSE_SPARK_STANDARD,
      "muse-spark-1.1": MUSE_SPARK_STANDARD,
      "muse-spark-1.3-contributor": MUSE_SPARK_CONTRIBUTOR,
    },
  },
  wonder: { meta: { "muse-wonder-1.0": MUSE_WONDER } },
  spark_open: {
    // Muse Spark Open on Baseten: the same per-million prices as Muse Spark
    // (https://www.baseten.co/library/muse-spark-open/).
    baseten: { "meta-models/muse-spark-open-1026": { ...MUSE_SPARK_STANDARD } },
    // The standby host, the same per-million prices again (https://fireworks.ai/pricing):
    // serverless, US-only capacity, with the US-only premium waived for this model.
    fireworks: { "accounts/fireworks/models/muse-spark-open": { ...MUSE_SPARK_STANDARD } },
  },
  voice: {
    meta: {
      "muse-voice-transcribe-1.0": { unit: "audio_seconds", perSecond: VOICE_NANOCENTS_PER_SECOND },
    },
  },
  image: { meta: { "muse-image-1.0": { unit: "images", perImage: IMAGE_NANOCENTS } } },
  sam: {
    meta: {
      "sam-3.1": {
        unit: "segmentation",
        perImage: SAM_NANOCENTS,
        perFrame: SAM_VIDEO_FRAME_NANOCENTS,
        minFrames: SAM_VIDEO_MIN_FRAMES,
      },
    },
  },
};

// The price of one model id on one host for one target, or null when that host has no such row.
export function priceFor(target: AiTarget, provider: AiProvider, model: string): Price | null {
  const hosts = Object.hasOwn(PRICES, target) ? PRICES[target] : undefined;
  const table = hosts && Object.hasOwn(hosts, provider) ? hosts[provider] : undefined;
  return table && Object.hasOwn(table, model) ? table[model] : null;
}

// The input tokens reserved for a request's attachments.
export function mediaReserveTokens(
  images: number,
  pdfPages: number,
  video: { frames: number; durationMs: number } | null = null,
): number {
  return (
    images * MEDIA_RESERVE_TOKENS +
    pdfPages * PDF_PAGE_RESERVE_TOKENS +
    (video ? videoReserveTokens(video.frames, video.durationMs) : 0)
  );
}

// The input tokens reserved for one video: its whole seconds, rounded up, and its frames.
export function videoReserveTokens(frames: number, durationMs: number): number {
  return Math.ceil(durationMs / 1000) * VIDEO_SECOND_RESERVE_TOKENS + frames * VIDEO_FRAME_RESERVE_TOKENS;
}

// A SAM video request's cost for the frames it processed (or will process): never under the floor.
export function videoFramesCost(price: SegmentationPrice, frames: number): number {
  return Math.max(price.minFrames, frames) * price.perFrame;
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

// What the cached share of one call's input saved at list price, in nanocents: the cached tokens
// at the full input price less what they were billed. Whole numbers in, a whole number out.
export function savedByCache(price: TokenPrice, cached: number): number {
  return cached * (price.input - price.cached);
}

// The cost of any answer, from what the provider reported. Null when what was reported is not
// what this price is metered by, which settles the call as unknown with its reservation kept.
export function meteredCost(price: Price, metered: Metered): number | null {
  if (price.unit === "tokens" && metered.unit === "tokens") {
    const searches = metered.searches ?? 0;
    if (!Number.isSafeInteger(searches) || searches < 0) return null;
    return actualCost(price, metered.usage) + searches * WEB_SEARCH_QUERY_NANOCENTS;
  }
  if (price.unit === "audio_seconds" && metered.unit === "audio_seconds") {
    return metered.seconds * price.perSecond;
  }
  if (price.unit === "images" && metered.unit === "images") return metered.count * price.perImage;
  if (price.unit === "segmentation" && metered.unit === "images") {
    return metered.count * price.perImage;
  }
  if (price.unit === "segmentation" && metered.unit === "video_frames") {
    return videoFramesCost(price, metered.count);
  }
  return null;
}

// AI_SPEND_CAP_CENTS as nanocents, or null when it is unset, not a whole number of cents, zero,
// or above the ceiling. Null refuses every call.
export function capNanocents(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,5}$/.test(value)) return null;
  const cents = Number(value);
  if (cents > CAP_CEILING_CENTS) return null;
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
