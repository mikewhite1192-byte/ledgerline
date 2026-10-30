import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { runCashCheck } from "@/lib/cash/check";
import { isCrossSite } from "@/lib/http/same-site";

// POST: "Check Friday's cash" on the Cash page. No body. Works out Friday's position from the
// carrier's own records, stores it, and makes or refreshes the cards; answers { checkId }. Nothing
// here approves, pays or sends: each card waits for a person on the page.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// One status per refusal; the page shows a fixed sentence for each.
const STATUS: Readonly<Record<string, number>> = {
  disabled: 409,
  no_tenant: 403,
  balance_missing: 409,
  balance_in_future: 409,
  no_open_period: 409,
  more_than_one_open_period: 409,
  pay_run_unknown: 409,
};

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here and again inside runCashCheck.
  if (!flags.cashFridayEnabled) return reply({ error: "disabled" }, STATUS.disabled);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  try {
    const result = await runCashCheck(session, new Date());
    if (!result.ok) return reply({ error: result.category }, STATUS[result.category] ?? 409);
    return reply({ checkId: result.checkId }, 200);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    // The error's name only; its text can echo a row.
    console.error(`cash check failed: ${err instanceof Error ? err.name : "unknown"}`);
    return reply({ error: "unavailable", retryable: true }, 503);
  }
}
