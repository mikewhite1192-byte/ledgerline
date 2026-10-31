import type { Queryable } from "../db";
import { isCanonicalUuid } from "../money/keys";

// A card pull-back row (0080), read whole. Never the card's token: a card or a record page shows
// the last four from the proposal's args at most.

export const PULL_STATUSES = ["issuing", "pulled", "failed", "unknown"] as const;
export type PullStatus = (typeof PULL_STATUSES)[number];

export type PullRow = {
  id: string;
  driverId: string;
  cardId: string;
  proposalId: string;
  advanceId: string | null;
  reason: string;
  requestedCents: number;
  balanceCents: number;
  pullCents: number;
  shortfallCents: number;
  moneyActionId: string | null;
  status: PullStatus;
  pulledAt: string | null;
};

type Row = {
  id: string;
  driver_id: string;
  card_id: string;
  proposal_id: string;
  advance_id: string | null;
  reason: string;
  requested_cents: string;
  balance_cents: string;
  pull_cents: string;
  shortfall_cents: string;
  money_action_id: string | null;
  status: string;
  pulled_at: string | null;
};

const COLUMNS = `CAST(id AS text) AS id, CAST(driver_id AS text) AS driver_id, CAST(card_id AS text) AS card_id,
  CAST(proposal_id AS text) AS proposal_id, CAST(advance_id AS text) AS advance_id, reason,
  CAST(requested_cents AS text) AS requested_cents, CAST(balance_cents AS text) AS balance_cents,
  CAST(pull_cents AS text) AS pull_cents, CAST(shortfall_cents AS text) AS shortfall_cents,
  CAST(money_action_id AS text) AS money_action_id, status,
  to_char(pulled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS pulled_at`;

const cents = (v: string): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

// A row whose numbers or status do not read is not a pull at all: the caller refuses, never guesses.
function rowOf(r: Row | undefined): PullRow | null {
  if (!r) return null;
  const requested = cents(r.requested_cents);
  const balance = cents(r.balance_cents);
  const pull = cents(r.pull_cents);
  const shortfall = cents(r.shortfall_cents);
  if (requested === null || balance === null || pull === null || shortfall === null) return null;
  if (!(PULL_STATUSES as readonly string[]).includes(r.status)) return null;
  return {
    id: r.id.toLowerCase(),
    driverId: r.driver_id.toLowerCase(),
    cardId: r.card_id.toLowerCase(),
    proposalId: r.proposal_id.toLowerCase(),
    advanceId: r.advance_id === null ? null : r.advance_id.toLowerCase(),
    reason: r.reason,
    requestedCents: requested,
    balanceCents: balance,
    pullCents: pull,
    shortfallCents: shortfall,
    moneyActionId: r.money_action_id === null ? null : r.money_action_id.toLowerCase(),
    status: r.status as PullStatus,
    pulledAt: r.pulled_at,
  };
}

// One pull by its id or its proposal's. lock takes the row FOR UPDATE (the settle step).
export async function readPull(
  q: Queryable,
  by: "id" | "proposal_id",
  value: string,
  lock = false,
): Promise<PullRow | null> {
  if (!isCanonicalUuid(value)) return null;
  const rows = await q.query<Row>(
    `SELECT ${COLUMNS} FROM card_pullbacks
      WHERE tenant_id = current_tenant_id() AND ${by === "id" ? "id" : "proposal_id"} = CAST($1 AS uuid)
      ${lock ? "FOR UPDATE" : ""}`,
    [value],
  );
  if (rows.length > 1) throw new RangeError("more than one pull matched");
  return rowOf(rows[0]);
}
