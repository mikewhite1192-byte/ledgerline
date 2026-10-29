import type { Queryable } from "../db";
import type { SettlementLineRow } from "../data/rows";
import { readCardSource } from "../driver-notes/pack";
import { tenantLock } from "../invoices/number";
import { isPayCardArt, type PayCardArt } from "./art";
import type { CardRead } from "./schema";
import type { CardPill } from "./words";
import { cardSpec, sameSpec, type CardSourceInput, type CardSpec } from "./spec";

// Every database read and write behind pay cards. Each runs inside the caller's tenant
// transaction and names the tenant. Nothing here touches a settlement, a pay line or a payout:
// settlements are read only. No list read ever selects a card's image bytes; only readCardFile
// does, for one checked card.

export const PAY_CARD_PURPOSE = "pay_card_check";
export const MAX_ATTEMPTS = 3;
// A card left checking longer than this was cut off mid-call (the route runs at most 30 s).
export const CHECKING_LEASE_SECONDS = 60;

export type CardStatus = "checking" | "checked" | "mismatch" | "unavailable";
export type CardCategory = "number_mismatch" | "text_mismatch" | "off_schema" | "timeout" | "budget" | "unknown";

const STATUSES: readonly string[] = ["checking", "checked", "mismatch", "unavailable"];
const CATEGORIES: readonly string[] = ["number_mismatch", "text_mismatch", "off_schema", "timeout", "budget", "unknown"];

const asStatus = (v: unknown): CardStatus => (STATUSES.includes(String(v)) ? (String(v) as CardStatus) : "checking");
const asCategory = (v: unknown): CardCategory | null =>
  CATEGORIES.includes(String(v)) ? (String(v) as CardCategory) : null;

async function tenantName(q: Queryable): Promise<string | null> {
  const rows = await q.query<{ name: string }>("SELECT name FROM tenants WHERE id = current_tenant_id()");
  return rows.length === 1 ? String(rows[0].name) : null;
}

// One settlement's card as the server works it out: from the settlement's own rows, never from
// anything the browser sent. Null when the settlement is not this carrier's; spec null when it is
// not approved or paid.
export async function readSettlementSpec(
  q: Queryable,
  settlementId: string,
): Promise<{ spec: CardSpec | null; status: string } | null> {
  const source = await readCardSource(q, settlementId);
  if (!source) return null;
  const carrierName = await tenantName(q);
  if (carrierName === null) return null;
  return {
    status: source.settlement.status,
    spec: cardSpec({
      carrierName,
      settlement: source.settlement,
      period: source.period,
      driver: source.driver,
      lines: source.lines,
      previousNetCents: source.previousNetCents,
      previousLines: source.previousLines,
    }),
  };
}

// The membership row of the person asking, for created_by. Null when the login is not a member
// of this carrier.
export async function readMemberId(q: Queryable, sub: string): Promise<string | null> {
  const rows = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [sub],
  );
  return rows.length === 1 ? String(rows[0].id) : null;
}

// A card still checking past its lease is shown as it will be closed: could not check (unknown).
const SHOWN_STATUS = `CASE WHEN c.status = 'checking' AND c.created_at < now() - interval '${CHECKING_LEASE_SECONDS} seconds'
              THEN 'unavailable' ELSE c.status END AS status,
            CASE WHEN c.status = 'checking' AND c.created_at < now() - interval '${CHECKING_LEASE_SECONDS} seconds'
              THEN 'unknown' ELSE c.category END AS category`;

export type CardSummary = {
  id: string;
  attempt: number;
  status: CardStatus;
  category: CardCategory | null;
  spec: unknown;
};

// One settlement's cards, newest attempt first, without their images.
export async function readSettlementCards(q: Queryable, settlementId: string): Promise<CardSummary[]> {
  const rows = await q.query<{ id: string; attempt: number | string; status: string; category: string | null; spec: string }>(
    `SELECT CAST(c.id AS text) AS id, c.attempt, ${SHOWN_STATUS}, CAST(c.spec AS text) AS spec
       FROM pay_cards c
      WHERE c.tenant_id = current_tenant_id() AND c.settlement_id = CAST($1 AS uuid)
      ORDER BY c.attempt DESC`,
    [settlementId],
  );
  return rows.map(summary);
}

function summary(r: { id: string; attempt: number | string; status: string; category: string | null; spec: string }): CardSummary {
  let spec: unknown = null;
  try {
    spec = JSON.parse(String(r.spec));
  } catch {
    spec = null;
  }
  return { id: String(r.id), attempt: Number(r.attempt), status: asStatus(r.status), category: asCategory(r.category), spec };
}

// The newest checked card that still matches the settlement's current figures. A card made
// before the settlement changed (approved, then paid) is out of date and never shown.
export function currentChecked(cards: CardSummary[], spec: CardSpec): CardSummary | null {
  return cards.find((c) => c.status === "checked" && sameSpec(c.spec, spec)) ?? null;
}

// This run's spend in nanocents: what the ledger holds for its check calls, plus the worst case
// of each card of the run still checking (its call may not be settled yet). Unknown is not zero:
// a read that does not come back as numbers is the largest number, so the run stops.
export async function readBatchSpend(q: Queryable, traceId: string, worstNanocents: number): Promise<number> {
  const [row] = await q.query<{ spent: number | string; in_flight: number | string }>(
    `SELECT CAST(COALESCE((
              SELECT sum(COALESCE(m.cost_nanocents, m.reserved_nanocents))
                FROM model_calls m
               WHERE m.tenant_id = current_tenant_id() AND m.purpose = $2
                 AND m.trace_id = CAST($1 AS uuid)), 0) AS bigint) AS spent,
            (SELECT count(*) FROM pay_cards c
              WHERE c.tenant_id = current_tenant_id() AND c.trace_id = CAST($1 AS uuid)
                AND c.status = 'checking') AS in_flight`,
    [traceId, PAY_CARD_PURPOSE],
  );
  const spent = Number(row?.spent);
  const inFlight = Number(row?.in_flight);
  if (!Number.isSafeInteger(spent) || !Number.isSafeInteger(inFlight)) return Number.MAX_SAFE_INTEGER;
  return spent + inFlight * worstNanocents;
}

// Closes the settlement's cards left checking past their lease as unavailable (unknown): the
// request that made each was cut off, and its attempt stays used.
export async function expireStaleCards(q: Queryable, settlementId: string): Promise<number> {
  return q.execute(
    `UPDATE pay_cards SET status = 'unavailable', category = 'unknown', checked_at = now()
      WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid) AND status = 'checking'
        AND created_at < now() - make_interval(secs => $2)`,
    [settlementId, CHECKING_LEASE_SECONDS],
  );
}

// Cards this carrier made in the last 24 hours, every outcome counted. Unknown is not zero.
export async function countRecentCards(q: Queryable): Promise<number> {
  const [row] = await q.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM pay_cards
      WHERE tenant_id = current_tenant_id() AND created_at > now() - interval '24 hours'`,
  );
  const n = Number(row?.n);
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
}

// Takes the carrier's pay card lock for the rest of the transaction, so the day count and the
// next attempt number are read and written by one request at a time.
export async function lockCards(q: Queryable): Promise<void> {
  await tenantLock(q, "pay_card");
}

// Reserves the settlement's next attempt as a bare checking row, in the one statement that
// refuses a fourth: no row comes back once three exist (the table's own CHECK and unique key hold
// too). Returns the attempt number, or null when every attempt is used.
export async function reserveCard(
  q: Queryable,
  card: { id: string; settlementId: string; art: PayCardArt; spec: CardSpec; traceId: string; createdBy: string },
): Promise<number | null> {
  const rows = await q.query<{ attempt: number | string }>(
    `INSERT INTO pay_cards (id, tenant_id, settlement_id, attempt, status, art, spec, trace_id, created_by)
     SELECT CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), n.next, 'checking', $3,
            CAST($4 AS jsonb), CAST($5 AS uuid), CAST($6 AS uuid)
       FROM (SELECT COALESCE(max(attempt), 0) + 1 AS next FROM pay_cards
              WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($2 AS uuid)) n
      WHERE n.next <= $7
     RETURNING attempt`,
    [card.id, card.settlementId, card.art, JSON.stringify(card.spec), card.traceId, card.createdBy, MAX_ATTEMPTS],
  );
  return rows.length === 1 ? Number(rows[0].attempt) : null;
}

export type CardFinish =
  | { status: "checked"; read: CardRead; callId: string; bytesBase64: string; byteLength: number; contentHash: string }
  | { status: "mismatch"; category: "number_mismatch" | "text_mismatch"; read: CardRead; callId: string }
  | { status: "unavailable"; category: "off_schema" | "timeout" | "budget" | "unknown"; callId: string | null };

// Finishes a checking card, once. The bytes are written only on the step to checked. Returns
// whether this write finished it (false: it was already finished, or it is not this carrier's).
export async function finishCard(q: Queryable, cardId: string, finish: CardFinish): Promise<boolean> {
  if (finish.status === "checked") {
    const n = await q.execute(
      `UPDATE pay_cards
          SET status = 'checked', check_read = CAST($2 AS jsonb), check_call_id = CAST($3 AS uuid),
              mime = 'image/png', byte_length = $4, bytes = decode($5, 'base64'), content_hash = $6,
              checked_at = now()
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'checking'`,
      [cardId, JSON.stringify(finish.read), finish.callId, finish.byteLength, finish.bytesBase64, finish.contentHash],
    );
    return n === 1;
  }
  const n = await q.execute(
    `UPDATE pay_cards
        SET status = $2, category = $3, check_read = CAST($4 AS jsonb), check_call_id = CAST($5 AS uuid),
            checked_at = now()
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'checking'`,
    [
      cardId,
      finish.status,
      finish.category,
      finish.status === "mismatch" ? JSON.stringify(finish.read) : null,
      finish.callId,
    ],
  );
  return n === 1;
}

// One card's status, read back after a finish whose outcome is not known.
export async function readCardStatus(q: Queryable, cardId: string): Promise<{ status: CardStatus; category: CardCategory | null } | null> {
  const rows = await q.query<{ status: string; category: string | null }>(
    "SELECT status, category FROM pay_cards WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [cardId],
  );
  return rows.length === 1 ? { status: asStatus(rows[0].status), category: asCategory(rows[0].category) } : null;
}

// --- The cards page ---

export type CardRow = {
  settlementId: string;
  driverName: string;
  driverCode: string;
  spec: CardSpec;
  // The newest attempt, or null when none was made.
  latest: CardSummary | null;
  // The newest checked card that matches the current figures.
  checkedId: string | null;
  attemptsUsed: number;
  pill: CardPill;
  // Why the newest attempt failed, as a category; null unless it failed.
  reason: CardCategory | null;
};

// What the row's status pill says: a checked card that matches the figures wins; otherwise the
// newest attempt's outcome, and a checked card made before the figures changed is out of date.
export function pillOf(latest: CardSummary | null, checkedId: string | null): { pill: CardPill; reason: CardCategory | null } {
  if (checkedId) return { pill: "checked", reason: null };
  if (!latest) return { pill: "none", reason: null };
  switch (latest.status) {
    case "checking":
      return { pill: "checking", reason: null };
    case "checked":
      return { pill: "stale", reason: null };
    case "mismatch":
      return { pill: "mismatch", reason: latest.category };
    case "unavailable":
      return { pill: latest.category === "budget" ? "budget" : "unavailable", reason: latest.category };
  }
}

export type PeriodCards = {
  period: { id: string; periodStart: string; periodEnd: string };
  rows: CardRow[];
};

type SettlementRowRead = {
  settlement_id: string;
  status: string;
  gross_cents: number | string;
  deductions_cents: number | string;
  net_cents: number | string;
  carry_forward_cents: number | string;
  driver_id: string;
  first_name: string;
  last_name: string;
  code: string;
  preferred_language: string;
};

type LineRead = { settlement_id: string; kind: string; amount_cents: number | string; sources: string; meta: string };

function parseJson<T>(text: string, fallback: T): T {
  try {
    const v: unknown = JSON.parse(text);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

// One pay period's approved and paid settlements with each driver's card as the server works it
// out, read in a fixed number of statements (not one set per driver), ordered by driver code.
// The figures come from the same rows readSettlementSpec reads; pay-cards.db.test.ts proves the two
// give the same spec for every settlement.
export async function readPeriodCards(q: Queryable, periodId: string): Promise<PeriodCards | null> {
  const periods = await q.query<{ id: string; period_start: string; period_end: string }>(
    `SELECT CAST(id AS text) AS id, to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end, 'YYYY-MM-DD') AS period_end
       FROM settlement_periods WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [periodId],
  );
  if (periods.length !== 1) return null;
  const p = periods[0];
  const carrierName = await tenantName(q);
  if (carrierName === null) return null;

  const settlements = await q.query<SettlementRowRead>(
    `SELECT CAST(s.id AS text) AS settlement_id, s.status, s.gross_cents, s.deductions_cents, s.net_cents,
            s.carry_forward_cents, CAST(d.id AS text) AS driver_id, d.first_name, d.last_name, d.code,
            d.preferred_language
       FROM settlements s
       JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
      WHERE s.tenant_id = current_tenant_id() AND d.tenant_id = current_tenant_id()
        AND s.period_id = CAST($1 AS uuid) AND s.status IN ('approved', 'paid')
      ORDER BY d.code`,
    [periodId],
  );
  if (settlements.length === 0) return { period: { id: p.id, periodStart: p.period_start, periodEnd: p.period_end }, rows: [] };

  const lines = await q.query<LineRead>(
    `SELECT CAST(l.settlement_id AS text) AS settlement_id, l.kind, l.amount_cents,
            CAST(l.sources AS text) AS sources, CAST(l.meta AS text) AS meta
       FROM settlement_lines l
       JOIN settlements s ON s.tenant_id = l.tenant_id AND s.id = l.settlement_id
      WHERE l.tenant_id = current_tenant_id() AND s.tenant_id = current_tenant_id()
        AND s.period_id = CAST($1 AS uuid) AND s.status IN ('approved', 'paid')
      ORDER BY l.settlement_id, l.seq`,
    [periodId],
  );

  // Each driver's latest settled week before this one, as readCardSource picks it.
  const previous = await q.query<{ driver_id: string; id: string; net_cents: number | string }>(
    `SELECT DISTINCT ON (s.driver_id) CAST(s.driver_id AS text) AS driver_id, CAST(s.id AS text) AS id, s.net_cents
       FROM settlements s
       JOIN settlement_periods sp ON sp.tenant_id = s.tenant_id AND sp.id = s.period_id
      WHERE s.tenant_id = current_tenant_id() AND sp.tenant_id = current_tenant_id()
        AND s.status IN ('approved', 'paid')
        AND sp.period_start < CAST($2 AS date)
        AND s.driver_id IN (SELECT t.driver_id FROM settlements t
                             WHERE t.tenant_id = current_tenant_id() AND t.period_id = CAST($1 AS uuid))
      ORDER BY s.driver_id, sp.period_start DESC`,
    [periodId, p.period_start],
  );
  const previousIds = previous.map((r) => String(r.id));
  const previousLines =
    previousIds.length === 0
      ? []
      : await q.query<{ settlement_id: string; kind: string; amount_cents: number | string }>(
          `SELECT CAST(l.settlement_id AS text) AS settlement_id, l.kind, l.amount_cents
             FROM settlement_lines l
            WHERE l.tenant_id = current_tenant_id()
              AND l.settlement_id IN (SELECT CAST(x AS uuid) FROM jsonb_array_elements_text(CAST($1 AS jsonb)) x)`,
          [JSON.stringify(previousIds)],
        );

  const cards = await q.query<{
    settlement_id: string;
    id: string;
    attempt: number | string;
    status: string;
    category: string | null;
    spec: string;
  }>(
    `SELECT CAST(c.settlement_id AS text) AS settlement_id, CAST(c.id AS text) AS id, c.attempt,
            ${SHOWN_STATUS}, CAST(c.spec AS text) AS spec
       FROM pay_cards c
       JOIN settlements s ON s.tenant_id = c.tenant_id AND s.id = c.settlement_id
      WHERE c.tenant_id = current_tenant_id() AND s.tenant_id = current_tenant_id()
        AND s.period_id = CAST($1 AS uuid)
      ORDER BY c.settlement_id, c.attempt DESC`,
    [periodId],
  );

  const linesBy = group(lines, (l) => l.settlement_id);
  const prevBy = new Map(previous.map((r) => [String(r.driver_id), r]));
  const prevLinesBy = group(previousLines, (l) => l.settlement_id);
  const cardsBy = group(cards, (c) => c.settlement_id);

  const rows: CardRow[] = [];
  for (const s of settlements) {
    const prev = prevBy.get(String(s.driver_id)) ?? null;
    const input: CardSourceInput = {
      carrierName,
      settlement: {
        id: s.settlement_id,
        status: s.status as CardSourceInput["settlement"]["status"],
        gross_cents: Number(s.gross_cents),
        deductions_cents: Number(s.deductions_cents),
        net_cents: Number(s.net_cents),
        carry_forward_cents: Number(s.carry_forward_cents),
      },
      period: { period_start: p.period_start, period_end: p.period_end },
      driver: {
        id: s.driver_id,
        first_name: s.first_name,
        preferred_language: s.preferred_language === "es" ? "es" : "en",
      },
      lines: (linesBy.get(s.settlement_id) ?? []).map((l) => ({
        kind: l.kind,
        amount_cents: Number(l.amount_cents),
        sources: parseJson<SettlementLineRow["sources"]>(l.sources, []),
        meta: parseJson<SettlementLineRow["meta"]>(l.meta, {}),
      })),
      previousNetCents: prev ? Number(prev.net_cents) : null,
      previousLines: prev
        ? (prevLinesBy.get(String(prev.id)) ?? []).map((l) => ({ kind: l.kind, amount_cents: Number(l.amount_cents) }))
        : null,
    };
    const spec = cardSpec(input);
    if (!spec) continue;
    const mine = (cardsBy.get(s.settlement_id) ?? []).map(summary);
    const latest = mine[0] ?? null;
    const checkedId = currentChecked(mine, spec)?.id ?? null;
    rows.push({
      settlementId: s.settlement_id,
      driverName: `${s.first_name} ${s.last_name}`,
      driverCode: s.code,
      spec,
      latest,
      checkedId,
      attemptsUsed: mine.length === 0 ? 0 : Math.max(...mine.map((c) => c.attempt)),
      ...pillOf(latest, checkedId),
    });
  }
  return { period: { id: p.id, periodStart: p.period_start, periodEnd: p.period_end }, rows };
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = String(key(item));
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

// --- The driver's view and the image ---

// The checked card the driver's view shows above the note: the newest checked card that still
// matches the settlement's figures, or null (the view then shows nothing).
export async function readDriverCard(q: Queryable, settlementId: string): Promise<{ id: string; art: PayCardArt } | null> {
  const read = await readSettlementSpec(q, settlementId);
  if (!read?.spec) return null;
  const checked = currentChecked(await readSettlementCards(q, settlementId), read.spec);
  return checked && isPayCardArt(read.spec.art) ? { id: checked.id, art: read.spec.art } : null;
}

// One checked card's image, for the Save image link. Null for a card that is not checked, not this
// carrier's, or out of date (the settlement's figures changed after it was checked): an image is
// only ever kept after the check passed, and only served while it still matches the paystub.
export async function readCardFile(
  q: Queryable,
  cardId: string,
): Promise<{ bytes: Uint8Array; contentHash: string; periodStart: string; firstName: string } | null> {
  const rows = await q.query<{
    data: string;
    byte_length: number | string;
    content_hash: string;
    period_start: string;
    first_name: string | null;
    settlement_id: string;
    spec: string;
  }>(
    `SELECT encode(c.bytes, 'base64') AS data, c.byte_length, c.content_hash,
            to_char(p.period_start, 'YYYY-MM-DD') AS period_start, c.spec ->> 'firstName' AS first_name,
            CAST(c.settlement_id AS text) AS settlement_id, CAST(c.spec AS text) AS spec
       FROM pay_cards c
       JOIN settlements s ON s.tenant_id = c.tenant_id AND s.id = c.settlement_id
       JOIN settlement_periods p ON p.tenant_id = s.tenant_id AND p.id = s.period_id
      WHERE c.tenant_id = current_tenant_id() AND s.tenant_id = current_tenant_id()
        AND p.tenant_id = current_tenant_id()
        AND c.id = CAST($1 AS uuid) AND c.status = 'checked' AND c.bytes IS NOT NULL`,
    [cardId],
  );
  if (rows.length !== 1) return null;
  const current = await readSettlementSpec(q, String(rows[0].settlement_id));
  let stored: unknown = null;
  try {
    stored = JSON.parse(String(rows[0].spec));
  } catch {
    return null;
  }
  if (!current?.spec || !sameSpec(stored, current.spec)) return null;
  const bytes = Uint8Array.from(Buffer.from(String(rows[0].data).replace(/\s+/g, ""), "base64"));
  if (bytes.length !== Number(rows[0].byte_length) || bytes.length === 0) return null;
  return {
    bytes,
    contentHash: String(rows[0].content_hash),
    periodStart: String(rows[0].period_start),
    firstName: String(rows[0].first_name ?? ""),
  };
}
