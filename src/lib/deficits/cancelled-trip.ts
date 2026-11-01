import type { GatewayRef } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { readRowsWhereId } from "../data/read";
import { advanceOf } from "../data/records";
import type { Queryable } from "../db";
import { readTenantZone } from "../money/read";
import { persistEngineProposal, type EngineDraft } from "../proposals/engine";
import { outstandingCents, type AdvanceRecord } from "../rules-engine";
import { localDateOf } from "../time/local-date";
import { isUuid } from "../uuid";
import { cancelledTripEnabled, cancelledTripOn } from "./switches";

// CANCELLED-TRIP (S6c, A10): a load a person cancelled after its driver was paid an advance on it.
// The trip will never be paid, so the advance can never be earned back from that load's pay. For
// each paid advance on the load that is still owed, the desk drafts one deficit_book card for a
// person to approve. Approving it (src/lib/proposals/executors/deficit-book.ts) closes the advance
// line and books the same cents as a named deficit (source cancelled_trip) in one transaction, so
// the driver owes them exactly once, and deficit recovery takes them back from later pay. Nothing
// here moves money or sends anything; the model never drafts this card.
//
// The rules engine decides the number: outstandingCents over the engine's AdvanceRecord (amount and
// fee, less what pay recovered and what was taken back), whole cents. A paid advance with nothing
// owed, an advance not paid yet, or one already taken back drafts nothing.
//
// One card per advance, ever. The load row is locked first (FOR UPDATE), so two runs on one cancel
// take turns and the second finds the first's card; an advance that has a deficit_book card in any
// status, or a cancelled_trip deficit, gets none. persistEngineProposal's dedupe_key (kind, the
// advance and the canonical args, which name the load event) and proposals_one_live_per_subject
// (one live card per kind and advance) back that up in the database. An advance a card pull-back
// is taking back right now (a pull issuing or unknown) is left to the pull.
//
// Called from the desk loop's load_event source, once per recorded move (its desk_log key is
// load_event:<load_events.id>). The switch and the start date are asked here on every call.

export type CancelledTripOutcome =
  | { kind: "proposed"; proposalIds: string[] }
  | { kind: "nothing"; category: CancelledTripSkip };

export type CancelledTripSkip =
  | "switched_off"
  | "before_start"
  | "not_found"
  | "not_cancel"
  | "not_cancelled"
  | "no_advance"
  | "already_drafted";

type EventRow = { load_id: string; to_status: string; at: string; created_at: string };
type LoadRow = { id: string; load_number: string; status: string };

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const EVENT_SQL = `SELECT CAST(load_id AS text) AS load_id, to_status, ${ts("at")} AS at, ${ts("created_at")} AS created_at
  FROM load_events WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`;

const LOCK_LOAD_SQL = `SELECT CAST(id AS text) AS id, load_number, status
  FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`;

// Any deficit_book card for this advance, in any status.
const CARD_SQL = `SELECT 1 AS one FROM proposals
  WHERE tenant_id = current_tenant_id() AND kind = 'deficit_book' AND subject_table = 'advances'
    AND subject_id = CAST($1 AS uuid) LIMIT 1`;

// A cancelled-trip deficit already booked on this advance (driver_deficits_one_per_source).
export const DEFICIT_SQL = `SELECT 1 AS one FROM driver_deficits
  WHERE tenant_id = current_tenant_id() AND source_kind = 'cancelled_trip' AND source_id = CAST($1 AS uuid) LIMIT 1`;

// A card pull-back taking this advance back right now (data/read.ts NO_LIVE_PULL's rule).
export const LIVE_PULL_SQL = `SELECT 1 AS one FROM card_pullbacks
  WHERE tenant_id = current_tenant_id() AND advance_id = CAST($1 AS uuid) AND status IN ('issuing', 'unknown') LIMIT 1`;

// Oldest request first, then by id, so the cards come in one order on every run.
function byRequest(x: AdvanceRecord, y: AdvanceRecord): number {
  if (x.requestedAt !== y.requestedAt) return x.requestedAt < y.requestedAt ? -1 : 1;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

const nothing = (category: CancelledTripSkip): CancelledTripOutcome => ({ kind: "nothing", category });

const exists = async (q: Queryable, sql: string, id: string): Promise<boolean> => (await q.query(sql, [id])).length > 0;

// Inside a tenant transaction the caller holds, after assertMembership.
export async function proposeCancelledTripDeficit(
  q: Queryable,
  session: Session,
  loadEventId: string,
  now: Date,
): Promise<CancelledTripOutcome> {
  if (!cancelledTripEnabled()) return nothing("switched_off");
  if (!isUuid(loadEventId)) return nothing("not_found");
  const [event] = await q.query<EventRow>(EVENT_SQL, [loadEventId]);
  if (!event) return nothing("not_found");
  if (event.to_status !== "cancelled") return nothing("not_cancel");

  // A cancel that happened or was recorded before the start date (the carrier's local midnight)
  // drafts nothing, so turning this on never reaches back to loads cancelled before.
  const zone = await readTenantZone(q);
  for (const instant of [event.at, event.created_at, now.toISOString()]) {
    if (!cancelledTripOn(localDateOf(instant, zone))) return nothing("before_start");
  }

  const [load] = await q.query<LoadRow>(LOCK_LOAD_SQL, [event.load_id]);
  if (!load) return nothing("not_found");
  if (load.status !== "cancelled") return nothing("not_cancelled");

  // The load's advances, oldest request first, as the engine reads them.
  const rows = await readRowsWhereId(q, "advances", "load_id", load.id);
  const owed = rows
    .filter((r) => r.status === "paid" && r.taken_back_at === null)
    .map((r) => ({ record: advanceOf(r), cents: Number(outstandingCents(advanceOf(r))) }))
    .filter((a) => Number.isSafeInteger(a.cents) && a.cents > 0)
    .sort((x, y) => byRequest(x.record, y.record));
  if (owed.length === 0) return nothing("no_advance");

  const proposalIds: string[] = [];
  for (const { record, cents } of owed) {
    if (await exists(q, CARD_SQL, record.id)) continue;
    if (await exists(q, DEFICIT_SQL, record.id)) continue;
    if (await exists(q, LIVE_PULL_SQL, record.id)) continue;
    const sources: GatewayRef[] = [
      { table: "loads", id: load.id },
      { table: "advances", id: record.id },
      { table: "drivers", id: record.driverId },
    ];
    const draft: EngineDraft = {
      kind: "deficit_book",
      subjectTable: "advances",
      subjectId: record.id,
      amountCents: cents,
      args: {
        driverId: record.driverId,
        advanceId: record.id,
        loadId: load.id,
        loadEventId,
        amountCents: cents,
        sourceKind: "cancelled_trip",
      },
      exceptions: [],
      reasons: ["load_cancelled"],
      sources,
      operatorVerdict: "cancelled_trip",
    };
    const r = await persistEngineProposal(q, draft, session, now);
    if (r.kind === "created") proposalIds.push(r.proposalId);
  }
  if (proposalIds.length === 0) return nothing("already_drafted");
  return { kind: "proposed", proposalIds };
}
