import type { RateKind } from "./candidates";

// The rates' words that both the server and the page's own form use. Pure: no reads, no switches.

// "$3.657" for 365,700 thousandths of a cent; a fuel tax rate keeps four decimals ("$0.2850").
export function perGallonText(kind: RateKind, mcents: number): string {
  if (!Number.isSafeInteger(mcents) || mcents < 0) throw new RangeError("not a rate");
  const min = kind === "ifta_rate" ? 4 : 3;
  const whole = Math.floor(mcents / 100_000);
  let frac = String(mcents % 100_000).padStart(5, "0");
  while (frac.length > min && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `$${whole}.${frac}`;
}

// A typed rate in dollars per gallon ("3.657", "0.285", "4") as thousandths of a cent, or null.
export function parseRate(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = /^(\d{1,2})(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 100_000 + Number((m[2] ?? "").padEnd(5, "0"));
}
