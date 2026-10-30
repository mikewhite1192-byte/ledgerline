import { NextResponse } from "next/server";

// Shared by the document routes: JSON with no caching, and the refusal statuses.
export function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  disabled: 404,
  not_found: 404,
  too_large: 413,
  unsupported: 415,
  too_many_pages: 422,
  limit: 429,
  already_read: 409,
  in_progress: 409,
  attempt_limit: 429,
  // The marked copy (markup route).
  not_image: 422,
  not_read: 409,
  not_matched: 409,
  agrees: 409,
  no_anchor_line: 422,
  already_checked: 409,
  budget: 503,
};

// A thrown error as a reply: a non-member gets forbidden, anything else unavailable. Only the
// error's name reaches the log.
export function failure(where: string, err: unknown) {
  if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
  console.error("documents: request failed:", where, err instanceof Error ? err.name : "unknown");
  return reply({ error: "unavailable" }, 503);
}
