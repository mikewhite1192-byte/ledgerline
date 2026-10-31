import { flags } from "../../config/flags";
import { DAILY_CAP_SQL, isOverDailyCap } from "../agent/gateway/daily-cap";
import type { Session } from "../auth/claims";
import { readAdvanceInput } from "../data/read";
import type { Queryable } from "../db";
import { readTenantZone } from "../money/read";
import { persistEngineProposal, type EngineDraft } from "../proposals/engine";
import { advanceEligibility, cents } from "../rules-engine";
import { isLocalDate, localDateOf, type LocalDate } from "../time/local-date";
import { isUuid } from "../uuid";
import { advancesOn } from "./switches";

// ADVANCE-AT-PICKUP: when a load moves to in transit and its carrier's advances unlock at pickup
// (pay_configs.advance_unlock_stage = 'picked_up', 0073), draft one advance_payout card for the
// load's driver, for a person to approve. Nothing is paid here: the card goes through the same
// approval gate, payout switches and money_armed check as any advance, and the executor sizes it
// again when a person approves.
//
// The rules engine decides every number. The amount is the engine's suggestion when asked for the
// whole per-load headroom: advanceEligibility({ ...input, amountCents: headroom }).suggestedCents,
// so every other cap still applies (the driver's limit, the share of earned pay, the minimum, the
// fee) and the result is whole dollars. The card is written only when that same amount is
// eligible on its own. A suggestion of zero or a refusal writes nothing.
//
// One card per load, ever: a load that already has an advance_payout card (any status, either
// origin) gets no second one, and a driver with a live advance card (proposed, approved or
// executing) gets none, so this never retires a card someone is looking at. The proposal's
// dedupe_key (kind, driver and the canonical args, which name the load and the move) and
// proposals_one_live_per_subject (0009: one live advance per driver) back that up in the
// database. The load row is locked first, so two runs on one load take turns.
//
// Called from the desk loop's load_event source, once per recorded move (its desk_log key is
// load_event:<load_events.id>). Every path re-asks its own switch and start date here.

export type AtPickupOutcome =
  | { kind: "proposed"; proposalId: string; amountCents: number }
  | { kind: "nothing"; category: AtPickupSkip };

export type AtPickupSkip =
  | "switched_off"
  | "before_start"
  | "not_found"
  | "not_pickup"
  | "not_in_transit"
  | "no_driver"
  | "stage_delivered"
  | "no_load_cap"
  | "load_has_card"
  | "live_card"
  | "daily_cap"
  | "nothing_to_advance"
  | "engine_refused"
  | "duplicate"
  | "already_decided";

// Whether the advance at pickup may draft for a move recorded on `day` (the carrier's local date).
export function atPickupOn(day: LocalDate): boolean {
  const s = flags.advanceAtPickup;
  return s.enabled === true && isLocalDate(s.startDate) && day >= s.startDate && advancesOn();
}

type EventRow = { load_id: string; to_status: string; at: string; created_at: string };
type LoadRow = { id: string; load_number: string; status: string; driver_id: string | null };

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const EVENT_SQL = `SELECT CAST(load_id AS text) AS load_id, to_status, ${ts("at")} AS at, ${ts("created_at")} AS created_at
  FROM load_events WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`;

const LOCK_LOAD_SQL = `SELECT CAST(id AS text) AS id, load_number, status, CAST(driver_id AS text) AS driver_id
  FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`;

// Any advance card for this load, in any status and from either origin.
const LOAD_CARD_SQL = `SELECT 1 AS one FROM proposals
  WHERE tenant_id = current_tenant_id() AND kind = 'advance_payout' AND args->>'loadId' = $1 LIMIT 1`;

// A live advance card for this driver.
const LIVE_CARD_SQL = `SELECT 1 AS one FROM proposals
  WHERE tenant_id = current_tenant_id() AND kind = 'advance_payout' AND subject_id = CAST($1 AS uuid)
    AND status IN ('proposed', 'approved', 'executing') LIMIT 1`;

const nothing = (category: AtPickupSkip): AtPickupOutcome => ({ kind: "nothing", category });

// Inside a tenant transaction the caller holds, after assertMembership.
export async function proposeAdvanceAtPickup(
  q: Queryable,
  session: Session,
  loadEventId: string,
  now: Date,
): Promise<AtPickupOutcome> {
  if (flags.advanceAtPickup.enabled !== true || !advancesOn()) return nothing("switched_off");
  if (!isUuid(loadEventId)) return nothing("not_found");
  const [event] = await q.query<EventRow>(EVENT_SQL, [loadEventId]);
  if (!event) return nothing("not_found");
  if (event.to_status !== "in_transit") return nothing("not_pickup");

  // A move that happened or was recorded before the start date (the carrier's local midnight)
  // drafts nothing, so turning this on never reaches back to loads already on the road.
  const zone = await readTenantZone(q);
  const nowIso = now.toISOString();
  for (const instant of [event.at, event.created_at, nowIso]) {
    if (!atPickupOn(localDateOf(instant, zone))) return nothing("before_start");
  }

  const [load] = await q.query<LoadRow>(LOCK_LOAD_SQL, [event.load_id]);
  if (!load) return nothing("not_found");
  if (load.status !== "in_transit") return nothing("not_in_transit");
  if (load.driver_id === null) return nothing("no_driver");
  const driverId = load.driver_id;

  if ((await q.query(LOAD_CARD_SQL, [load.id])).length > 0) return nothing("load_has_card");
  if ((await q.query(LIVE_CARD_SQL, [driverId])).length > 0) return nothing("live_card");

  // The tenant's daily ceiling on advance cards (flags.advancesLimits.proposalsPerDay), as the
  // agent's propose_advance asks it. A count that cannot be read throws: unknown is not zero.
  const counted = await q.query<{ n: number | string }>(DAILY_CAP_SQL, [nowIso]);
  const count = counted.length === 1 ? Number(counted[0].n) : Number.NaN;
  if (!Number.isSafeInteger(count)) throw new Error("the advance card count could not be read");
  if (isOverDailyCap(count, flags.advancesLimits.proposalsPerDay)) return nothing("daily_cap");

  const input = await readAdvanceInput(q, driverId, nowIso, 0, load.id);
  if (!input.load) return nothing("not_found");
  if (input.config.advanceUnlockStage !== "picked_up") return nothing("stage_delivered");
  const sized = advanceEligibility(input);
  if (sized.loadHeadroomCents === null || sized.loadCapCents === null) return nothing("no_load_cap");
  const suggested = advanceEligibility({ ...input, amountCents: sized.loadHeadroomCents }).suggestedCents;
  if (suggested <= 0) return nothing("nothing_to_advance");
  const decision = advanceEligibility({ ...input, amountCents: cents(suggested) });
  if (!decision.eligible || decision.approvedCents !== suggested) return nothing("engine_refused");

  const shareBps = input.config.advancePerLoadBpsOfPay;
  if (shareBps === null) return nothing("no_load_cap");
  const draft: EngineDraft = {
    kind: "advance_payout",
    subjectTable: "drivers",
    subjectId: driverId,
    amountCents: suggested,
    args: {
      driverId,
      amountCents: suggested,
      requestedOn: input.requestedOn,
      operatorVerdict: "eligible",
      loadId: load.id,
      loadEventId,
      load: { number: load.load_number, capCents: null, leftAfterCents: null, shareBps },
    },
    exceptions: [],
    reasons: ["load_picked_up"],
    // The engine's own refs, the load among them, so the engine check recomputes the same advance.
    sources: decision.sources,
    operatorVerdict: "at_pickup",
  };
  const r = await persistEngineProposal(q, draft, session, now);
  if (r.kind === "created") return { kind: "proposed", proposalId: r.proposalId, amountCents: suggested };
  if (r.kind === "duplicate") return nothing("duplicate");
  if (r.kind === "already_decided") return nothing("already_decided");
  return nothing("live_card");
}
