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

// The simulated card provider's id for the load a ledger row's request id makes, in SQL: the same
// formula as loadId() in src/lib/adapters/payment/fuel-card-sim.ts ("fcs_load_" and the first 24
// hex of sha256("load:" + request id)). The adapter is called with the row's own request_id.
export const simLoadIdSql = (requestId: string): string =>
  `'fcs_load_' || left(encode(sha256(convert_to('load:' || ${requestId}, 'UTF8')), 'hex'), 24)`;

// A payment record behind a load, as a predicate over the load's provider reference, provider and
// card token (SQL expressions; the token stays inside SQL). Only a settle writes a ledger row's
// outside columns, so a row still reserved, sent or unknown names no outside id yet. Unknown is
// never "no record", so any one of these counts:
//   - a ledger row the card provider settled naming the load's id, unless it failed;
//   - a row not yet settled (reserved, sent or unknown) whose request id makes the load's id;
//   - a row not yet settled on an advance whose payout attempt went to this card (advances.card_id):
//     a payout in flight or unconfirmed on the card may be this load, so it fails closed.
// Shared by the draft and executor probe below and the agent's read (src/lib/data/card-loads.ts).
export function ledgerRecordSql(ref: string, provider: string, token: string): string {
  return `(EXISTS (SELECT 1 FROM money_actions m
            WHERE m.tenant_id = current_tenant_id() AND m.state <> 'failed'
              AND ((m.outside_system = 'fuel_card_sim' AND m.outside_id = ${ref})
                OR (m.state IN ('reserved', 'sent', 'unknown') AND ${simLoadIdSql("m.request_id")} = ${ref})))
       OR EXISTS (SELECT 1 FROM money_actions m
            JOIN advances a ON a.tenant_id = m.tenant_id AND a.id = m.subject_id
            JOIN driver_cards c ON c.tenant_id = a.tenant_id AND c.id = a.card_id
            WHERE m.tenant_id = current_tenant_id() AND m.subject_table = 'advances'
              AND m.state IN ('reserved', 'sent', 'unknown')
              AND c.provider = ${provider} AND c.provider_token = ${token}))`;
}

export const LEDGER_ROW_SQL = `SELECT 1 AS one
  WHERE ${ledgerRecordSql("CAST($1 AS text)", "CAST($2 AS text)", "CAST($3 AS text)")}`;

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

export async function hasLedgerRow(
  q: Queryable,
  load: Pick<LoadRow, "provider_ref" | "provider" | "card_token">,
): Promise<boolean> {
  return (await q.query(LEDGER_ROW_SQL, [load.provider_ref, load.provider, load.card_token])).length > 0;
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
