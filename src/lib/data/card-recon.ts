import type { Queryable } from "../db";
import type {
  BreakCategory,
  CandidateDay,
  CandidateDriver,
  CandidateLoad,
  CandidateStateMiles,
  CardFact,
  CardLoadFact,
  FixKind,
  MatchTxn,
  PurchaseFact,
  Severity,
  StatementTxn,
} from "../rules-engine/card-recon";
import { addDays, type LocalDate, type Period } from "../time/local-date";
import { isUuid } from "../uuid";

// The card check's reads, SELECT only, each naming its tenant (`tenant_id = current_tenant_id()`)
// so a login that bypasses row-level security still reads one carrier. A card's token is read only
// where a comparison needs it (the statement against the cards on file) and never leaves this
// module in a list a page or a tool shows: those carry the last four digits.

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const MAX_STATEMENT_ROWS = 2_000;

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error("not a whole number");
  return n;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
// Both drivers' spellings of true. Anything else reads as false; the unique keys stay the backstop.
const truthy = (v: unknown): boolean => v === true || v === "t" || v === "true" || v === 1;

// The statement rows posted inside the window.
export async function readStatement(q: Queryable, window: Period): Promise<StatementTxn[]> {
  const rows = await q.query<Record<string, unknown>>(
    `SELECT CAST(id AS text) AS id, provider_ref, kind, card_token, card_last4, portal_name,
            CAST(posted_on AS text) AS posted_on, amount_cents, state, gallons_milli
       FROM card_transactions
      WHERE tenant_id = current_tenant_id()
        AND posted_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)
      ORDER BY posted_on, id LIMIT ${MAX_STATEMENT_ROWS}`,
    [window.start, window.end],
  );
  return rows.map((r) => ({
    id: String(r.id),
    providerRef: String(r.provider_ref),
    kind: r.kind === "load" ? "load" : "fuel",
    cardToken: String(r.card_token),
    cardLast4: String(r.card_last4),
    portalName: String(r.portal_name),
    postedOn: String(r.posted_on) as LocalDate,
    amountCents: num(r.amount_cents),
    state: r.state === null ? null : String(r.state),
    gallonsMilli: numOrNull(r.gallons_milli),
  }));
}

// The fuel purchases the window's statement rows name, by their purchase reference.
export async function readStatementPurchases(q: Queryable, window: Period): Promise<PurchaseFact[]> {
  const rows = await q.query<Record<string, unknown>>(
    `SELECT CAST(p.id AS text) AS id, CAST(p.driver_id AS text) AS driver_id, p.purchase_ref, p.amount_cents
       FROM fuel_purchases p
      WHERE p.tenant_id = current_tenant_id()
        AND p.purchase_ref IN (
          SELECT t.provider_ref FROM card_transactions t
           WHERE t.tenant_id = current_tenant_id() AND t.kind = 'fuel'
             AND t.posted_on BETWEEN CAST($1 AS date) AND CAST($2 AS date))
      ORDER BY p.purchase_ref, p.id`,
    [window.start, window.end],
  );
  return rows.map((r) => ({
    id: String(r.id),
    driverId: String(r.driver_id),
    purchaseRef: String(r.purchase_ref),
    amountCents: num(r.amount_cents),
  }));
}

// Every card on file, open or closed: a closed card is still a known card.
export async function readCardsOnFile(q: Queryable): Promise<CardFact[]> {
  const rows = await q.query<Record<string, unknown>>(
    `SELECT CAST(driver_id AS text) AS driver_id, provider_token, portal_name, status
       FROM driver_cards WHERE tenant_id = current_tenant_id() ORDER BY driver_id, id`,
  );
  return rows.map((r) => ({
    driverId: String(r.driver_id),
    providerToken: String(r.provider_token),
    portalName: r.portal_name === null ? null : String(r.portal_name),
    status: r.status === "active" ? "active" : "closed",
  }));
}

// The confirmed card loads in our records that the window's statement load rows name: an advance
// paid to a fuel card, by the card provider's load id.
export async function readCardLoads(q: Queryable, window: Period): Promise<CardLoadFact[]> {
  const rows = await q.query<Record<string, unknown>>(
    `SELECT CAST(m.id AS text) AS id, m.outside_id, m.amount_cents, CAST(m.counterparty_id AS text) AS driver_id
       FROM money_actions m
      WHERE m.tenant_id = current_tenant_id() AND m.kind = 'advance_payout'
        AND m.outside_system = 'fuel_card_sim' AND m.state = 'confirmed'
        AND m.outside_id IN (
          SELECT t.provider_ref FROM card_transactions t
           WHERE t.tenant_id = current_tenant_id() AND t.kind = 'load'
             AND t.posted_on BETWEEN CAST($1 AS date) AND CAST($2 AS date))
      ORDER BY m.outside_id, m.id`,
    [window.start, window.end],
  );
  return rows.map((r) => ({
    moneyActionId: String(r.id),
    outsideId: String(r.outside_id),
    amountCents: num(r.amount_cents),
    driverId: r.driver_id === null ? null : String(r.driver_id),
  }));
}

// What the candidates for one unknown card are ranked from: drivers, their days on the posting
// day and the day either side, those days' loads and states, and the cards on file.
export async function readCandidateFacts(
  q: Queryable,
  postedOn: LocalDate,
): Promise<{
  drivers: CandidateDriver[];
  days: CandidateDay[];
  loads: CandidateLoad[];
  stateMiles: CandidateStateMiles[];
  cards: CardFact[];
}> {
  const from = addDays(postedOn, -1);
  const to = addDays(postedOn, 1);
  const drivers = await q.query<Record<string, unknown>>(
    `SELECT CAST(id AS text) AS id, code, CAST(active_from AS text) AS active_from,
            CAST(active_to AS text) AS active_to
       FROM drivers WHERE tenant_id = current_tenant_id() ORDER BY code, id`,
  );
  const days = await q.query<Record<string, unknown>>(
    `SELECT CAST(driver_id AS text) AS driver_id, CAST(day AS text) AS day, CAST(load_id AS text) AS load_id
       FROM driver_days
      WHERE tenant_id = current_tenant_id() AND day BETWEEN CAST($1 AS date) AND CAST($2 AS date)
      ORDER BY driver_id, day, load_id`,
    [from, to],
  );
  const loads = await q.query<Record<string, unknown>>(
    `SELECT CAST(l.id AS text) AS id, l.origin_state, l.dest_state
       FROM loads l
      WHERE l.tenant_id = current_tenant_id()
        AND l.id IN (SELECT d.load_id FROM driver_days d
                      WHERE d.tenant_id = current_tenant_id() AND d.load_id IS NOT NULL
                        AND d.day BETWEEN CAST($1 AS date) AND CAST($2 AS date))
      ORDER BY l.id`,
    [from, to],
  );
  const stateMiles = await q.query<Record<string, unknown>>(
    `SELECT CAST(m.load_id AS text) AS load_id, m.state
       FROM load_state_miles m
      WHERE m.tenant_id = current_tenant_id()
        AND m.load_id IN (SELECT d.load_id FROM driver_days d
                           WHERE d.tenant_id = current_tenant_id() AND d.load_id IS NOT NULL
                             AND d.day BETWEEN CAST($1 AS date) AND CAST($2 AS date))
      ORDER BY m.load_id, m.state`,
    [from, to],
  );
  return {
    drivers: drivers.map((r) => ({
      id: String(r.id),
      code: String(r.code),
      activeFrom: String(r.active_from) as LocalDate,
      activeTo: r.active_to === null ? null : (String(r.active_to) as LocalDate),
    })),
    days: days.map((r) => ({
      driverId: String(r.driver_id),
      day: String(r.day) as LocalDate,
      loadId: r.load_id === null ? null : String(r.load_id),
    })),
    loads: loads.map((r) => ({ id: String(r.id), originState: String(r.origin_state), destState: String(r.dest_state) })),
    stateMiles: stateMiles.map((r) => ({ loadId: String(r.load_id), state: String(r.state) })),
    cards: await readCardsOnFile(q),
  };
}

// One statement row for a match card, and whether its card or its purchase reached our records
// since: either one means the card is no longer unknown. Never the token.
export type MatchFacts = {
  txn: MatchTxn;
  kind: "fuel" | "load";
  cardOnFile: boolean;
  purchaseOnFile: boolean;
};

export async function readMatchFacts(q: Queryable, transactionId: string): Promise<MatchFacts | null> {
  if (!isUuid(transactionId)) return null;
  const rows = await q.query<Record<string, unknown>>(
    `SELECT CAST(t.id AS text) AS id, t.provider_ref, t.kind, t.card_last4, t.portal_name,
            CAST(t.posted_on AS text) AS posted_on, t.amount_cents, t.state, t.gallons_milli,
            EXISTS (SELECT 1 FROM driver_cards c
                     WHERE c.tenant_id = t.tenant_id AND c.provider = t.provider
                       AND c.provider_token = t.card_token) AS card_on_file,
            EXISTS (SELECT 1 FROM fuel_purchases p
                     WHERE p.tenant_id = t.tenant_id AND p.purchase_ref = t.provider_ref) AS purchase_on_file
       FROM card_transactions t
      WHERE t.tenant_id = current_tenant_id() AND t.id = CAST($1 AS uuid)`,
    [transactionId.toLowerCase()],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  return {
    txn: {
      id: String(r.id),
      providerRef: String(r.provider_ref),
      last4: String(r.card_last4),
      portalName: String(r.portal_name),
      postedOn: String(r.posted_on) as LocalDate,
      state: r.state === null ? null : String(r.state),
      amountCents: num(r.amount_cents),
      gallonsMilli: numOrNull(r.gallons_milli),
    },
    kind: r.kind === "load" ? "load" : "fuel",
    cardOnFile: truthy(r.card_on_file),
    purchaseOnFile: truthy(r.purchase_on_file),
  };
}

// ---- Breaks and runs, as a page or a tool shows them ----

export const BREAK_STATUSES = ["open", "resolved", "dismissed"] as const;
export type BreakStatus = (typeof BREAK_STATUSES)[number];

export type BreakView = {
  id: string;
  category: BreakCategory;
  severity: Severity;
  outsideSystem: string | null;
  fixKind: FixKind;
  status: BreakStatus;
  dismissCategory: string | null;
  ourCents: number | null;
  outsideCents: number | null;
  explanation: string | null;
  proposalId: string | null;
  // The statement row, by its last four digits only.
  transaction: {
    id: string;
    kind: "fuel" | "load";
    last4: string;
    portalName: string;
    postedOn: LocalDate;
    state: string | null;
    gallonsMilli: number | null;
    amountCents: number;
  } | null;
  // The payment record it names: its kind and the record it is for.
  record: { id: string; kind: string; subjectTable: string; subjectId: string; state: string } | null;
  purchaseId: string | null;
  driver: { id: string; code: string } | null;
  firstSeenAt: string;
  updatedAt: string;
};

const BREAK_SQL = `
  SELECT CAST(b.id AS text) AS id, b.category, b.severity, b.outside_system, b.fix_kind, b.status,
         b.dismiss_category, b.our_cents, b.outside_cents, b.explanation,
         CAST(b.proposal_id AS text) AS proposal_id,
         CAST(t.id AS text) AS txn_id, t.kind AS txn_kind, t.card_last4, t.portal_name,
         CAST(t.posted_on AS text) AS posted_on, t.state AS txn_state, t.gallons_milli, t.amount_cents AS txn_cents,
         CAST(m.id AS text) AS money_id, m.kind AS money_kind, m.subject_table AS money_subject_table,
         CAST(m.subject_id AS text) AS money_subject_id, m.state AS money_state,
         CAST(b.fuel_purchase_id AS text) AS purchase_id,
         CAST(d.id AS text) AS driver_id, d.code AS driver_code,
         ${ts("r.started_at")} AS first_seen_at, ${ts("b.updated_at")} AS updated_at
    FROM card_recon_breaks b
    JOIN card_recon_runs r ON r.tenant_id = b.tenant_id AND r.id = b.first_seen_run_id
    LEFT JOIN card_transactions t ON t.tenant_id = b.tenant_id AND t.id = b.card_transaction_id
    LEFT JOIN money_actions m ON m.tenant_id = b.tenant_id AND m.id = b.money_action_id
    LEFT JOIN drivers d ON d.tenant_id = b.tenant_id AND d.id = b.driver_id
   WHERE b.tenant_id = current_tenant_id()`;

const SEVERITY_ORDER = "CASE b.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END";

function breakView(r: Record<string, unknown>): BreakView {
  return {
    id: String(r.id),
    category: String(r.category) as BreakCategory,
    severity: String(r.severity) as Severity,
    outsideSystem: r.outside_system === null ? null : String(r.outside_system),
    fixKind: String(r.fix_kind) as FixKind,
    status: String(r.status) as BreakStatus,
    dismissCategory: r.dismiss_category === null ? null : String(r.dismiss_category),
    ourCents: numOrNull(r.our_cents),
    outsideCents: numOrNull(r.outside_cents),
    explanation: r.explanation === null ? null : String(r.explanation),
    proposalId: r.proposal_id === null ? null : String(r.proposal_id),
    transaction:
      r.txn_id === null
        ? null
        : {
            id: String(r.txn_id),
            kind: r.txn_kind === "load" ? "load" : "fuel",
            last4: String(r.card_last4),
            portalName: String(r.portal_name),
            postedOn: String(r.posted_on) as LocalDate,
            state: r.txn_state === null ? null : String(r.txn_state),
            gallonsMilli: numOrNull(r.gallons_milli),
            amountCents: num(r.txn_cents),
          },
    record:
      r.money_id === null
        ? null
        : {
            id: String(r.money_id),
            kind: String(r.money_kind),
            subjectTable: String(r.money_subject_table),
            subjectId: String(r.money_subject_id),
            state: String(r.money_state),
          },
    purchaseId: r.purchase_id === null ? null : String(r.purchase_id),
    driver: r.driver_id === null ? null : { id: String(r.driver_id), code: String(r.driver_code) },
    firstSeenAt: String(r.first_seen_at),
    updatedAt: String(r.updated_at),
  };
}

// Breaks in one status, most severe first, then newest.
export async function readBreaks(q: Queryable, status: BreakStatus, limit: number): Promise<BreakView[]> {
  if (!(BREAK_STATUSES as readonly string[]).includes(status)) throw new RangeError("bad status");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("limit is 1 to 200");
  const rows = await q.query<Record<string, unknown>>(
    `${BREAK_SQL} AND b.status = $1 ORDER BY ${SEVERITY_ORDER}, b.updated_at DESC, b.id LIMIT ${limit}`,
    [status],
  );
  return rows.map(breakView);
}

export async function readBreak(q: Queryable, id: string): Promise<BreakView | null> {
  if (!isUuid(id)) return null;
  const rows = await q.query<Record<string, unknown>>(`${BREAK_SQL} AND b.id = CAST($1 AS uuid)`, [id.toLowerCase()]);
  return rows.length === 1 ? breakView(rows[0]) : null;
}

// What the check that last saw one difference spent on model calls, in whole cents, or null when
// the difference is not this carrier's. Its page reads it to say whether that check's budget ran out.
export async function readLastSeenRunCents(q: Queryable, breakId: string): Promise<number | null> {
  if (!isUuid(breakId)) return null;
  const rows = await q.query<Record<string, unknown>>(
    `SELECT r.model_cents
       FROM card_recon_breaks b
       JOIN card_recon_runs r ON r.tenant_id = b.tenant_id AND r.id = b.last_seen_run_id
      WHERE b.tenant_id = current_tenant_id() AND b.id = CAST($1 AS uuid)`,
    [breakId.toLowerCase()],
  );
  return rows.length === 1 ? num(rows[0].model_cents) : null;
}

export type RunView = {
  id: string;
  status: "running" | "done" | "failed";
  phase: string;
  failCategory: string | null;
  windowFrom: LocalDate;
  windowTo: LocalDate;
  counts: Record<string, unknown>;
  unchecked: unknown[];
  modelCents: number;
  startedAt: string;
  finishedAt: string | null;
};

const RUN_SQL = `
  SELECT CAST(id AS text) AS id, status, phase, fail_category, CAST(window_from AS text) AS window_from,
         CAST(window_to AS text) AS window_to, CAST(counts AS text) AS counts,
         CAST(unchecked AS text) AS unchecked, model_cents, ${ts("started_at")} AS started_at,
         ${ts("finished_at")} AS finished_at
    FROM card_recon_runs WHERE tenant_id = current_tenant_id()`;

function parse<T>(text: unknown, fallback: T): T {
  try {
    const v: unknown = JSON.parse(String(text));
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function runView(r: Record<string, unknown>): RunView {
  return {
    id: String(r.id),
    status: r.status === "done" ? "done" : r.status === "failed" ? "failed" : "running",
    phase: String(r.phase),
    failCategory: r.fail_category === null ? null : String(r.fail_category),
    windowFrom: String(r.window_from) as LocalDate,
    windowTo: String(r.window_to) as LocalDate,
    counts: parse<Record<string, unknown>>(r.counts, {}),
    unchecked: parse<unknown[]>(r.unchecked, []),
    modelCents: num(r.model_cents),
    startedAt: String(r.started_at),
    finishedAt: r.finished_at === null ? null : String(r.finished_at),
  };
}

export async function readRun(q: Queryable, id: string): Promise<RunView | null> {
  if (!isUuid(id)) return null;
  const rows = await q.query<Record<string, unknown>>(`${RUN_SQL} AND id = CAST($1 AS uuid)`, [id.toLowerCase()]);
  return rows.length === 1 ? runView(rows[0]) : null;
}

// The newest check, running or finished.
export async function readLatestRun(q: Queryable): Promise<RunView | null> {
  const rows = await q.query<Record<string, unknown>>(`${RUN_SQL} ORDER BY started_at DESC, id LIMIT 1`);
  return rows.length === 1 ? runView(rows[0]) : null;
}

// Open breaks by what they need: a person, or only a later confirmation.
export async function countOpenBreaks(q: Queryable): Promise<{ needsYou: number; notConfirmed: number }> {
  const [row] = await q.query<{ needs: number | string; pending: number | string }>(
    `SELECT count(*) FILTER (WHERE fix_kind <> 'check_pending') AS needs,
            count(*) FILTER (WHERE fix_kind = 'check_pending') AS pending
       FROM card_recon_breaks WHERE tenant_id = current_tenant_id() AND status = 'open'`,
  );
  return { needsYou: num(row?.needs ?? 0), notConfirmed: num(row?.pending ?? 0) };
}
