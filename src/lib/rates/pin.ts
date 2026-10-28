import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { tenantLock } from "../invoices/number";
import { isUuid } from "../uuid";
import { httpsUrl, isPlausible, RATE_KINDS, type RateKind } from "./candidates";
import { parseRate } from "./format";
import { carrierToday, effectiveDayOk, memberOf } from "./read";
import { isRateState } from "./states";

// Pinning (GROUNDED-RATES design 4.2): the only path to a rate anything may use. An admin pins a
// looked-up suggestion, or types a rate from a page they link. A new pin retires the live pin of
// the same kind and state in the same transaction, under the carrier's rate lock, so there is one
// live pin at a time (the database's unique index is the backstop). The value never changes after
// pinning (the guard trigger in 0053); a correction is a new pin. Nothing is recalculated, billed
// or paid here.

export type PinRefusal = "off" | "forbidden" | "bad_request" | "not_found" | "changed";
export type PinOutcome =
  | { ok: true; id: string; already: boolean }
  | { ok: false; refused: PinRefusal }
  | { ok: false; failed: "failed" };

export type PinDeps = { db?: TenantDb; clock?: () => Date };

class Refused extends Error {
  constructor(readonly refusal: PinRefusal) {
    super(`pin refused: ${refusal}`);
    this.name = "PinRefused";
  }
}

// The admin, today in the carrier's zone and the effective day, checked, with the rate lock held.
async function adminGate(q: Queryable, session: Session, effectiveFrom: unknown, now: Date) {
  const member = await memberOf(q, session.sub);
  if (!member || member.role !== "admin") throw new Refused("forbidden");
  const day = await carrierToday(q, now);
  if (!day) throw new Refused("forbidden");
  if (!effectiveDayOk(effectiveFrom, day.today)) throw new Refused("bad_request");
  await tenantLock(q, "rate_pin");
  return { member, effectiveFrom };
}

async function retireLive(q: Queryable, kind: string, state: string | null): Promise<void> {
  await q.execute(
    `UPDATE pinned_rates SET retired_at = now()
      WHERE tenant_id = current_tenant_id() AND kind = $1 AND COALESCE(state, '--') = COALESCE(CAST($2 AS text), '--')
        AND status = 'pinned' AND retired_at IS NULL`,
    [kind, state],
  );
}

async function run(session: Session, deps: PinDeps, fn: (q: Queryable, now: Date) => Promise<PinOutcome>) {
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  try {
    return await db.withTenant(session.tenantId, (q) => fn(q, now));
  } catch (err) {
    if (err instanceof Refused) return { ok: false as const, refused: err.refusal };
    console.error(`rates: pin failed ${err instanceof Error ? err.name : "error"}`);
    return { ok: false as const, failed: "failed" as const };
  }
}

export type PinSuggestionInput = { id: unknown; effectiveFrom: unknown };

// Pin a looked-up suggestion as it is. An unconfirmed one carries no figure and cannot be pinned;
// a row that is no longer a suggestion (already pinned) is "changed".
export async function pinSuggestion(session: Session, input: PinSuggestionInput, deps: PinDeps = {}): Promise<PinOutcome> {
  if (!flags.groundedRatesEnabled) return { ok: false, refused: "off" };
  if (!isUuid(input.id)) return { ok: false, refused: "bad_request" };
  const id = input.id;
  return run(session, deps, async (q, now) => {
    const { member, effectiveFrom } = await adminGate(q, session, input.effectiveFrom, now);
    const rows = await q.query<{ kind: string; state: string | null; status: string }>(
      "SELECT kind, state, status FROM pinned_rates WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [id],
    );
    if (rows.length !== 1) throw new Refused("not_found");
    const [row] = rows;
    if (row.status !== "suggested") throw new Refused("changed");
    await retireLive(q, row.kind, row.state);
    const n = await q.execute(
      `UPDATE pinned_rates SET status = 'pinned', pinned_by = CAST($2 AS uuid), pinned_at = now(),
         effective_from = CAST($3 AS date)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'suggested'`,
      [id, member.id, effectiveFrom],
    );
    if (n !== 1) throw new Error("pin did not land");
    return { ok: true, id, already: false };
  });
}

export type PinTypedInput = {
  kind: unknown;
  state?: unknown;
  rate: unknown;
  sourceUrl: unknown;
  effectiveFrom: unknown;
};

// Pin a rate an admin typed from a page they link (for when a lookup could not match the number).
// The same live pin typed again (same value, page and day) is that pin, not a second write.
export async function pinTyped(session: Session, input: PinTypedInput, deps: PinDeps = {}): Promise<PinOutcome> {
  if (!flags.groundedRatesEnabled) return { ok: false, refused: "off" };
  if (typeof input.kind !== "string" || !(RATE_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, refused: "bad_request" };
  }
  const kind = input.kind as RateKind;
  const state = kind === "ifta_rate" ? (isRateState(input.state) ? input.state : undefined) : null;
  if (state === undefined || (kind === "diesel_index" && input.state !== undefined && input.state !== null)) {
    return { ok: false, refused: "bad_request" };
  }
  const value = parseRate(input.rate);
  const url = httpsUrl(typeof input.sourceUrl === "string" ? input.sourceUrl.trim() : input.sourceUrl);
  if (value === null || !isPlausible(kind, value) || url === null) return { ok: false, refused: "bad_request" };
  return run(session, deps, async (q, now) => {
    const { member, effectiveFrom } = await adminGate(q, session, input.effectiveFrom, now);
    const same = await q.query<{ id: string }>(
      `SELECT CAST(id AS text) AS id FROM pinned_rates
        WHERE tenant_id = current_tenant_id() AND kind = $1 AND COALESCE(state, '--') = COALESCE(CAST($2 AS text), '--')
          AND status = 'pinned' AND retired_at IS NULL AND value_mcents = $3 AND source_url = $4
          AND effective_from = CAST($5 AS date)`,
      [kind, state, value, url, effectiveFrom],
    );
    if (same.length === 1) return { ok: true, id: same[0].id, already: true };
    await retireLive(q, kind, state);
    const id = randomUUID();
    await q.execute(
      `INSERT INTO pinned_rates (id, tenant_id, kind, state, status, value_mcents, source, source_url, effective_from,
         created_by, pinned_by, pinned_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, 'pinned', $4, 'typed', $5, CAST($6 AS date),
         CAST($7 AS uuid), CAST($7 AS uuid), now())`,
      [id, kind, state, value, url, effectiveFrom, member.id],
    );
    return { ok: true, id, already: false };
  });
}
