import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { untrustedContentHash } from "../data/content-hash";

// The ratecon_reads table (migration 0066), inside a tenant transaction the caller opened
// (row-level security scopes every statement, and each one also names the tenant). One row per
// document: the rate confirmation's second reading, the load id it reserved before any model call
// (the id the load takes if a person approves the card), and where the reading ended.

export const RATECON_STATUSES = ["pending", "proposed", "created", "refused", "unreadable", "budget"] as const;
export type RateConStatus = (typeof RATECON_STATUSES)[number];

// Where a row ends, past the checks' own categories, when its card is dead and no new card
// follows: a person rejected the card, or the document has had RATECON_CARDS_MAX cards. Both leave
// no tries, so no read or card follows for that document.
export const RATECON_ROW_ENDS = ["rejected", "card_limit"] as const;
export type RateConRowEnd = (typeof RATECON_ROW_ENDS)[number];

// Model reads one rate confirmation may start: the first, then two more tries.
export const RATECON_ATTEMPTS_MAX = 3;

// Load cards one rate confirmation may get, counted by its load id: the first, then a new one
// each time the last expired or failed.
export const RATECON_CARDS_MAX = 3;

export type RateConRow = {
  id: string;
  document_id: string;
  load_id: string;
  status: RateConStatus;
  category: string | null;
  attempts: number;
  reading: string | null;
  input_id: string | null;
  read_call_id: string | null;
  proposal_id: string | null;
  created_at: string;
  updated_at: string;
};

const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const COLUMNS =
  "CAST(id AS text) AS id, CAST(document_id AS text) AS document_id, CAST(load_id AS text) AS load_id," +
  " status, category, attempts, CAST(reading AS text) AS reading, CAST(input_id AS text) AS input_id," +
  " CAST(read_call_id AS text) AS read_call_id, CAST(proposal_id AS text) AS proposal_id," +
  ` ${utc("created_at")} AS created_at, ${utc("updated_at")} AS updated_at`;

// Second reads by one tenant start one at a time, and a card is made one at a time: this lock
// holds to the end of the transaction, so two requests cannot both pass the daily count, and two
// files of one rate confirmation cannot both pass the check for a live card for the number.
export async function lockTenantRateCons(q: Queryable): Promise<void> {
  await q.query(
    "SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended('ratecon:' || CAST(current_tenant_id() AS text), 0))) AS l",
  );
}

export async function readRateConRow(
  q: Queryable,
  documentId: string,
  opts: { lock?: boolean } = {},
): Promise<RateConRow | null> {
  const rows = await q.query<RateConRow>(
    `SELECT ${COLUMNS} FROM ratecon_reads
      WHERE tenant_id = current_tenant_id() AND document_id = CAST($1 AS uuid)${opts.lock ? " FOR UPDATE" : ""}`,
    [documentId],
  );
  return rows[0] ?? null;
}

export async function readRateConRowByLoad(q: Queryable, loadId: string): Promise<RateConRow | null> {
  const rows = await q.query<RateConRow>(
    `SELECT ${COLUMNS} FROM ratecon_reads
      WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)`,
    [loadId],
  );
  return rows[0] ?? null;
}

// Second reads started in the 24 hours before now (a rolling day). Read under lockTenantRateCons.
// A row refused before any read (before_start, no call id) started none and is not counted.
export async function countRecentRateCons(q: Queryable, nowIso: string): Promise<number> {
  const rows = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM ratecon_reads
      WHERE tenant_id = current_tenant_id()
        AND created_at > CAST($1 AS timestamptz) - interval '24 hours'
        AND NOT (status = 'refused' AND category = 'before_start' AND read_call_id IS NULL)`,
    [nowIso],
  );
  const n = Number(rows[0]?.n);
  if (!Number.isSafeInteger(n)) throw new Error("count is not a number");
  return n;
}

// A new row, pending, with the load id reserved. 1 when inserted.
export async function insertRateConRow(
  q: Queryable,
  row: { id: string; documentId: string; loadId: string },
  nowIso: string,
): Promise<number> {
  return q.execute(
    `INSERT INTO ratecon_reads (id, tenant_id, document_id, load_id, status, attempts, created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'pending', 1,
             CAST($4 AS timestamptz), CAST($4 AS timestamptz))
     ON CONFLICT (tenant_id, document_id) DO NOTHING`,
    [row.id, row.documentId, row.loadId, nowIso],
  );
}

// A new row for a document stored before flags.ratecon.startDate: refused (before_start) with no
// tries left, before any read, so it is never read. 1 when inserted.
export async function insertRateConBeforeStart(
  q: Queryable,
  row: { id: string; documentId: string; loadId: string },
  nowIso: string,
): Promise<number> {
  return q.execute(
    `INSERT INTO ratecon_reads (id, tenant_id, document_id, load_id, status, category, attempts,
                                created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'refused',
             'before_start', $5, CAST($4 AS timestamptz), CAST($4 AS timestamptz))
     ON CONFLICT (tenant_id, document_id) DO NOTHING`,
    [row.id, row.documentId, row.loadId, nowIso, RATECON_ATTEMPTS_MAX],
  );
}

// Another try on a row that ended with no card (refused, unreadable, budget), or a pending one
// whose request went away (older than the cutoff). One statement, guarded on the status and the
// count the caller read, so two clicks start one try. 1 when this call took it. input_id is left
// as it is (the earlier try's transcript stays linked while this one runs); the finish sets it.
export async function claimRateConTry(
  q: Queryable,
  row: Pick<RateConRow, "id" | "status" | "attempts">,
  cutoffIso: string,
  nowIso: string,
): Promise<number> {
  return q.execute(
    `UPDATE ratecon_reads
        SET status = 'pending', category = NULL, reading = NULL, read_call_id = NULL,
            attempts = attempts + 1, updated_at = CAST($4 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status = $2 AND attempts = $3 AND attempts < $6
        AND (status IN ('refused', 'unreadable', 'budget') OR updated_at < CAST($5 AS timestamptz))`,
    [row.id, row.status, row.attempts, nowIso, cutoffIso, RATECON_ATTEMPTS_MAX],
  );
}

export type RateConFinish =
  | { status: "unreadable" | "budget"; category: string; callId: string | null }
  | { status: "refused"; category: string; reading: Record<string, unknown>; inputId: string; callId: string }
  | { status: "proposed"; reading: Record<string, unknown>; inputId: string; callId: string; proposalId: string };

// Ends the try the caller holds (still pending, the same count), once. 1 when this call ended it.
export async function finishRateCon(
  q: Queryable,
  row: Pick<RateConRow, "id" | "attempts">,
  f: RateConFinish,
  nowIso: string,
): Promise<number> {
  const category = f.status === "proposed" ? null : f.category;
  const reading = f.status === "proposed" || f.status === "refused" ? JSON.stringify(f.reading) : null;
  const inputId = f.status === "proposed" || f.status === "refused" ? f.inputId : null;
  const proposalId = f.status === "proposed" ? f.proposalId : null;
  return q.execute(
    `UPDATE ratecon_reads
        SET status = $3, category = $4, reading = CAST($5 AS jsonb), input_id = CAST($6 AS uuid),
            read_call_id = CAST($7 AS uuid), proposal_id = CAST($8 AS uuid), updated_at = CAST($9 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status = 'pending' AND attempts = $2`,
    [row.id, row.attempts, f.status, category, reading, inputId, f.callId, proposalId, nowIso],
  );
}

// The load was written: the row that reserved its id moves from proposed to created, once.
export async function markRateConCreated(
  q: Queryable,
  loadId: string,
  proposalId: string,
  nowIso: string,
): Promise<number> {
  return q.execute(
    `UPDATE ratecon_reads SET status = 'created', updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)
        AND proposal_id = CAST($2 AS uuid) AND status = 'proposed'`,
    [loadId, proposalId, nowIso],
  );
}

// The status of the card a row names, or null when no load_create card has the id. A plain read,
// not a lock: the only statuses the row acts on (expired, failed, rejected) are final (0009's
// proposals_guard), and the executor locks its card before the tenant's rate confirmation lock, so
// locking the card here, under that lock, could deadlock with an approval in flight.
export async function readCardStatus(q: Queryable, proposalId: string): Promise<string | null> {
  const rows = await q.query<{ status: string }>(
    `SELECT status FROM proposals
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'load_create'`,
    [proposalId],
  );
  return rows[0]?.status ?? null;
}

// Every load_create card ever made for this load id, whatever its status. Read under
// lockTenantRateCons, so no card for the id is made while it is counted.
export async function countRateConCards(q: Queryable, loadId: string): Promise<number> {
  const rows = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM proposals
      WHERE tenant_id = current_tenant_id() AND kind = 'load_create' AND subject_id = CAST($1 AS uuid)`,
    [loadId],
  );
  const n = Number(rows[0]?.n);
  if (!Number.isSafeInteger(n)) throw new Error("count is not a number");
  return n;
}

// A row whose card expired or failed takes the new card made from its stored reading: guarded on
// the row still proposed with the dead card, so it moves once. 1 when this call moved it.
export async function relinkRateConCard(
  q: Queryable,
  rowId: string,
  oldProposalId: string,
  newProposalId: string,
  nowIso: string,
): Promise<number> {
  return q.execute(
    `UPDATE ratecon_reads SET proposal_id = CAST($3 AS uuid), updated_at = CAST($4 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status = 'proposed' AND proposal_id = CAST($2 AS uuid)`,
    [rowId, oldProposalId, newProposalId, nowIso],
  );
}

// A row whose card is dead, ended with no new card: refused as the category, the card unlinked,
// the reading, its transcript and its call id kept. A RATECON_ROW_ENDS category leaves no tries; any
// other (a check's refusal) leaves the tries there were, as a refused read does. Guarded as
// relinkRateConCard is. 1 when this call ended it.
export async function endRateConCard(
  q: Queryable,
  rowId: string,
  oldProposalId: string,
  category: string,
  nowIso: string,
): Promise<number> {
  const attempts = (RATECON_ROW_ENDS as readonly string[]).includes(category) ? RATECON_ATTEMPTS_MAX : null;
  return q.execute(
    `UPDATE ratecon_reads
        SET status = 'refused', category = $3, proposal_id = NULL,
            attempts = COALESCE(CAST($4 AS smallint), attempts), updated_at = CAST($5 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status = 'proposed' AND proposal_id = CAST($2 AS uuid)`,
    [rowId, oldProposalId, category, attempts, nowIso],
  );
}

// The reading's transcript, stored as an outside input (kind document, source upload), as the
// first read's is. Returns its id.
export async function insertRateConTranscript(q: Queryable, text: string, nowIso: string): Promise<string> {
  const id = randomUUID();
  await q.execute(
    `INSERT INTO untrusted_inputs (id, tenant_id, kind, source, body_text, content_hash, received_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'document', 'upload', $2, $3, CAST($4 AS timestamptz))`,
    [id, text, untrustedContentHash("document", text), nowIso],
  );
  return id;
}

// A stored transcript: its text and stored hash, or null when there is none.
export async function readTranscriptRow(
  q: Queryable,
  inputId: string,
): Promise<{ body_text: string; content_hash: string } | null> {
  const rows = await q.query<{ body_text: string; content_hash: string }>(
    `SELECT body_text, content_hash FROM untrusted_inputs
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'document'`,
    [inputId],
  );
  return rows[0] ?? null;
}
