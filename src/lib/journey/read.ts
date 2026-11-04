import { flags } from "@/config/flags";
import { DbError, type Queryable } from "../db";
import { eventKey } from "../desk/keys";
import { viewOf } from "../documents/service";
import { LIST_COLUMNS, type DocumentMetaRow } from "../documents/store";
import { MONEY_ACTION_KINDS, MONEY_ACTION_STATES } from "../money/types";
import { addDays, localDateOf } from "../time/local-date";
import { dispatchText } from "../tms/read";
import { isUuid } from "../uuid";
import type {
  ActorCode,
  JourneyAdvance,
  JourneyCard,
  JourneyDispatch,
  JourneyDocument,
  JourneyFacts,
  JourneyLine,
  JourneyLoad,
  JourneyMoney,
  JourneyMove,
  JourneySettlement,
  LoadStatus,
  MoveSource,
} from "./steps";

// The load journey's reads (src/lib/journey/steps.ts builds the steps). SELECT only, inside the
// caller's tenant transaction, every statement naming its tenant on top of row-level security. One
// statement per table for all the loads asked about, never one per load, so the On the road board
// reads the same few statements whatever its row count. What leaves here is codes, cents, times,
// role words and the document's reading; never a login id, a note, an idempotency key or error
// text.

const ts = (column: string, as: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${as}`;

// The role word of the login that decided a card, as the live feed resolves it (src/lib/feed/read.ts).
const DECIDER = `CASE
    WHEN p.decided_by IS NULL THEN NULL
    WHEN p.decided_by LIKE 'service:autopilot:%' THEN 'autopilot'
    WHEN p.decided_by LIKE 'service:%' THEN 'desk'
    WHEN m.role IN ('admin', 'staff', 'judge') THEN m.role
    ELSE 'someone' END`;

const CARD_COLUMNS = `CAST(p.id AS text) AS id, p.status, p.amount_cents, ${ts("p.created_at", "created_at")},
  p.auditor_verdict, p.autopilot_decision->>'mode' AS autopilot_mode,
  ${ts("p.decided_at", "decided_at")}, ${DECIDER} AS decided_by`;
const CARD_FROM = `proposals p
  LEFT JOIN memberships m ON m.tenant_id = current_tenant_id() AND m.cognito_sub = p.decided_by`;

const LOAD_STATUSES = ["planned", "in_transit", "delivered", "invoiced", "cancelled"] as const;
const MOVE_SOURCES = ["driver_photo", "driver_text", "driver_voice", "staff", "demo_feed", "seed", "tms"] as const;
const CARD_STATUSES = ["proposed", "approved", "rejected", "expired", "executing", "done", "failed"] as const;
const ADVANCE_STATUSES = ["requested", "approved", "paid", "rejected", "cancelled", "parked"] as const;
const SETTLEMENT_STATUSES = ["draft", "approved", "paid"] as const;
const ACTORS = ["admin", "staff", "judge", "autopilot", "desk", "someone"] as const;

// A row that does not read back as stored is unknown, never guessed at.
function fail(): never {
  throw new DbError("unknown");
}
function cents(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isSafeInteger(n) ? (n as number) : fail();
}
function text(v: unknown): string {
  return typeof v === "string" ? v : fail();
}
function textOrNull(v: unknown): string | null {
  return v === null ? null : text(v);
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fail();
}
function oneOfOrNull<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return v === null ? null : oneOf(v, allowed);
}
function json(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fail();
  }
}

type Row = Record<string, unknown>;

// A list as one Postgres array literal, each element quoted, for CAST($n AS uuid[]) or text[].
function list(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(",")}}`;
}

function cardOf(r: Row): JourneyCard {
  return {
    id: text(r.id),
    status: oneOf(r.status, CARD_STATUSES),
    amountCents: cents(r.amount_cents),
    createdAt: text(r.created_at),
    auditVerdict: textOrNull(r.auditor_verdict),
    autopilotMode: textOrNull(r.autopilot_mode),
    decidedAt: textOrNull(r.decided_at),
    decidedBy: oneOfOrNull<ActorCode>(r.decided_by, ACTORS),
  };
}

const MONEY_COLUMNS = `CAST(subject_id AS text) AS subject_id, kind, attempt, state, failure_category, check_count,
  amount_cents, outside_system, outside_id, ${ts("settled_at", "settled_at")}, ${ts("created_at", "created_at")}`;

function moneyOf(r: Row): JourneyMoney {
  return {
    kind: oneOf(r.kind, MONEY_ACTION_KINDS),
    attempt: cents(r.attempt),
    state: oneOf(r.state, MONEY_ACTION_STATES),
    failureCategory: textOrNull(r.failure_category),
    checkCount: cents(r.check_count),
    amountCents: cents(r.amount_cents),
    outsideSystem: textOrNull(r.outside_system),
    outsideId: textOrNull(r.outside_id),
    settledAt: textOrNull(r.settled_at),
    createdAt: text(r.created_at),
  };
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function newest<T extends { createdAt: string }>(rows: readonly T[] | undefined): T | null {
  return (rows ?? []).reduce<T | null>((top, r) => (top === null || r.createdAt > top.createdAt ? r : top), null);
}

// The document behind a driver's photo, as its page reads it, without the transcription. A row
// whose reading does not parse shows as no reading, never as a guessed one.
function documentOf(row: DocumentMetaRow, now: Date): JourneyDocument | null {
  try {
    const v = viewOf(row, now, { plan: false });
    return { id: v.id, filename: v.filename, mime: v.mime, kind: v.kind, readStatus: v.readStatus, stalled: v.stalled, read: v.read, match: v.match };
  } catch {
    return null;
  }
}

function linesOf(r: Row): JourneyLine {
  const sources = json(r.sources);
  const meta = r.meta === null ? null : json(r.meta);
  if (!Array.isArray(sources)) fail();
  return {
    seq: cents(r.seq),
    kind: text(r.kind),
    label: text(r.label),
    amountCents: cents(r.amount_cents),
    sources: sources.map((s: unknown) => {
      const ref = s as { table?: unknown; id?: unknown };
      return { table: text(ref?.table), id: text(ref?.id) };
    }),
    meta: meta !== null && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null,
  };
}

// Every journey fact for the loads named, by load id. A load id that is not this carrier's is
// left out of the map.
export async function readJourneys(q: Queryable, loadIds: readonly string[], now: Date): Promise<Map<string, JourneyFacts>> {
  const ids = [...new Set(loadIds)].filter(isUuid);
  const out = new Map<string, JourneyFacts>();
  if (ids.length === 0) return out;

  const loadRows = await q.query<Row>(
    `SELECT CAST(l.id AS text) AS id, l.load_number, l.status, CAST(l.driver_id AS text) AS driver_id,
            d.first_name || ' ' || d.last_name AS driver_name,
            l.origin_city || ', ' || l.origin_state AS origin, l.dest_city || ', ' || l.dest_state AS destination,
            ${ts("l.pickup_departed_at", "picked_up_at")}, ${ts("l.delivered_at", "delivered_at")}
       FROM loads l
       LEFT JOIN drivers d ON d.tenant_id = current_tenant_id() AND d.id = l.driver_id
      WHERE l.tenant_id = current_tenant_id() AND l.id = ANY(CAST($1 AS uuid[]))`,
    [list(ids)],
  );
  const loads: JourneyLoad[] = loadRows.map((r) => ({
    id: text(r.id),
    number: text(r.load_number),
    status: oneOf<LoadStatus>(r.status, LOAD_STATUSES),
    driverId: textOrNull(r.driver_id),
    driverName: textOrNull(r.driver_name),
    origin: text(r.origin),
    destination: text(r.destination),
    pickedUpAt: textOrNull(r.picked_up_at),
    deliveredAt: textOrNull(r.delivered_at),
  }));
  if (loads.length === 0) return out;
  const found = loads.map((l) => l.id);

  // The recorded pickups and deliveries, oldest first, with the document behind each driver's photo
  // and what the desk did with each move. A cancel is the load's status, not a step on its road.
  const eventRows = await q.query<Row>(
    `SELECT CAST(id AS text) AS id, CAST(load_id AS text) AS load_id, to_status, source, evidence_table,
            CAST(evidence_id AS text) AS evidence_id, ${ts("at", "at")}
       FROM load_events
      WHERE tenant_id = current_tenant_id() AND load_id = ANY(CAST($1 AS uuid[]))
        AND to_status IN ('in_transit', 'delivered')
      ORDER BY at, id`,
    [list(found)],
  );
  const docIds = eventRows.filter((r) => r.evidence_table === "documents").map((r) => text(r.evidence_id));
  const docRows =
    docIds.length === 0
      ? []
      : await q.query<DocumentMetaRow>(
          `SELECT ${LIST_COLUMNS} FROM documents WHERE tenant_id = current_tenant_id() AND id = ANY(CAST($1 AS uuid[]))`,
          [list(docIds)],
        );
  const docs = new Map(docRows.map((r) => [r.id, documentOf(r, now)]));
  const eventIds = eventRows.map((r) => text(r.id));
  const deskRows =
    eventIds.length === 0
      ? []
      : await q.query<Row>(
          `SELECT event_key, kind, detail->>'category' AS category, ${ts("at", "at")}
             FROM desk_log
            WHERE tenant_id = current_tenant_id() AND event_key = ANY(CAST($1 AS text[])) AND kind IN ('done', 'failed')
            ORDER BY at`,
          [list(eventIds.map((id) => eventKey("load_event", id)))],
        );
  // A done line wins over a failed one; the newest of a kind wins.
  const desk = new Map<string, JourneyMove["desk"]>();
  for (const r of deskRows) {
    const key = text(r.event_key);
    const kind = oneOf(r.kind, ["done", "failed"] as const);
    if (desk.get(key)?.kind === "done" && kind === "failed") continue;
    desk.set(key, { kind, category: textOrNull(r.category), at: text(r.at) });
  }
  const moves = groupBy(
    eventRows.map((r) => ({
      loadId: text(r.load_id),
      move: {
        id: text(r.id),
        toStatus: oneOf(r.to_status, ["in_transit", "delivered"] as const),
        source: oneOf<MoveSource>(r.source, MOVE_SOURCES),
        at: text(r.at),
        document: r.evidence_table === "documents" ? (docs.get(text(r.evidence_id)) ?? null) : null,
        desk: desk.get(eventKey("load_event", text(r.id))) ?? null,
      } satisfies JourneyMove,
    })),
    (r) => r.loadId,
  );

  // The advance card drafted at pickup names its load in its args (src/lib/advances/at-pickup.ts).
  const cardRows = await q.query<Row>(
    `SELECT p.args->>'loadId' AS load_id, ${CARD_COLUMNS}
       FROM ${CARD_FROM}
      WHERE p.tenant_id = current_tenant_id() AND p.kind = 'advance_payout' AND p.args->>'loadId' = ANY(CAST($1 AS text[]))`,
    [list(found)],
  );
  const cards = groupBy(
    cardRows.map((r) => ({ loadId: text(r.load_id), ...cardOf(r) })),
    (r) => r.loadId,
  );

  const advanceRows = await q.query<Row>(
    `SELECT CAST(id AS text) AS id, CAST(load_id AS text) AS load_id, status, amount_cents, ${ts("paid_at", "paid_at")},
            ${ts("created_at", "created_at")}, CAST(proposal_id AS text) AS proposal_id
       FROM advances
      WHERE tenant_id = current_tenant_id() AND load_id = ANY(CAST($1 AS uuid[]))`,
    [list(found)],
  );
  const advances = groupBy(
    advanceRows.map((r) => ({
      loadId: text(r.load_id),
      id: text(r.id),
      status: oneOf(r.status, ADVANCE_STATUSES),
      amountCents: cents(r.amount_cents),
      paidAt: textOrNull(r.paid_at),
      createdAt: text(r.created_at),
      proposalId: textOrNull(r.proposal_id),
    })),
    (r) => r.loadId,
  );

  // The paystub that carries each load: this driver's settlement with a stored line citing the load.
  const stubRows = await q.query<Row>(
    `SELECT DISTINCT ON (l.id) CAST(l.id AS text) AS load_id, CAST(s.id AS text) AS id, s.status, s.gross_cents,
            s.deductions_cents, s.net_cents, ${ts("s.paid_at", "paid_at")}, s.parked_reason, ${ts("s.created_at", "created_at")},
            CAST(sp.period_start AS text) AS period_start, CAST(sp.period_end AS text) AS period_end
       FROM loads l
       JOIN settlements s ON s.tenant_id = current_tenant_id() AND s.driver_id = l.driver_id
       JOIN settlement_periods sp ON sp.tenant_id = current_tenant_id() AND sp.id = s.period_id
      WHERE l.tenant_id = current_tenant_id() AND l.id = ANY(CAST($1 AS uuid[])) AND l.delivered_on IS NOT NULL
        AND EXISTS (SELECT 1 FROM settlement_lines sl
                     WHERE sl.tenant_id = current_tenant_id() AND sl.settlement_id = s.id
                       AND sl.sources @> jsonb_build_array(jsonb_build_object('table', 'loads', 'id', CAST(l.id AS text))))
      ORDER BY l.id, s.created_at DESC`,
    [list(found)],
  );
  const stubIds = [...new Set(stubRows.map((r) => text(r.id)))];
  const lineRows =
    stubIds.length === 0
      ? []
      : await q.query<Row>(
          `SELECT CAST(settlement_id AS text) AS settlement_id, seq, kind, label, amount_cents,
                  CAST(sources AS text) AS sources, CAST(meta AS text) AS meta
             FROM settlement_lines
            WHERE tenant_id = current_tenant_id() AND settlement_id = ANY(CAST($1 AS uuid[]))
            ORDER BY settlement_id, seq`,
          [list(stubIds)],
        );
  const lines = groupBy(
    lineRows.map((r) => ({ settlementId: text(r.settlement_id), line: linesOf(r) })),
    (r) => r.settlementId,
  );
  const stubCardRows =
    stubIds.length === 0
      ? []
      : await q.query<Row>(
          `SELECT CAST(p.subject_id AS text) AS settlement_id, ${CARD_COLUMNS}
             FROM ${CARD_FROM}
            WHERE p.tenant_id = current_tenant_id() AND p.kind = 'settlement_approve'
              AND p.subject_table = 'settlements' AND p.subject_id = ANY(CAST($1 AS uuid[]))`,
          [list(stubIds)],
        );
  const stubCards = groupBy(
    stubCardRows.map((r) => ({ settlementId: text(r.settlement_id), ...cardOf(r) })),
    (r) => r.settlementId,
  );

  // The ledger rows of the advances and the paystubs, in one statement.
  const advanceIds = advanceRows.map((r) => text(r.id));
  const moneyRows =
    advanceIds.length + stubIds.length === 0
      ? []
      : await q.query<Row>(
          `SELECT subject_table, ${MONEY_COLUMNS}
             FROM money_actions
            WHERE tenant_id = current_tenant_id()
              AND ((subject_table = 'advances' AND subject_id = ANY(CAST($1 AS uuid[])))
                OR (subject_table = 'settlements' AND subject_id = ANY(CAST($2 AS uuid[]))))`,
          [list(advanceIds), list(stubIds)],
        );
  const money = groupBy(
    moneyRows.map((r) => ({ subject: `${text(r.subject_table)}:${text(r.subject_id)}`, row: moneyOf(r) })),
    (r) => r.subject,
  );

  const dispatch = await readDispatch(q, loads);

  for (const load of loads) {
    const card = newest(cards.get(load.id));
    const own = advances.get(load.id) ?? [];
    const advance: JourneyAdvance | null =
      (card !== null ? own.find((a) => a.proposalId === card.id) : undefined) ?? newest(own);
    const stub = stubRows.find((r) => r.load_id === load.id);
    let settlement: JourneySettlement | null = null;
    if (stub) {
      const id = text(stub.id);
      settlement = {
        id,
        status: oneOf(stub.status, SETTLEMENT_STATUSES),
        grossCents: cents(stub.gross_cents),
        deductionsCents: cents(stub.deductions_cents),
        netCents: cents(stub.net_cents),
        paidAt: textOrNull(stub.paid_at),
        parkedReason: textOrNull(stub.parked_reason),
        createdAt: text(stub.created_at),
        periodStart: text(stub.period_start),
        periodEnd: text(stub.period_end),
        lines: (lines.get(id) ?? []).map((l) => l.line),
        card: newest(stubCards.get(id)),
        legs: (money.get(`settlements:${id}`) ?? []).map((m) => m.row),
      };
    }
    out.set(load.id, {
      load,
      moves: (moves.get(load.id) ?? []).map((m) => m.move),
      card,
      advance,
      advanceMoney: advance !== null ? (money.get(`advances:${advance.id}`) ?? []).map((m) => m.row) : [],
      settlement,
      dispatch: dispatch.get(load.id) ?? { truck: null, dueLocal: null },
    });
  }
  return out;
}

// The truck and the last delivery window from the dispatch mirror (tms_loads linked to our load),
// else from the sample dispatch board by load number. Outside text that reads like an instruction
// is dropped (dispatchText), never shown.
async function readDispatch(q: Queryable, loads: readonly JourneyLoad[]): Promise<Map<string, JourneyDispatch>> {
  const out = new Map<string, JourneyDispatch>();
  const due = (table: string, fk: string, alias: string) => `(SELECT COALESCE(s.appt_to_local, s.appt_from_local) FROM ${table} s
      WHERE s.tenant_id = current_tenant_id() AND s.${fk} = ${alias}.id AND s.stop_kind = 'delivery'
      ORDER BY s.ordinal DESC LIMIT 1) AS due_local`;
  const mirror = await q.query<Row>(
    `SELECT CAST(t.load_id AS text) AS load_id, t.truck_unit, ${due("tms_stops", "tms_load_id", "t")}
       FROM tms_loads t
      WHERE t.tenant_id = current_tenant_id() AND t.load_id = ANY(CAST($1 AS uuid[])) AND t.gone_at IS NULL`,
    [list(loads.map((l) => l.id))],
  );
  for (const r of mirror) {
    out.set(text(r.load_id), { truck: dispatchText(textOrNull(r.truck_unit)), dueLocal: textOrNull(r.due_local) });
  }
  const rest = loads.filter((l) => !out.has(l.id));
  if (!flags.mockTms.enabled || rest.length === 0) return out;
  const board = await q.query<Row>(
    `SELECT m.reference, m.truck_unit, ${due("mock_tms_stops", "mock_load_id", "m")}
       FROM mock_tms_loads m
      WHERE m.tenant_id = current_tenant_id() AND m.reference = ANY(CAST($1 AS text[]))`,
    [list(rest.map((l) => l.number))],
  );
  const byNumber = new Map(board.map((r) => [text(r.reference), r]));
  for (const l of rest) {
    const r = byNumber.get(l.number);
    if (r) out.set(l.id, { truck: dispatchText(textOrNull(r.truck_unit)), dueLocal: textOrNull(r.due_local) });
  }
  return out;
}

// How far back a delivered load still shows on the board while its paystub is not yet paid and
// recorded, the most loads the board shows, and the most candidates it reads to find them (the
// steps drop the finished ones before the board's own cap applies).
export const BOARD_DAYS = 14;
export const BOARD_LIMIT = 100;
export const BOARD_CANDIDATES = 300;

// The board's candidate loads: planned with a driver, on the way, or delivered in the last
// BOARD_DAYS days (the steps then drop the ones already paid and recorded). Loads on the way come
// first, then delivered, then planned, so a cap never drops a truck still out for a newer plan.
// more: more loads matched than the board reads.
export async function readBoardLoadIds(q: Queryable, now: Date, zone: string): Promise<{ ids: string[]; more: boolean }> {
  const since = addDays(localDateOf(now.toISOString(), zone), -BOARD_DAYS);
  const rows = await q.query<{ id: string }>(
    `SELECT CAST(id AS text) AS id FROM loads
      WHERE tenant_id = current_tenant_id()
        AND ((status = 'planned' AND driver_id IS NOT NULL) OR status = 'in_transit'
          OR (status IN ('delivered', 'invoiced') AND delivered_on >= CAST($1 AS date)))
      ORDER BY CASE status WHEN 'in_transit' THEN 0 WHEN 'delivered' THEN 1 WHEN 'invoiced' THEN 1 ELSE 2 END,
        pickup_on DESC, id
      LIMIT ${BOARD_CANDIDATES + 1}`,
    [since],
  );
  return { ids: rows.slice(0, BOARD_CANDIDATES).map((r) => r.id), more: rows.length > BOARD_CANDIDATES };
}
