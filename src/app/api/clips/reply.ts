import { NextResponse } from "next/server";
import type { ClipFailure, ClipRefusal } from "@/lib/clips/types";

// The clip routes' shared replies: categories only, a fixed HTTP status per category, never cached.

export const REFUSAL_STATUS: Readonly<Record<ClipRefusal, number>> = {
  disabled: 409,
  too_large: 413,
  unsupported: 415,
  too_long: 422,
  mismatch: 422,
  unchanged: 422,
  limit: 429,
  duplicate: 409,
  not_found: 404,
  busy: 409,
  failed: 409,
  budget: 409,
  not_ready: 409,
  conflict: 409,
  store_failed: 503,
  read_failed: 503,
};

export function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function refuse(failure: ClipFailure) {
  const body: Record<string, unknown> = { error: failure.category, retryable: failure.retryable };
  if (failure.clipId) body.clipId = failure.clipId;
  return reply(body, REFUSAL_STATUS[failure.category] ?? 409);
}

// A thrown error: a membership refusal is 403, anything else a retryable 503. Only the error's
// name reaches the log.
export function failed(step: string, err: unknown) {
  if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
  console.error("clip step failed:", step, err instanceof Error ? err.name : "unknown");
  return reply({ error: "unavailable", retryable: true }, 503);
}

// A read from another site is refused (a direct visit, "none", is the person themselves).
export function isForeignRead(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

// The body, read up to max bytes and no further. Null when it is longer (or unreadable): the
// caller answers too_large without holding more than max in memory.
export async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > max)) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
