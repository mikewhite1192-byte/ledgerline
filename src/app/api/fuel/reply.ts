import { NextResponse } from "next/server";

// What the fuel routes share: no-store answers, one status per category (categories only, never
// a row's text), and the error path that logs the error's name only.

const STATUS: Readonly<Record<string, number>> = {
  disabled: 409,
  bad_request: 400,
  not_found: 404,
  busy: 409,
  not_configured: 503,
  forbidden: 403,
  changed: 409,
  no_suggestion: 409,
  no_open_period: 409,
  live_exists: 409,
  already_decided: 409,
  // The check stopped and wrote nothing but its failed run.
  failed: 503,
  // The findings were written but the run could not be closed: look before trying again.
  unknown: 503,
};

export function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function refused(category: string) {
  const retryable = category === "busy" || category === "failed";
  return reply({ error: category, retryable }, STATUS[category] ?? 409);
}

export function failed(what: string, err: unknown) {
  if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
  console.error(`${what} failed: ${err instanceof Error ? err.name : "unknown"}`);
  return reply({ error: "unavailable", retryable: true }, 503);
}

// A JSON object body, or null for anything else (bad JSON, an array, too big).
export async function objectBody(request: Request, maxChars = 1_000): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length === 0 || text.length > maxChars) return null;
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
