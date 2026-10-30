import { DbError, type Queryable } from "../db";
import { duePeriodKeys, eventKey, type DeskSource, type LocalNow, type SubjectSource } from "./keys";
import { appendLine, type WakeBy } from "./log";

// Discovery: the loop finds new work in our own tables (no push source exists). Each finder is one
// bounded read, then a seen line per new piece of work, in one transaction with its watermark. A
// seen line is written only when the log has no line for that key, so a piece of work is found
// once, ever. Nothing created before the loop's start is ever found.

export type Watermarks = { card_transactions: string; customer_payments: string };

export type DiscoverInput = {
  wakeId: string;
  by: WakeBy;
  // The loop's start: the carrier's local midnight on flags.deskLoop.startDate, as an ISO instant.
  startInstant: string;
  nowIso: string;
  nowLocal: LocalNow;
  startDate: string;
  watermarks: Watermarks;
  // How many seen lines this wake may still write.
  budget: number;
  newId: () => string;
};

export type FinderResult = { seen: number; watermark?: { name: keyof Watermarks; value: string } };

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// "No line for this key yet", for a row of `alias` whose key is `<source>:<id>`.
const notLogged = (source: SubjectSource, alias: string) =>
  `NOT EXISTS (SELECT 1 FROM desk_log d WHERE d.tenant_id = current_tenant_id()
                  AND d.event_key = '${source}:' || CAST(${alias}.id AS text))`;

// The subject finders. Each reads rows created on or after its floor (the watermark, or the start)
// and not after now, oldest first, that have no line yet. $1 floor, $2 now, $3 limit.
const FINDERS: { source: SubjectSource; watermark?: keyof Watermarks; sql: string }[] = [
  {
    source: "card_transaction",
    watermark: "card_transactions",
    sql: `SELECT CAST(x.id AS text) AS id, ${ts("x.created_at")} AS created_at FROM card_transactions x
           WHERE x.tenant_id = current_tenant_id()
             AND x.created_at >= CAST($1 AS timestamptz) AND x.created_at <= CAST($2 AS timestamptz)
             AND ${notLogged("card_transaction", "x")}
           ORDER BY x.created_at, x.id LIMIT $3`,
  },
  {
    source: "inbound_message",
    sql: `SELECT CAST(x.id AS text) AS id, ${ts("x.created_at")} AS created_at FROM inbound_messages x
           WHERE x.tenant_id = current_tenant_id() AND x.status IN ('received', 'triaged')
             AND x.created_at >= CAST($1 AS timestamptz) AND x.created_at <= CAST($2 AS timestamptz)
             AND ${notLogged("inbound_message", "x")}
           ORDER BY x.created_at, x.id LIMIT $3`,
  },
  {
    source: "voice_note",
    sql: `SELECT CAST(x.id AS text) AS id, ${ts("x.created_at")} AS created_at FROM voice_notes x
           WHERE x.tenant_id = current_tenant_id() AND x.status = 'transcribed'
             AND x.created_at >= CAST($1 AS timestamptz) AND x.created_at <= CAST($2 AS timestamptz)
             AND ${notLogged("voice_note", "x")}
           ORDER BY x.created_at, x.id LIMIT $3`,
  },
  {
    source: "customer_payment",
    watermark: "customer_payments",
    sql: `SELECT CAST(x.id AS text) AS id, ${ts("x.created_at")} AS created_at FROM customer_payments x
           WHERE x.tenant_id = current_tenant_id()
             AND x.created_at >= CAST($1 AS timestamptz) AND x.created_at <= CAST($2 AS timestamptz)
             AND ${notLogged("customer_payment", "x")}
           ORDER BY x.created_at, x.id LIMIT $3`,
  },
  {
    source: "audit",
    sql: `SELECT CAST(x.id AS text) AS id, ${ts("x.created_at")} AS created_at FROM proposals x
           WHERE x.tenant_id = current_tenant_id() AND x.status = 'proposed' AND x.auditor_verdict IS NULL
             AND x.created_at >= CAST($1 AS timestamptz) AND x.created_at <= CAST($2 AS timestamptz)
             AND ${notLogged("audit", "x")}
           ORDER BY x.created_at, x.id LIMIT $3`,
  },
];

const NO_LINE_SQL = `SELECT CAST(count(*) AS integer) AS n FROM desk_log
  WHERE tenant_id = current_tenant_id() AND event_key = $1`;

async function seenLine(q: Queryable, input: DiscoverInput, source: DeskSource, key: string): Promise<void> {
  await appendLine(q, {
    id: input.newId(),
    wakeId: input.wakeId,
    at: input.nowIso,
    kind: "seen",
    eventKey: key,
    source,
    subjectId: null,
    by: input.by,
    detail: {},
  });
}

// The day's and the week's due periods with no line yet.
export async function findPeriods(q: Queryable, input: DiscoverInput): Promise<FinderResult> {
  let seen = 0;
  for (const { source, key } of duePeriodKeys(input.nowLocal, input.startDate)) {
    if (seen >= input.budget) break;
    const [row] = await q.query<{ n: number }>(NO_LINE_SQL, [key]);
    if (!row || !Number.isSafeInteger(row.n)) throw new DbError("unknown");
    if (row.n > 0) continue;
    await seenLine(q, input, source, key);
    seen += 1;
  }
  return { seen };
}

// One subject finder: its new rows become seen lines, and its watermark (if it keeps one) moves to
// the newest row it found. Rows at the watermark instant are read again and kept out by the log.
export async function findSubjects(
  q: Queryable,
  input: DiscoverInput,
  finder: (typeof FINDERS)[number],
): Promise<FinderResult> {
  if (input.budget <= 0) return { seen: 0 };
  const floor = finder.watermark ? maxInstant(input.watermarks[finder.watermark], input.startInstant) : input.startInstant;
  const rows = await q.query<{ id: string; created_at: string }>(finder.sql, [floor, input.nowIso, input.budget]);
  let newest = floor;
  for (const r of rows) {
    if (typeof r.id !== "string" || typeof r.created_at !== "string") throw new DbError("unknown");
    await seenLine(q, input, finder.source, eventKey(finder.source, r.id));
    newest = maxInstant(newest, r.created_at);
  }
  if (!finder.watermark) return { seen: rows.length };
  return { seen: rows.length, watermark: { name: finder.watermark, value: newest } };
}

// Both are ISO instants in the one form this module writes (UTC, milliseconds, Z), so they compare
// as text.
export function maxInstant(a: string, b: string): string {
  return a > b ? a : b;
}

export const SUBJECT_FINDERS = FINDERS;

export const MOVE_WATERMARK_SQL = `UPDATE desk_loops
    SET watermarks = watermarks || jsonb_build_object(CAST($1 AS text), CAST($2 AS text)),
        updated_at = CAST($3 AS timestamptz)
  WHERE tenant_id = current_tenant_id() AND lease_token = CAST($4 AS uuid)`;
