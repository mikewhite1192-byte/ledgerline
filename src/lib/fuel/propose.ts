import { flags } from "../../config/flags";
import type { GatewayRef } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { readCheckInput } from "../data/read";
import { getDb, type Queryable, type TenantDb } from "../db";
import { persistEngineProposal } from "../proposals/engine";
import { runFuelChecks } from "../rules-engine/fuel";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { DISMISS_CATEGORIES, type DismissCategory } from "./help";

// A finding's two actions (FUEL-ANOMALY design 4.2). Propose drafts the engine's pay correction as
// an ordinary pay_correction card (origin 'engine'): a person approves it on the card, and only
// then does the executor write the pay line, re-checking the open week and the limit itself. The
// engine is run again first, so the card carries today's numbers or none. Dismiss records a
// person's reason. Neither moves money.

export type FuelActionDeps = { db?: TenantDb; clock?: () => Date };

export type ProposeResult =
  | { ok: true; proposalId: string; existing: boolean }
  | {
      ok: false;
      category:
        | "disabled"
        | "not_configured"
        | "bad_request"
        | "not_found"
        | "changed"
        | "no_suggestion"
        | "no_open_period"
        | "live_exists"
        | "already_decided";
    };

export type DismissResult =
  | { ok: true }
  | { ok: false; category: "disabled" | "bad_request" | "not_found" | "changed" };

type FindingRow = {
  id: string;
  finding_key: string;
  category: string;
  status: string;
  driver_id: string;
  pay_item_id: string | null;
  purchased_on: string;
  suggested_cents: number | string | null;
  proposal_id: string | null;
};

function correctionCap(): number | null {
  const a = flags.fuelAnomalyLimits.chargebackMaxCents;
  const b = flags.gatewayLimits.payCorrectionMaxCents;
  if (!Number.isSafeInteger(a) || a <= 0 || !Number.isSafeInteger(b) || b <= 0) return null;
  return Math.min(a, b);
}

// The open week the correction belongs in. A correction that takes back a pay line goes in the
// open week that holds the line (the executor needs it there); any other in the open week that
// holds the fill-up, else the only open week.
async function openPeriodFor(q: Queryable, payItemId: string | null, purchasedOn: string): Promise<string | null> {
  const periods = await q.query<{ id: string; period_start: string; period_end: string }>(
    `SELECT id, CAST(period_start AS text) AS period_start, CAST(period_end AS text) AS period_end
       FROM settlement_periods WHERE status = 'open' ORDER BY period_start, id`,
  );
  const within = (day: string) => periods.filter((p) => p.period_start <= day && day <= p.period_end);
  if (payItemId !== null) {
    const items = await q.query<{ item_date: string; settlement_id: string | null }>(
      "SELECT CAST(item_date AS text) AS item_date, settlement_id FROM pay_items WHERE id = CAST($1 AS uuid)",
      [payItemId],
    );
    if (items.length !== 1 || items[0].settlement_id !== null) return null;
    const hit = within(items[0].item_date);
    return hit.length === 1 ? hit[0].id : null;
  }
  const hit = within(purchasedOn);
  if (hit.length === 1) return hit[0].id;
  return periods.length === 1 ? periods[0].id : null;
}

export async function proposeFuelCorrection(
  session: Session,
  findingId: string,
  deps: FuelActionDeps = {},
): Promise<ProposeResult> {
  // The switch is read here, not only by the route.
  if (!flags.fuelAnomalyEnabled) return { ok: false, category: "disabled" };
  if (!isUuid(findingId)) return { ok: false, category: "bad_request" };
  const cap = correctionCap();
  if (cap === null) return { ok: false, category: "not_configured" };
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  const id = findingId.toLowerCase();

  return db.withTenant(session.tenantId, async (q): Promise<ProposeResult> => {
    await assertMembership(q, session);
    const rows = await q.query<FindingRow>(
      `SELECT id, finding_key, category, status, driver_id, pay_item_id, CAST(purchased_on AS text) AS purchased_on,
              suggested_cents, proposal_id
         FROM fuel_findings WHERE id = CAST($1 AS uuid)
          FOR UPDATE`,
      [id],
    );
    const f = rows[0];
    if (!f) return { ok: false, category: "not_found" };
    // A repeat of a propose that went through answers with the same card.
    if (f.status === "proposed" && f.proposal_id) return { ok: true, proposalId: f.proposal_id, existing: true };
    if (f.status !== "open") return { ok: false, category: "changed" };
    if (f.suggested_cents === null) return { ok: false, category: "no_suggestion" };
    const stored = Number(f.suggested_cents);
    if (!Number.isSafeInteger(stored) || stored === 0 || Math.abs(stored) > cap) {
      return { ok: false, category: "no_suggestion" };
    }

    // The engine again, on today's records: the card carries its numbers or none.
    const fresh = runFuelChecks(await readCheckInput(q), flags.fuelAnomalyLimits).find(
      (x) => x.findingKey === f.finding_key,
    );
    if (
      !fresh ||
      fresh.suggestedCents !== stored ||
      fresh.driverId !== f.driver_id ||
      fresh.category !== f.category ||
      (fresh.payItemId ?? null) !== (f.pay_item_id ?? null)
    ) {
      return { ok: false, category: "changed" };
    }

    const periodId = await openPeriodFor(q, fresh.payItemId, fresh.purchasedOn);
    if (!periodId) return { ok: false, category: "no_open_period" };

    // One live pay correction per driver. Another finding's card, the sweep's or the agent's is
    // never replaced from here: the person decides that one first.
    const live = await q.query<{ id: string; finding: string | null }>(
      `SELECT id, args->>'findingId' AS finding FROM proposals
        WHERE kind = 'pay_correction' AND subject_id = CAST($1 AS uuid)
          AND status IN ('proposed', 'approved', 'executing')`,
      [fresh.driverId],
    );
    if (live.some((p) => p.finding !== id)) return { ok: false, category: "live_exists" };

    const args: Record<string, unknown> = {
      driverId: fresh.driverId,
      periodId,
      deltaCents: stored,
      reasonCategories: [fresh.category],
      findingId: id,
    };
    if (fresh.payItemId) args.payItemId = fresh.payItemId;
    const persisted = await persistEngineProposal(
      q,
      {
        kind: "pay_correction",
        subjectTable: "drivers",
        subjectId: fresh.driverId,
        amountCents: stored,
        args,
        exceptions: [],
        reasons: [fresh.category],
        sources: fresh.sources.map((s): GatewayRef => ({ table: s.table, id: s.id })),
      },
      session,
      now,
    );
    if (persisted.kind === "live_exists") return { ok: false, category: "live_exists" };
    if (persisted.kind === "already_decided") return { ok: false, category: "already_decided" };
    const moved = await q.execute(
      `UPDATE fuel_findings SET status = 'proposed', proposal_id = CAST($2 AS uuid), updated_at = CAST($3 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status = 'open'`,
      [id, persisted.proposalId, now.toISOString()],
    );
    if (moved !== 1) throw new Error("the fuel finding did not move to proposed");
    return { ok: true, proposalId: persisted.proposalId, existing: persisted.kind === "duplicate" };
  });
}

export function isDismissCategory(value: unknown): value is DismissCategory {
  return typeof value === "string" && (DISMISS_CATEGORIES as readonly string[]).includes(value);
}

export async function dismissFuelFinding(
  session: Session,
  findingId: string,
  category: unknown,
  deps: FuelActionDeps = {},
): Promise<DismissResult> {
  if (!flags.fuelAnomalyEnabled) return { ok: false, category: "disabled" };
  if (!isUuid(findingId) || !isDismissCategory(category)) return { ok: false, category: "bad_request" };
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  const id = findingId.toLowerCase();

  return db.withTenant(session.tenantId, async (q): Promise<DismissResult> => {
    await assertMembership(q, session);
    const moved = await q.execute(
      `UPDATE fuel_findings SET status = 'dismissed', dismiss_category = $2, updated_at = CAST($3 AS timestamptz)
        WHERE id = CAST($1 AS uuid) AND status = 'open'`,
      [id, category, now.toISOString()],
    );
    if (moved === 1) return { ok: true };
    const rows = await q.query<{ status: string; dismiss_category: string | null }>(
      "SELECT status, dismiss_category FROM fuel_findings WHERE id = CAST($1 AS uuid)",
      [id],
    );
    if (!rows[0]) return { ok: false, category: "not_found" };
    // A repeat of the same dismissal is the same answer.
    if (rows[0].status === "dismissed" && rows[0].dismiss_category === category) return { ok: true };
    return { ok: false, category: "changed" };
  });
}
