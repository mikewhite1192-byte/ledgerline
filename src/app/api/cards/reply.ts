import { NextResponse } from "next/server";
import type { RunView } from "@/lib/data/card-recon";
import { countOf } from "@/lib/recon/view";

// What the card check routes share: no-store answers, one status per category (switched off is
// 404, as if the route were not there), and the error path that logs the error's name only (never
// its text, which can echo a row).

export const CARD_STATUS: Readonly<Record<string, number>> = {
  disabled: 404,
  bad_request: 400,
  not_found: 404,
  forbidden: 403,
};

export function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function refused(category: string) {
  return reply({ error: category }, CARD_STATUS[category] ?? 409);
}

export function failed(what: string, err: unknown) {
  if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
  console.error(`${what} failed: ${err instanceof Error ? err.name : "unknown"}`);
  return reply({ error: "unavailable", retryable: true }, 503);
}

// A JSON object body, or null for anything else (bad JSON, an array, too big).
export async function objectBody(request: Request, maxChars = 2_000): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length === 0 || text.length > maxChars) return null;
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// A run as the page reads it: where it is and its counts. Nothing about a card but counts.
export function runBody(run: RunView) {
  return {
    runId: run.id,
    status: run.status,
    phase: run.phase,
    counts: {
      statement: countOf(run, "statement"),
      records: countOf(run, "records"),
      recordsClean: countOf(run, "recordsClean"),
      needsYou: countOf(run, "needsYou"),
      notConfirmed: countOf(run, "notConfirmed"),
    },
  };
}
