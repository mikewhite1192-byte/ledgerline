import { NextResponse } from "next/server";

// What the sweep routes share: no-store answers, one status per category, and the error path
// that logs the error's name only (never its text, which can echo a row).

export const SWEEP_STATUS: Readonly<Record<string, number>> = {
  disabled: 409,
  schedule_off: 409,
  bad_request: 400,
  not_found: 404,
  no_open_period: 409,
  busy: 409,
  not_configured: 503,
  role: 403,
  forbidden: 403,
  changed: 409,
  batch_taken: 409,
};

export function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function refused(category: string, extra: Record<string, unknown> = {}) {
  const retryable = category === "busy" || category === "not_configured";
  return reply({ error: category, retryable, ...extra }, SWEEP_STATUS[category] ?? 409);
}

export function failed(what: string, err: unknown) {
  if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
  console.error(`${what} failed: ${err instanceof Error ? err.name : "unknown"}`);
  return reply({ error: "unavailable", retryable: true }, 503);
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
