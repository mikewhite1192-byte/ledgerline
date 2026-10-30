import { DbError } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";

// One Home card's read: what it read, or that it could not read it. A card whose read failed
// says so; it never shows zero and never takes the page down.
export type Loaded<T> = { ok: true; value: T } | { ok: false };

// A database or membership failure makes the card unavailable. Anything else (the redirect to
// /sign-in among them) goes on to Next.
export async function loaded<T>(what: string, read: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    if (!(err instanceof DbError || err instanceof ForbiddenError)) throw err;
    console.error("home card read failed:", what, err.name);
    return { ok: false };
  }
}

// A count or a cents total from SQL. Anything but a whole, safe, non-negative number is a read
// that cannot be trusted, so it fails the card rather than showing a wrong figure.
export function wholeNumber(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new DbError("unknown");
  return n;
}
