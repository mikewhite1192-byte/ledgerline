import type { Queryable } from "../db";

// The facts a card load ruling stands on, shared by the draft (./ruling.ts), the executor
// (src/lib/proposals/executors/card-load-ruling.ts) and the agent's read (src/lib/data/card-loads.ts).
// Reads only, inside a tenant transaction the caller holds. The card token stays inside SQL.

// A statement load row as the ruling reads it. amount_cents comes back as text (bigint).
export type LoadRow = {
  id: string;
  provider: string;
  provider_ref: string;
  kind: string;
  card_token: string;
  card_last4: string;
  posted_on: string;
  amount_cents: string;
  created_at: string;
};

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const LOAD_ROW_SQL = `SELECT CAST(id AS text) AS id, provider, provider_ref, kind, card_token, card_last4,
       CAST(posted_on AS text) AS posted_on, CAST(amount_cents AS text) AS amount_cents, ${ts("created_at")} AS created_at
  FROM card_transactions WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`;

// A payment record behind a load: any ledger row on the card provider naming the load's id, unless
// it failed. A row still sent or unknown counts as a record, so unknown is never "no record".
export const LEDGER_ROW_SQL = `SELECT 1 AS one FROM money_actions m
  WHERE m.tenant_id = current_tenant_id() AND m.outside_system = 'fuel_card_sim'
    AND m.outside_id = $1 AND m.state <> 'failed'
  LIMIT 1`;

// The drivers whose file holds the card (any status). The provider and token are unique on file,
// so this is one row or none.
export const CARD_DRIVER_SQL = `SELECT CAST(c.driver_id AS text) AS driver_id FROM driver_cards c
  WHERE c.tenant_id = current_tenant_id() AND c.provider = $1 AND c.provider_token = $2`;

// A deficit already booked on the statement row by a ruling other than `exceptProposal` (null: any).
export const DEFICIT_SQL = `SELECT 1 AS one FROM driver_deficits d
  WHERE d.tenant_id = current_tenant_id() AND d.source_kind = 'card_load' AND d.source_id = CAST($1 AS uuid)
    AND (CAST($2 AS uuid) IS NULL OR d.proposal_id IS DISTINCT FROM CAST($2 AS uuid))
  LIMIT 1`;

// Two runs on one statement row take turns: the app may not lock the row itself (no UPDATE grant on
// card_transactions), so the lock is a transaction-scoped advisory lock on the carrier and the row.
export const LOCK_LOAD_SQL = `SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended(
    'card_load_ruling:' || CAST(current_tenant_id() AS text) || ':' || $1, 0))) AS l`;

export async function readLoadRow(q: Queryable, transactionId: string): Promise<LoadRow | null> {
  const rows = await q.query<LoadRow>(LOAD_ROW_SQL, [transactionId]);
  return rows.length === 1 ? rows[0] : null;
}

export async function hasLedgerRow(q: Queryable, providerRef: string): Promise<boolean> {
  return (await q.query(LEDGER_ROW_SQL, [providerRef])).length > 0;
}

export async function hasOtherDeficit(q: Queryable, transactionId: string, exceptProposal: string | null): Promise<boolean> {
  return (await q.query(DEFICIT_SQL, [transactionId, exceptProposal])).length > 0;
}

// The one driver whose card it is, or null for none or more than one.
export async function cardDriver(q: Queryable, provider: string, token: string): Promise<string | null> {
  const rows = await q.query<{ driver_id: string }>(CARD_DRIVER_SQL, [provider, token]);
  return rows.length === 1 ? rows[0].driver_id.toLowerCase() : null;
}

// The load's whole cents, or null when the column does not read as a safe positive integer.
export function loadCents(row: Pick<LoadRow, "amount_cents">): number | null {
  const n = Number(row.amount_cents);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
