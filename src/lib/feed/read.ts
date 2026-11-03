import { readPause } from "../autopilot/read";
import { isPaused } from "../autopilot/facts";
import { DbError, type Queryable } from "../db";
import { isRealInstant } from "../format/dates";

// The live feed's one read: every step the agent, the desk, the autopilot and people took with
// money, newest first, from the tables that already record them (desk_log, proposals,
// money_actions, autopilot_changes, approval_batches). One UNION ALL inside the caller's tenant
// transaction, each arm naming its tenant on top of row-level security, ordered and limited on its
// own, then sorted and limited again. No migration, no view, nothing written.
//
// What a row carries is fixed below: codes, cents, counts and the proposal's title. Never a login
// id, an email, a decision note, an outside id or reference, an idempotency or request id, error
// text or any json beyond a desk line's found count and category word. Who did a step is resolved
// in the SQL to a role word, so a login id never leaves the database.

export const FEED_EVENTS = [
  "desk_claimed",
  "desk_done",
  "desk_failed",
  "desk_skipped",
  "desk_sleep",
  "proposal_proposed",
  "proposal_audited",
  "proposal_decided",
  "money_sent",
  "money_settled",
  "autopilot_pause",
  "autopilot_resume",
  "autopilot_rule",
  "batch_started",
  "batch_finished",
] as const;
export type FeedEvent = (typeof FEED_EVENTS)[number];

// Who took the step: a person by their role in the carrier, the autopilot's login, the agent (a
// proposal is the agent's or the desk's draft), the desk loop, or "someone" when the login has no
// membership row here.
export const FEED_ACTORS = ["admin", "staff", "judge", "autopilot", "agent", "desk", "someone"] as const;
export type FeedActor = (typeof FEED_ACTORS)[number];

export type FeedRow = {
  key: string;
  // An ISO instant in UTC, to the microsecond, so the cursor names a line exactly.
  at: string;
  event: FeedEvent;
  actor: FeedActor;
  cents: number | null;
  direction: string | null;
  title: string | null;
  // The proposal's, money action's, rule's or desk source's kind, or the batch's scope.
  kind: string | null;
  // The event's code word: a desk category, an autopilot mode, an audit verdict, approved or
  // rejected, a money action's state, a rule's mode, a batch's status.
  code: string | null;
  // A second code word: the autopilot's reason, a money action's failure category.
  reason: string | null;
  // A count: things a desk wake finished, items in a batch.
  count: number | null;
  limitCents: number | null;
  dayLimitCents: number | null;
  until: string | null;
  channel: string | null;
  system: string | null;
  // A money action sent and confirmed in one step, shown as one line.
  once: boolean;
  record: { table: string; id: string } | null;
};

export type FeedCursor = { at: string; key: string };

// The first page reads before an instant later than any line and a key that sorts after every key
// (byte order), so every arm uses the same three parameters.
const FIRST: FeedCursor = { at: "9999-12-31T00:00:00.000000Z", key: "~" };

const KEY = /^[a-z]+:[0-9a-f-]{36}(:[a-z]+)?$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CODE = /^[a-z][a-z0-9_]{0,39}$/;

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Every arm lists the same columns in the same order; a column an arm does not set is a typed null.
const COLUMNS = [
  "at",
  "key",
  "event",
  "actor",
  "cents",
  "direction",
  "title",
  "kind",
  "code",
  "reason",
  "n",
  "limit_cents",
  "day_cents",
  "until_at",
  "channel",
  "system",
  "once",
  "record_table",
  "record_id",
] as const;
type Column = (typeof COLUMNS)[number];

// The actor's role word from a login (sub) and its membership role. The autopilot's and the other
// service logins (the sweep's) are told by their sub first, since each has a staff row.
const actorOf = (sub: string, role: string) => `CASE
    WHEN ${sub} LIKE 'service:autopilot:%' THEN 'autopilot'
    WHEN ${sub} LIKE 'service:%' THEN 'desk'
    WHEN ${role} IN ('admin', 'staff', 'judge') THEN ${role}
    ELSE 'someone' END`;

const JOIN_SUB = (alias: string, sub: string) =>
  `LEFT JOIN memberships ${alias} ON ${alias}.tenant_id = current_tenant_id() AND ${alias}.cognito_sub = ${sub}`;

// The keys compare in byte order (COLLATE "C") everywhere, so a page ends where the next begins
// whatever the database's own collation is.
const BEFORE = `(a.at < CAST($2 AS timestamptz)
    OR (a.at = CAST($2 AS timestamptz) AND a.key COLLATE "C" < CAST($3 AS text) COLLATE "C"))`;

function arm(from: string, where: string, set: Partial<Record<Column, string>>): string {
  const cols = COLUMNS.map((c) => `${set[c] ?? (c === "at" ? "CAST(NULL AS timestamptz)" : "CAST(NULL AS text)")} AS ${c}`);
  return `(SELECT * FROM (SELECT ${cols.join(", ")} FROM ${from} WHERE ${where}) a
  WHERE ${BEFORE}
  ORDER BY a.at DESC, a.key COLLATE "C" DESC LIMIT $1)`;
}

const text = (expr: string) => `CAST(${expr} AS text)`;

const ARMS = [
  // The desk: what it picked up, finished, could not finish or skipped, and a wake that finished
  // something. wake, seen and carried lines are left out, and so is a wake that found nothing.
  arm(
    "desk_log d",
    `d.tenant_id = current_tenant_id() AND d.kind IN ('claimed', 'done', 'failed', 'skipped', 'sleep')
      AND (d.kind <> 'sleep' OR (jsonb_typeof(d.detail->'found') = 'number' AND d.detail->>'found' <> '0'))`,
    {
      at: "d.at",
      key: `'desk:' || ${text("d.id")}`,
      event: "'desk_' || d.kind",
      actor: "'desk'",
      kind: "d.source",
      code: "d.detail->>'category'",
      n: "CASE WHEN jsonb_typeof(d.detail->'found') = 'number' THEN d.detail->>'found' END",
      record_table: "d.subject_table",
      record_id: text("d.subject_id"),
    },
  ),
  // A proposal, as drafted. An autopilot ask or off decision has no time of its own, so it rides
  // here as a tag.
  arm("proposals p", "p.tenant_id = current_tenant_id()", {
    at: "p.created_at",
    key: `'proposal:' || ${text("p.id")} || ':proposed'`,
    event: "'proposal_proposed'",
    actor: "'agent'",
    cents: text("p.amount_cents"),
    direction: "p.direction",
    title: "p.title",
    kind: "p.kind",
    code: "CASE WHEN p.autopilot_decision->>'mode' IN ('ask', 'off') THEN p.autopilot_decision->>'mode' END",
    reason: "CASE WHEN p.autopilot_decision->>'mode' IN ('ask', 'off') THEN p.autopilot_decision->>'reason' END",
    record_table: "p.subject_table",
    record_id: text("p.subject_id"),
  }),
  // Its second check's verdict.
  arm("proposals p", "p.tenant_id = current_tenant_id() AND p.auditor_checked_at IS NOT NULL", {
    at: "p.auditor_checked_at",
    key: `'proposal:' || ${text("p.id")} || ':audited'`,
    event: "'proposal_audited'",
    actor: "'agent'",
    title: "p.title",
    kind: "p.kind",
    code: "p.auditor_verdict",
    record_table: "p.subject_table",
    record_id: text("p.subject_id"),
  }),
  // Its decision: approved (and maybe carried out since) or rejected. An expired one is not a
  // decision anyone made.
  arm(
    `proposals p ${JOIN_SUB("m", "p.decided_by")}`,
    "p.tenant_id = current_tenant_id() AND p.decided_at IS NOT NULL AND p.status <> 'expired'",
    {
      at: "p.decided_at",
      key: `'proposal:' || ${text("p.id")} || ':decided'`,
      event: "'proposal_decided'",
      actor: actorOf("p.decided_by", "m.role"),
      cents: text("p.amount_cents"),
      direction: "p.direction",
      title: "p.title",
      kind: "p.kind",
      code: "CASE WHEN p.status = 'rejected' THEN 'rejected' ELSE 'approved' END",
      limit_cents: "CASE WHEN p.autopilot_decision->>'mode' = 'auto' THEN p.autopilot_decision->>'maxCents' END",
      record_table: "p.subject_table",
      record_id: text("p.subject_id"),
    },
  ),
  // A money action sent. One sent and settled by the answer in the same instant shows once, on
  // its settled line. The approver is the membership row it names.
  arm(
    "money_actions x LEFT JOIN memberships m ON m.tenant_id = current_tenant_id() AND m.id = x.approver_membership_id",
    `x.tenant_id = current_tenant_id() AND x.sent_at IS NOT NULL
      AND NOT (x.settled_via IS NOT DISTINCT FROM 'response' AND x.settled_at IS NOT DISTINCT FROM x.sent_at)`,
    {
      at: "x.sent_at",
      key: `'money:' || ${text("x.id")} || ':sent'`,
      event: "'money_sent'",
      actor: actorOf("m.cognito_sub", "m.role"),
      cents: text("x.amount_cents"),
      kind: "x.kind",
      code: "x.state",
      channel: "x.channel",
      system: "x.outside_system",
      record_table: "x.subject_table",
      record_id: text("x.subject_id"),
    },
  ),
  // Its outcome: confirmed or failed. An unknown one has no settled time; its sent line says so.
  arm(
    "money_actions x LEFT JOIN memberships m ON m.tenant_id = current_tenant_id() AND m.id = x.approver_membership_id",
    "x.tenant_id = current_tenant_id() AND x.settled_at IS NOT NULL AND x.state IN ('confirmed', 'failed')",
    {
      at: "x.settled_at",
      key: `'money:' || ${text("x.id")} || ':settled'`,
      event: "'money_settled'",
      actor: actorOf("m.cognito_sub", "m.role"),
      cents: text("x.amount_cents"),
      kind: "x.kind",
      code: "x.state",
      reason: "x.failure_category",
      channel: "x.channel",
      system: "x.outside_system",
      once: "CASE WHEN x.settled_via = 'response' AND x.settled_at = x.sent_at THEN 'yes' END",
      record_table: "x.subject_table",
      record_id: text("x.subject_id"),
    },
  ),
  // A change the owner made to the autopilot: a pause, a resume, or a rule's new values.
  arm(`autopilot_changes c ${JOIN_SUB("m", "c.changed_by")}`, "c.tenant_id = current_tenant_id()", {
    at: "c.created_at",
    key: `'autopilot:' || ${text("c.id")}`,
    event: `CASE WHEN c.subject = 'rule' THEN 'autopilot_rule'
      WHEN c.after->>'pausedAt' IS NULL THEN 'autopilot_resume' ELSE 'autopilot_pause' END`,
    actor: actorOf("c.changed_by", "m.role"),
    kind: "c.kind",
    code: "CASE WHEN c.subject = 'rule' THEN c.after->>'mode' END",
    limit_cents: "CASE WHEN c.subject = 'rule' THEN c.after->>'maxCents' END",
    day_cents: "CASE WHEN c.subject = 'rule' THEN c.after->>'dayMaxCents' END",
    until_at: "CASE WHEN c.subject = 'pause' THEN c.after->>'pausedUntil' END",
  }),
  // One approval over a listed set, started and finished.
  arm(`approval_batches b ${JOIN_SUB("m", "b.requested_by")}`, "b.tenant_id = current_tenant_id()", {
    at: "b.created_at",
    key: `'batch:' || ${text("b.id")} || ':started'`,
    event: "'batch_started'",
    actor: actorOf("b.requested_by", "m.role"),
    cents: text("b.total_cents"),
    kind: "b.scope",
    n: text("cardinality(b.item_ids)"),
  }),
  arm(`approval_batches b ${JOIN_SUB("m", "b.requested_by")}`, "b.tenant_id = current_tenant_id() AND b.finished_at IS NOT NULL", {
    at: "b.finished_at",
    key: `'batch:' || ${text("b.id")} || ':finished'`,
    event: "'batch_finished'",
    actor: actorOf("b.requested_by", "m.role"),
    kind: "b.scope",
    code: "b.status",
    n: text("cardinality(b.item_ids)"),
  }),
];

const FEED_SQL = `SELECT ${ts("f.at")} AS at, ${COLUMNS.filter((c) => c !== "at")
  .map((c) => `f.${c}`)
  .join(", ")}
  FROM (${ARMS.join("\nUNION ALL\n")}) f
 ORDER BY f.at DESC, f.key COLLATE "C" DESC
 LIMIT $1`;

type Raw = Record<Column, unknown>;

const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const codeOrNull = (v: unknown): string | null => (typeof v === "string" && CODE.test(v) ? v : null);

// Whole, safe, not negative, or null when the row has none. Anything else is a row that does not
// read: the read fails rather than show a wrong figure.
function wholeOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) throw new DbError("unknown");
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new DbError("unknown");
  return n;
}

const isEvent = (v: unknown): v is FeedEvent => typeof v === "string" && (FEED_EVENTS as readonly string[]).includes(v);
const isActor = (v: unknown): v is FeedActor => typeof v === "string" && (FEED_ACTORS as readonly string[]).includes(v);

// One stored row as a feed row, taking only the fixed fields, each only in its own shape. A row
// whose time, key, event or actor does not read fails the read (unknown is not empty).
export function feedRowOf(r: Partial<Raw>): FeedRow {
  if (typeof r.at !== "string" || !AT.test(r.at) || Number.isNaN(Date.parse(r.at))) throw new DbError("unknown");
  if (typeof r.key !== "string" || !KEY.test(r.key)) throw new DbError("unknown");
  if (!isEvent(r.event) || !isActor(r.actor)) throw new DbError("unknown");
  const table = codeOrNull(r.record_table);
  const id = typeof r.record_id === "string" && /^[0-9a-f-]{36}$/.test(r.record_id) ? r.record_id : null;
  const until = textOrNull(r.until_at);
  return {
    key: r.key,
    at: r.at,
    event: r.event,
    actor: r.actor,
    cents: wholeOrNull(r.cents),
    direction: codeOrNull(r.direction),
    title: textOrNull(r.title),
    kind: codeOrNull(r.kind),
    code: codeOrNull(r.code),
    reason: codeOrNull(r.reason),
    count: wholeOrNull(r.n),
    limitCents: wholeOrNull(r.limit_cents),
    dayLimitCents: wholeOrNull(r.day_cents),
    until: until !== null && isRealInstant(until) ? until : null,
    channel: codeOrNull(r.channel),
    system: codeOrNull(r.system),
    once: r.once === "yes",
    record: table !== null && id !== null ? { table, id } : null,
  };
}

// ?before=<instant>|<key>, as the Older link writes it. Anything else reads the first page.
export function parseCursor(raw: unknown): FeedCursor | null {
  if (typeof raw !== "string" || raw.length > 120) return null;
  const at = raw.slice(0, raw.indexOf("|"));
  const key = raw.slice(raw.indexOf("|") + 1);
  if (!raw.includes("|") || !AT.test(at) || Number.isNaN(Date.parse(at)) || !KEY.test(key)) return null;
  return { at, key };
}

export const cursorParam = (c: FeedCursor): string => `${c.at}|${c.key}`;

export const FEED_MAX_LIMIT = 200;

// The newest `limit` lines before the cursor (the first page without one), and the cursor of the
// next page when there is one.
export async function readFeed(
  q: Queryable,
  opts: { limit: number; before?: FeedCursor | null },
): Promise<{ rows: FeedRow[]; next: FeedCursor | null }> {
  const { limit } = opts;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FEED_MAX_LIMIT) throw new RangeError("a feed page is 1 to 200 lines");
  const before = opts.before ?? FIRST;
  // One more than asked, to know whether an older page exists.
  const raw = await q.query<Raw>(FEED_SQL, [limit + 1, before.at, before.key]);
  const rows = raw.map(feedRowOf);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > limit && last ? { at: last.at, key: last.key } : null };
}

export type FeedHeader = { deskCheckedAt: string | null; paused: boolean };

const DESK_SQL = `SELECT ${ts("max(at)")} AS at FROM desk_log WHERE tenant_id = current_tenant_id() AND kind = 'sleep'`;

// The page's header line: when the desk last checked in (its newest wake's end, quiet or not), and
// whether the autopilot is paused at this instant.
export async function readFeedHeader(q: Queryable, nowMs: number): Promise<FeedHeader> {
  const rows = await q.query<{ at: unknown }>(DESK_SQL, []);
  if (rows.length !== 1) throw new DbError("unknown");
  const at = rows[0].at;
  if (at !== null && (typeof at !== "string" || !AT.test(at))) throw new DbError("unknown");
  return { deskCheckedAt: at, paused: isPaused(await readPause(q), nowMs) };
}
