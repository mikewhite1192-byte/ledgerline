import { NextResponse } from "next/server";

// Shared by the policy run routes: JSON with no caching, and the refusal statuses. Replies carry
// categories only; never the file, never the transcript, never model text.
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
  used_elsewhere: 409,
  busy: 409,
};

export function refused(error: string) {
  return reply({ error }, REFUSAL_STATUS[error] ?? 400);
}

// A thrown error as a reply: a non-member gets forbidden, anything else unavailable. Only the
// error's name reaches the log.
export function failure(where: string, err: unknown) {
  if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
  console.error("policy run: request failed:", where, err instanceof Error ? err.name : "unknown");
  return reply({ error: "unavailable" }, 503);
}
