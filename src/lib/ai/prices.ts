import type { AiProvider, AiUsage } from "./types";

// Prices in nanocents per token (1 cent = 1,000,000,000 nanocents), so every listed price is an
// exact integer. $1.25 per million tokens is 125 cents / 1,000,000 = 125,000 nanocents a token.
// The $150 credit is 1.5e13 nanocents, far under 2^53, so every sum stays a safe integer through
// the pg parser and the Data API's JSON.
export const NANOCENTS_PER_CENT = 1_000_000_000;

// The Meta credit, in cents. A cap above it is refused: the vendor's spend limit only notifies.
export const CREDIT_CENTS = 15_000;

export type Price = { input: number; cached: number; output: number };

// Meta Standard tier (https://dev.meta.ai/docs/pricing-rate-limits): $1.25 input, $0.15 cached
// input, $4.25 output per million. Reasoning tokens are inside output_tokens and billed at the
// output rate, so they need no term of their own.
const MUSE_SPARK_STANDARD: Price = { input: 125_000, cached: 15_000, output: 425_000 };

// Standard models only: the contributor tier lets Meta train on prompts and outputs, so moving
// to it is a code change, not a variable. A model id missing here is refused before any call.
const PRICES: Record<AiProvider, Record<string, Price>> = {
  meta: {
    "muse-spark-1.3": MUSE_SPARK_STANDARD,
    "muse-spark-1.2": MUSE_SPARK_STANDARD,
    "muse-spark-1.1": MUSE_SPARK_STANDARD,
  },
  // Muse Spark Open on Baseten: the same per-million prices.
  baseten: {
    "meta-models/muse-spark-open-1026": { input: 125_000, cached: 15_000, output: 425_000 },
  },
};

export function priceFor(provider: AiProvider, model: string): Price | null {
  const table = PRICES[provider];
  return Object.hasOwn(table, model) ? table[model] : null;
}

// The worst case, reserved before the call: a generous guess at the input (a token per three
// bytes of the request body; English runs about four characters a token) plus every output token
// the call may produce.
export function estimateReserve(
  price: Price,
  requestBytes: number,
  maxOutputTokens: number,
): number {
  return Math.ceil(requestBytes / 3) * price.input + maxOutputTokens * price.output;
}

// What the provider charges for the usage it reported. Cached input is part of input.
export function actualCost(price: Price, usage: AiUsage): number {
  return (
    (usage.input - usage.cached) * price.input +
    usage.cached * price.cached +
    usage.output * price.output
  );
}

// AI_SPEND_CAP_CENTS as nanocents, or null when it is unset, not a whole number of cents, zero,
// or above the credit. Null refuses every call.
export function capNanocents(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]{0,5}$/.test(value)) return null;
  const cents = Number(value);
  if (cents > CREDIT_CENTS) return null;
  return cents * NANOCENTS_PER_CENT;
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
