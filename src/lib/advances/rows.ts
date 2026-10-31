import type { Queryable } from "../db";
import { isCanonicalUuid } from "../money/keys";
import type { AdvanceSource, AdvanceStatus } from "../rules-engine/types";
import { isParkReason, type ParkReason } from "./parking";

// A flow advance as the executor reads it: one advances row born from an approved proposal
// (proposal_id set). Seeded advances are history and never come back through the flow readers,
// so nothing in the flow can re-pay or re-post them; the pages read any row as a view. Every statement names its tenant, as the admin
// login would need it to (db/README.md).

// Any advances row as the pages show it; seeded history has no proposal.
export type AdvanceView = {
  id: string;
  driverId: string;
  proposalId: string | null;
  requestRef: string;
  requestedAt: string;
  requestedOn: string;
  amountCents: number;
  feeCents: number;
  recoveredCents: number;
  status: AdvanceStatus;
  source: AdvanceSource;
  sourceInputId: string | null;
  decidedAt: string | null;
  decidedByMembershipId: string | null;
  paidAt: string | null;
  // The load it is for, and a take-back (0027): zero, nulls when nothing was taken back.
  loadId: string | null;
  takenBackCents: number;
  takenBackAt: string | null;
  takenBackByMembershipId: string | null;
  takebackReason: string | null;
  // The latest park (0079): its reason and when. Kept as history once a release pays it; null on
  // an advance that never parked.
  parkReason: ParkReason | null;
  parkedAt: string | null;
};

export type FlowAdvance = AdvanceView & { proposalId: string };

type Row = {
  id: string;
  driver_id: string;
  proposal_id: string | null;
  request_ref: string;
  requested_at: string;
  requested_on: string;
  amount_cents: number | string;
  fee_cents: number | string;
  recovered_cents: number | string;
  status: AdvanceStatus;
  source: AdvanceSource;
  source_input_id: string | null;
  decided_at: string | null;
  decided_by_membership_id: string | null;
  paid_at: string | null;
  load_id: string | null;
  taken_back_cents: number | string;
  taken_back_at: string | null;
  taken_back_by_membership_id: string | null;
  takeback_reason: string | null;
  park_reason: string | null;
  parked_at: string | null;
};

export const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;

export const FLOW_COLUMNS = [
  "id",
  "driver_id",
  "proposal_id",
  "request_ref",
  iso("requested_at"),
  "to_char(requested_on, 'YYYY-MM-DD') AS requested_on",
  "amount_cents",
  "fee_cents",
  "recovered_cents",
  "status",
  "source",
  "source_input_id",
  iso("decided_at"),
  "decided_by_membership_id",
  iso("paid_at"),
  "load_id",
  "taken_back_cents",
  iso("taken_back_at"),
  "taken_back_by_membership_id",
  "takeback_reason",
  "park_reason",
  iso("parked_at"),
].join(", ");

function whole(value: number | string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError("an amount is not whole cents");
  return n;
}

export function advanceViewOf(r: Row): AdvanceView {
  return {
    id: r.id,
    driverId: r.driver_id,
    proposalId: r.proposal_id,
    requestRef: r.request_ref,
    requestedAt: r.requested_at,
    requestedOn: r.requested_on,
    amountCents: whole(r.amount_cents),
    feeCents: whole(r.fee_cents),
    recoveredCents: whole(r.recovered_cents),
    status: r.status,
    source: r.source,
    sourceInputId: r.source_input_id,
    decidedAt: r.decided_at,
    decidedByMembershipId: r.decided_by_membership_id,
    paidAt: r.paid_at,
    loadId: r.load_id,
    takenBackCents: whole(r.taken_back_cents),
    takenBackAt: r.taken_back_at,
    takenBackByMembershipId: r.taken_back_by_membership_id,
    takebackReason: r.takeback_reason,
    // A code off the list (0079's check allows none) reads as no reason, never as a guess.
    parkReason: isParkReason(r.park_reason) ? r.park_reason : null,
    parkedAt: r.parked_at,
  };
}

async function one(q: Queryable, where: string, id: string, lock: boolean): Promise<FlowAdvance | null> {
  if (!isCanonicalUuid(id)) return null;
  const rows = await q.query<Row>(
    `SELECT ${FLOW_COLUMNS} FROM advances
      WHERE tenant_id = current_tenant_id() AND proposal_id IS NOT NULL AND ${where}
      ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (rows.length > 1) throw new RangeError("more than one advance matched");
  if (!rows[0]) return null;
  const view = advanceViewOf(rows[0]);
  if (view.proposalId === null) throw new RangeError("a flow advance has no proposal");
  return { ...view, proposalId: view.proposalId };
}

// Any of this tenant's advances by id, seeded or from the flow; null for another tenant's id.
// lock takes the row for the rest of the transaction (a take-back).
export async function readAdvanceView(q: Queryable, id: string, lock = false): Promise<AdvanceView | null> {
  if (!isCanonicalUuid(id)) return null;
  const rows = await q.query<Row>(
    `SELECT ${FLOW_COLUMNS} FROM advances WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
      ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (rows.length > 1) throw new RangeError("more than one advance matched");
  return rows[0] ? advanceViewOf(rows[0]) : null;
}

export function readFlowAdvance(q: Queryable, id: string, lock = false): Promise<FlowAdvance | null> {
  return one(q, "id = CAST($1 AS uuid)", id, lock);
}

export function readFlowAdvanceByProposal(q: Queryable, proposalId: string): Promise<FlowAdvance | null> {
  return one(q, "proposal_id = CAST($1 AS uuid)", proposalId, false);
}
