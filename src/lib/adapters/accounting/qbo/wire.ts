import { MoneyError } from "../../../money/types";

// The JSON that crosses to QuickBooks: amounts written as exact decimals, and the error codes of
// a Fault reply. Pure.

// Decimal amounts go into a body as this marker and come out as a plain JSON number written from
// the decimal text, so no float ever carries money. Field values are refused if they hold a
// control character, so the marker cannot be forged by data.
const DEC = "\u0000dec:";
export function decimalField(text: string): string {
  if (!/^-?\d{1,10}\.\d{2}$/.test(text)) throw new MoneyError("validation");
  return `${DEC}${text}\u0000`;
}
export function bodyJson(body: unknown): string {
  return JSON.stringify(body).replace(/"\\u0000dec:(-?\d{1,10}\.\d{2})\\u0000"/g, "$1");
}

export function faultCodes(body: unknown): { type: string; codes: string[] } {
  const fault =
    typeof body === "object" && body !== null ? (body as { Fault?: unknown }).Fault : undefined;
  if (typeof fault !== "object" || fault === null) return { type: "", codes: [] };
  const f = fault as { type?: unknown; Error?: unknown };
  const errors = Array.isArray(f.Error) ? f.Error : [];
  const codes = errors
    .map((e) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : null))
    .filter((c): c is string => typeof c === "string" && /^[0-9A-Za-z_-]{1,20}$/.test(c))
    .slice(0, 5);
  const type = typeof f.type === "string" && /^[A-Za-z]{1,40}$/.test(f.type) ? f.type : "";
  return { type, codes };
}
