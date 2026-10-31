import { flags } from "../../config/flags";
import { DbError, type Queryable } from "../db";
import { midnightMs, readZone } from "../autopilot/read";
import { isUuid } from "../uuid";
import {
  duePeriodKeys,
  eventKey,
  isRerunSource,
  MAX_PERIOD_GO,
  PERIOD_RUN_TABLES,
  periodGoKey,
  periodGoOf,
  type DeskSource,
  type LocalNow,
  type PeriodSource,
  type RerunSource,
  type SubjectSource,
} from "./keys";
import { appendLine, type WakeBy } from "./log";

// Discovery: the loop finds new work in our own tables (no push source exists). Each finder is one
// bounded read, then a seen line per new piece of work, in one transaction with its watermark. A
// seen line is written only when the log has no line for that key, so a piece of work is found
// once, ever (a day's sweep whose run the demo reset removed is new work, under a new key: the
// period's next go). Nothing created before the loop's start is ever found.

export type Watermarks = {
  card_transactions: string;
  customer_payments: string;
  // LOAD-MOVEMENT (0071): a document's last change (its read), and a move's record time.
  documents: string;
  load_events: string;
};

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
// and not after now, oldest first, that have no line yet. $1 floor, $2 now, $3 limit. A finder with
// a `when` finds nothing while it reads false (the autopilot's, until it is armed: no line is
// written for work nobody may do yet, so arming finds the proposals still waiting then). A finder
// with a `notBefore` date (YYYY-MM-DD, the carrier's local midnight) never reads a row made before
// it, and finds nothing while that date does not read.
const FINDERS: {
  source: SubjectSource;
  watermark?: keyof Watermarks;
  when?: () => boolean;
  notBefore?: () => string;
  sql: string;
}[] = [
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
  // LOAD-MOVEMENT (0071): a document read and matched to one load, by its last change (the read
  // writes updated_at), so a paper read after its upload is found once its read is in. One line per
  // document, ever: the same document read twice is one piece of work.
  {
    source: "document",
    watermark: "documents",
    sql: `SELECT CAST(x.id AS text) AS id, ${ts("x.updated_at")} AS created_at FROM documents x
           WHERE x.tenant_id = current_tenant_id() AND x.read_status = 'read'
             AND x.document_kind IN ('bill_of_lading', 'rate_confirmation')
             AND x.match->>'loadId' IS NOT NULL
             AND x.updated_at >= CAST($1 AS timestamptz) AND x.updated_at <= CAST($2 AS timestamptz)
             AND ${notLogged("document", "x")}
           ORDER BY x.updated_at, x.id LIMIT $3`,
  },
  // A move recorded outside the seed: the lanes that follow a move (later items) read these lines.
  {
    source: "load_event",
    watermark: "load_events",
    sql: `SELECT CAST(x.id AS text) AS id, ${ts("x.created_at")} AS created_at FROM load_events x
           WHERE x.tenant_id = current_tenant_id() AND x.source <> 'seed'
             AND x.created_at >= CAST($1 AS timestamptz) AND x.created_at <= CAST($2 AS timestamptz)
             AND ${notLogged("load_event", "x")}
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
  {
    // A proposal the auditor passed and the engine matched, of a kind the owner set to Auto, that
    // the autopilot has not looked at. The policy and the approval gate decide it all again.
    source: "autopilot",
    when: () => flags.autopilot.enabled === true && flags.autopilot.armed === true,
    notBefore: () => flags.autopilot.startDate,
    sql: `SELECT CAST(x.id AS text) AS id, ${ts("x.created_at")} AS created_at FROM proposals x
           WHERE x.tenant_id = current_tenant_id() AND x.status = 'proposed'
             AND x.auditor_verdict = 'pass' AND x.engine_check = 'matched'
             AND x.flagged_input_id IS NULL AND x.autopilot_decision IS NULL
             AND x.created_at >= CAST($1 AS timestamptz) AND x.created_at <= CAST($2 AS timestamptz)
             AND EXISTS (SELECT 1 FROM autopilot_rules r WHERE r.tenant_id = current_tenant_id()
                            AND r.kind = x.kind AND r.mode = 'auto')
             AND ${notLogged("autopilot", "x")}
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

// Every line of every go of one period: its own key and `<key>.<n>`.
const PERIOD_LINES_SQL = `SELECT event_key, kind, detail->>'runId' AS run_id FROM desk_log
  WHERE tenant_id = current_tenant_id()
    AND (event_key = CAST($1 AS text) OR left(event_key, length(CAST($1 AS text)) + 1) = CAST($1 AS text) || '.')`;

const RUN_EXISTS_SQL: Record<RerunSource, string> = {
  sweep: `SELECT CAST(count(*) AS integer) AS n FROM ${PERIOD_RUN_TABLES.sweep}
    WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
};

const TERMINAL = new Set(["done", "failed", "skipped"]);

// The key to find a due period under, or null when its work is already in the log. A period with
// no line is found under its own key. A rerun source's period is found again, as its next go, only
// when its latest go is closed, every terminal line of that go names a run, and none of those runs
// exists any more: the demo reset removed the work, so the log's lines stay and the work is done
// again. A go still open, or closed without a run, or whose run is still there, stays as it is.
async function periodKeyToFind(q: Queryable, source: PeriodSource, base: string): Promise<string | null> {
  if (!isRerunSource(source)) {
    const [row] = await q.query<{ n: number }>(NO_LINE_SQL, [base]);
    if (!row || !Number.isSafeInteger(row.n)) throw new DbError("unknown");
    return row.n > 0 ? null : base;
  }
  const rows = await q.query<{ event_key: unknown; kind: unknown; run_id: unknown }>(PERIOD_LINES_SQL, [base]);
  if (rows.length === 0) return base;
  let go = 0;
  for (const r of rows) {
    const n = periodGoOf(r.event_key, base);
    if (n === null) throw new DbError("unknown");
    go = Math.max(go, n);
  }
  const latest = periodGoKey(base, go);
  const terminal = rows.filter((r) => r.event_key === latest && typeof r.kind === "string" && TERMINAL.has(r.kind));
  if (terminal.length === 0) return null;
  for (const r of terminal) {
    if (r.run_id === null) return null;
    if (!isUuid(r.run_id)) throw new DbError("unknown");
    const [row] = await q.query<{ n: number }>(RUN_EXISTS_SQL[source], [r.run_id]);
    if (!row || !Number.isSafeInteger(row.n)) throw new DbError("unknown");
    if (row.n > 0) return null;
  }
  return go < MAX_PERIOD_GO ? periodGoKey(base, go + 1) : null;
}

// The day's and the week's due periods whose work is not in the log.
export async function findPeriods(q: Queryable, input: DiscoverInput): Promise<FinderResult> {
  let seen = 0;
  for (const { source, key } of duePeriodKeys(input.nowLocal, input.startDate)) {
    if (seen >= input.budget) break;
    const found = await periodKeyToFind(q, source, key);
    if (found === null) continue;
    await seenLine(q, input, source, found);
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
  if (finder.when && finder.when() !== true) return { seen: 0 };
  let floor = finder.watermark ? maxInstant(input.watermarks[finder.watermark], input.startInstant) : input.startInstant;
  if (finder.notBefore) {
    const startMs = midnightMs(finder.notBefore(), await readZone(q));
    if (!Number.isFinite(startMs)) return { seen: 0 };
    floor = maxInstant(floor, new Date(startMs).toISOString());
  }
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
