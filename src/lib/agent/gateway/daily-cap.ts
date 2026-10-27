import { flags } from "../../../config/flags";
import type { Queryable } from "../../db";
import { cents } from "../../rules-engine";
import type { GatewayContext, LimitResult } from "./types";

// A ceiling on advance proposals per tenant per local day (flags.advancesLimits.proposalsPerDay),
// asked before the rules engine sizes the amount. It bounds what a looping or misled agent can put
// in front of a person; it never decides an amount. Over the ceiling the call is blocked as
// "budget"; a count that cannot be read is limit_unavailable (unknown is not zero).
//
// The ceiling is advisory, not hard: the count is read here and the proposal is written later in
// a separate transaction, so turns running at the same time can each pass it, overshooting by up
// to the number of concurrent turns. Money safety never depends on it: a person approves every
// payout, and the payout cap (flags.advancePayouts.capCents) is a separate check at approval.

// The tenant's local day of the call, compared in the database so the zone's rules apply.
export const DAILY_CAP_SQL =
  "SELECT CAST(count(*) AS integer) AS n FROM proposals p JOIN tenants t ON t.id = p.tenant_id" +
  " WHERE p.tenant_id = current_tenant_id() AND p.kind = 'advance_payout'" +
  " AND CAST(timezone(t.timezone, p.created_at) AS date)" +
  " = CAST(timezone(t.timezone, CAST($1 AS timestamptz)) AS date)";

// True when one more proposal would pass the ceiling. A ceiling that is not a whole number of at
// least zero counts as reached, so a broken setting blocks instead of opening the gate.
export function isOverDailyCap(count: number, cap: number): boolean {
  if (!Number.isSafeInteger(cap) || cap < 0) return true;
  if (!Number.isSafeInteger(count) || count < 0) return true;
  return count >= cap;
}

// null: under the ceiling, the engine's limit decides. Otherwise the refusal to log.
export async function advanceDailyCap(
  q: Queryable,
  ctx: GatewayContext,
  amountCents: number,
): Promise<LimitResult | null> {
  const requested = Number.isSafeInteger(amountCents) && amountCents >= 0 ? cents(amountCents) : null;
  let count: number;
  try {
    const rows = await q.query<{ n: number | string }>(DAILY_CAP_SQL, [ctx.now.toISOString()]);
    count = rows.length === 1 ? Number(rows[0].n) : Number.NaN;
  } catch {
    count = Number.NaN;
  }
  if (Number.isNaN(count)) {
    console.warn("gateway: the advance proposal count could not be read");
    return { ok: false, reason: "limit_unavailable", limitCents: null, requestedCents: requested };
  }
  if (!isOverDailyCap(count, flags.advancesLimits.proposalsPerDay)) return null;
  return { ok: false, reason: "budget", limitCents: null, requestedCents: requested };
}
