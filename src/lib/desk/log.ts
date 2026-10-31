import { DbError, type Queryable } from "../db";
import { isUuid } from "../uuid";
import { isDeskSource, parseEventKey, SUBJECT_TABLES, type DeskSource } from "./keys";

// The desk log: one insert-only line per step (0065). The loop's whole state is read back from it:
// an event's state is its latest line (closed for good once it has a terminal line), an attempt is
// a claimed line, a run it carries on is named by its latest carried line, and a carried line with
// the category THREW is a carried try that threw. Nothing here updates or deletes a line (the app
// login cannot).

export const LINE_KINDS = ["wake", "seen", "claimed", "carried", "done", "failed", "skipped", "sleep"] as const;
export type LineKind = (typeof LINE_KINDS)[number];
export type WakeBy = "schedule" | "button";

// The fixed shape of a line's detail: run ids, whole counts, cents and a category word. Never error
// text, record contents or names.
export type LineDetail = {
  runId?: string;
  found?: number;
  toolCalls?: number;
  cents?: number;
  category?: string;
};

export type Line = {
  id: string;
  wakeId: string;
  at: string;
  kind: LineKind;
  eventKey: string | null;
  source: DeskSource | null;
  subjectId: string | null;
  by: WakeBy;
  detail: LineDetail;
};

const CATEGORY = /^[a-z][a-z0-9_]{0,39}$/;

// The loop's own category word on a carried line whose try threw (no handler writes it).
export const THREW = "threw";

export function isCategory(value: unknown): value is string {
  return typeof value === "string" && CATEGORY.test(value);
}

// A category word as it may be stored: anything else is "unknown".
export function categoryWord(value: unknown): string {
  return isCategory(value) ? value : "unknown";
}

const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

// Only the fixed fields, each only when it is the right shape: a run id that is a uuid, counts and
// cents that are whole and not negative, a category word. Anything else is dropped, so a line never
// carries more than the shape allows.
export function cleanDetail(detail: LineDetail | undefined): LineDetail {
  const out: LineDetail = {};
  if (!detail) return out;
  if (isUuid(detail.runId)) out.runId = detail.runId.toLowerCase();
  if (count(detail.found)) out.found = detail.found;
  if (count(detail.toolCalls)) out.toolCalls = detail.toolCalls;
  if (count(detail.cents)) out.cents = detail.cents;
  if (detail.category !== undefined) out.category = categoryWord(detail.category);
  return out;
}

const INSERT_SQL = `INSERT INTO desk_log (id, tenant_id, wake_id, at, kind, event_key, source, subject_table, subject_id, by, detail)
VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS timestamptz), $4, $5, $6, $7,
        CAST($8 AS uuid), $9, CAST($10 AS jsonb))
ON CONFLICT (tenant_id, event_key) WHERE kind = 'done' DO NOTHING`;

// One line. A wake or sleep line names no event; every other line names one this loop writes. A
// second done line for the same event is not written (the dedupe key): false says so.
export async function appendLine(q: Queryable, line: Line): Promise<boolean> {
  if (!isUuid(line.id) || !isUuid(line.wakeId)) throw new RangeError("line ids must be uuids");
  if (!(LINE_KINDS as readonly string[]).includes(line.kind)) throw new RangeError("not a line kind");
  if (line.by !== "schedule" && line.by !== "button") throw new RangeError("not a waker");
  const bare = line.kind === "wake" || line.kind === "sleep";
  let source: DeskSource | null = null;
  let subjectTable: string | null = null;
  let subjectId: string | null = null;
  if (bare) {
    if (line.eventKey !== null || line.source !== null || line.subjectId !== null) {
      throw new RangeError("a wake or sleep line names no event");
    }
  } else {
    const parsed = parseEventKey(line.eventKey);
    if (!parsed || parsed.source !== line.source || !isDeskSource(line.source)) {
      throw new RangeError("not an event key this loop writes");
    }
    source = parsed.source;
    if (parsed.subjectId !== null) {
      subjectTable = SUBJECT_TABLES[parsed.source as keyof typeof SUBJECT_TABLES];
      subjectId = parsed.subjectId;
    }
  }
  const written = await q.execute(INSERT_SQL, [
    line.id,
    line.wakeId,
    line.at,
    line.kind,
    bare ? null : line.eventKey,
    source,
    subjectTable,
    subjectId,
    line.by,
    JSON.stringify(cleanDetail(line.detail)),
  ]);
  return written === 1;
}

// An event with no terminal line yet: found (seen), being tried (claimed), or still running and
// carried on by the next wake (carried).
export type OpenEvent = {
  eventKey: string;
  source: DeskSource;
  subjectId: string | null;
  state: "seen" | "claimed" | "carried";
  // Claimed lines: tries started.
  attempts: number;
  // Carried lines: wakes it was carried on through.
  carries: number;
  // Carried lines whose try threw (category THREW): a carried piece's failed tries.
  threw: number;
  // From the latest carried line: the run it carries on, and what it found so far.
  runId: string | null;
  found: number | null;
  firstAt: string;
};

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// The latest line per event decides its state. Two lines at the same instant are ordered by the
// lifecycle (seen, claimed, carried, then a terminal line), which is the only order they are
// written in, so a fixed clock reads back the same. A terminal line is final: an event with one is
// never open again, whatever a late wake writes after it (a wake frozen at the route's limit that
// thaws later and records its old try).
const RANK = `CASE kind WHEN 'seen' THEN 0 WHEN 'claimed' THEN 1 WHEN 'carried' THEN 2 ELSE 3 END`;

// Oldest first, then by key. TMS-MIRROR (0075): dispatch status events seen in one wake keep their
// place among the other sources but run in the order they happened, so a load's in transit event
// runs before its delivered one (their ids are random, so key order is a coin flip).
export const OPEN_EVENTS_SQL = `WITH lines AS (
  SELECT event_key, kind, source, subject_id, at, detail, ${RANK} AS rank
    FROM desk_log
   WHERE tenant_id = current_tenant_id() AND event_key IS NOT NULL AND at >= CAST($1 AS timestamptz)
), latest AS (
  SELECT DISTINCT ON (event_key) event_key, kind, source, subject_id
    FROM lines ORDER BY event_key, at DESC, rank DESC
), carried AS (
  SELECT DISTINCT ON (event_key) event_key, detail->>'runId' AS run_id, detail->>'found' AS found
    FROM lines WHERE kind = 'carried' ORDER BY event_key, at DESC
), tally AS (
  SELECT event_key, min(at) AS first_at,
         CAST(count(*) FILTER (WHERE kind = 'claimed') AS integer) AS attempts,
         CAST(count(*) FILTER (WHERE kind = 'carried') AS integer) AS carries,
         CAST(count(*) FILTER (WHERE kind = 'carried' AND detail->>'category' = '${THREW}') AS integer) AS threw
    FROM lines GROUP BY event_key
)
SELECT l.event_key, l.kind, l.source, CAST(l.subject_id AS text) AS subject_id, t.attempts, t.carries, t.threw,
       c.run_id, c.found, ${ts("t.first_at")} AS first_at
  FROM latest l JOIN tally t ON t.event_key = l.event_key
  LEFT JOIN carried c ON c.event_key = l.event_key
 WHERE l.kind IN ('seen', 'claimed', 'carried')
   AND NOT EXISTS (SELECT 1 FROM desk_log f
                    WHERE f.tenant_id = current_tenant_id() AND f.event_key = l.event_key
                      AND f.kind IN ('done', 'failed', 'skipped'))
 ORDER BY t.first_at,
          CASE WHEN l.source = 'tms_event' THEN 'tms_event:' ELSE l.event_key END,
          (SELECT e.at FROM tms_status_events e
            WHERE l.source = 'tms_event' AND e.tenant_id = current_tenant_id() AND e.id = l.subject_id),
          l.event_key
 LIMIT $2`;

type OpenRow = {
  event_key: string;
  kind: string;
  source: string;
  subject_id: string | null;
  attempts: number;
  carries: number;
  threw: number;
  run_id: string | null;
  found: string | null;
  first_at: string;
};

// The open events since the loop's start, oldest first, from the log alone. A row that does not
// read back whole throws: unknown is not zero.
export async function readState(q: Queryable, opts: { sinceStart: string; limit: number }): Promise<OpenEvent[]> {
  const rows = await q.query<OpenRow>(OPEN_EVENTS_SQL, [opts.sinceStart, opts.limit]);
  return rows.map((r) => {
    const parsed = parseEventKey(r.event_key);
    const state = r.kind;
    if (
      !parsed ||
      parsed.source !== r.source ||
      (parsed.subjectId ?? null) !== (r.subject_id === null ? null : r.subject_id.toLowerCase()) ||
      (state !== "seen" && state !== "claimed" && state !== "carried") ||
      !count(r.attempts) ||
      !count(r.carries) ||
      !count(r.threw) ||
      typeof r.first_at !== "string"
    ) {
      throw new DbError("unknown");
    }
    const found = r.found === null ? null : Number(r.found);
    return {
      eventKey: r.event_key,
      source: parsed.source,
      subjectId: parsed.subjectId,
      state,
      attempts: r.attempts,
      carries: r.carries,
      threw: r.threw,
      runId: isUuid(r.run_id) ? r.run_id.toLowerCase() : null,
      found: found !== null && count(found) ? found : null,
      firstAt: r.first_at,
    };
  });
}

// Lines that found work in the 24 hours before `at`: the day's share of eventsPerDay.
export async function readSeenSince(q: Queryable, since: string): Promise<number> {
  const [row] = await q.query<{ n: number }>(
    `SELECT CAST(count(*) AS integer) AS n FROM desk_log
      WHERE tenant_id = current_tenant_id() AND kind = 'seen' AND at > CAST($1 AS timestamptz)`,
    [since],
  );
  if (!row || !count(row.n)) throw new DbError("unknown");
  return row.n;
}
