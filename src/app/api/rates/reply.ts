import { NextResponse } from "next/server";

// What the rates routes share: no-store answers, one status per category (categories only, never a
// page's text or an upstream error), and the error path that logs the error's name only.

const STATUS: Readonly<Record<string, number>> = {
  disabled: 409,
  bad_request: 400,
  forbidden: 403,
  // The carrier used its lookups for the rolling day.
  limit: 429,
  // The rate to pin is not this carrier's, or does not exist.
  not_found: 404,
  // The rate was pinned or changed since the page was read: read it again.
  changed: 409,
  // The search ran but no page it returned carried the rate: nothing was kept.
  no_source: 422,
  // The spend cap, a switch or the call's own cost cap turned the lookup down.
  budget: 503,
  failed: 503,
};

export function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function refused(category: string) {
  const retryable = category === "failed" || category === "no_source";
  return reply({ error: category, retryable }, STATUS[category] ?? 409);
}

export function failed(what: string, err: unknown) {
  console.error(`${what} failed: ${err instanceof Error ? err.name : "unknown"}`);
  return reply({ error: "failed", retryable: true }, 503);
}

// A JSON object body, or null for anything else (bad JSON, an array, too big).
export async function objectBody(request: Request, maxChars = 4_000): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length === 0 || text.length > maxChars) return null;
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
