import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DbError, type Queryable } from "../db";
import { readAdvanceInput } from "../data/read";
import { isCanonicalUuid } from "../money/keys";
import { readBySubject } from "../money/read";
import { SUBJECT_STATUSES, type MoneyAction } from "../money/types";
import { advanceEligibility, type AdvanceRefusal, type SourceRef } from "../rules-engine";
import { ForbiddenError } from "../tenant/context";
import { DESK_LOAD_NUMBER } from "./request";
import { readAdvanceView, type AdvanceView } from "./rows";

// What the advance pages read, inside the request's tenant transaction. Every statement names its
// tenant. Nothing here writes, calls out or shows an outside message's body: the record page shows
// the input's kind and time only, and an outside id only by its last four characters.

export type AdvanceStatusFilter = (typeof SUBJECT_STATUSES.advances)[number];

export function isAdvanceStatus(value: unknown): value is AdvanceStatusFilter {
  return typeof value === "string" && (SUBJECT_STATUSES.advances as readonly string[]).includes(value);
}

export type Shell = { name: string; timezone: string; email: string };

// The signed-in member's carrier, for the page shell.
export async function readShell(q: Queryable, session: Session): Promise<Shell> {
  const tenants = await q.query<{ name: string; timezone: string }>(
    "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
  );
  const members = await q.query<{ email: string }>(
    "SELECT email FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
  return { name: tenants[0].name, timezone: tenants[0].timezone, email: members[0].email };
}

export type AdvanceListRow = {
  id: string;
  driverId: string;
  driverCode: string;
  driverName: string;
  requestRef: string;
  requestedOn: string;
  amountCents: number;
  feeCents: number;
  status: string;
  source: string;
  fromFlow: boolean;
  payoutState: string | null;
  // The card line under Payout, labelled as the record page labels it (see listCardLineFor);
  // null shows no line.
  cardLine: ListCardLine | null;
  // The load it is for, by number; null when it names none.
  loadNumber: string | null;
  // Whether the driver is armed to receive money now.
  driverArmed: boolean;
};

const LIST_LIMIT = 200;
const LAST4 = /^[0-9]{4}$/;

// Four digits or nothing: a value of any other shape is never shown.
function last4Of(value: unknown): string | null {
  return typeof value === "string" && LAST4.test(value) ? value : null;
}

function whole(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new DbError("unknown");
  return n;
}

// notArmed: only advances whose driver is not armed to receive money now.
export async function readAdvanceList(
  q: Queryable,
  status: AdvanceStatusFilter | null,
  notArmed = false,
): Promise<AdvanceListRow[]> {
  const rows = await q.query<{
    id: string;
    driver_id: string;
    driver_code: string;
    first_name: string;
    last_name: string;
    request_ref: string;
    requested_on: string;
    amount_cents: number | string;
    fee_cents: number | string;
    status: string;
    source: string;
    from_flow: boolean;
    payout_state: string | null;
    recorded_id: string | null;
    recorded_last4: string | null;
    recorded_status: string | null;
    active_last4: string | null;
    active_status: string | null;
    load_number: string | null;
    money_armed: boolean;
  }>(
    `SELECT a.id, a.driver_id, d.code AS driver_code, d.first_name, d.last_name, a.request_ref,
            to_char(a.requested_on, 'YYYY-MM-DD') AS requested_on, a.amount_cents, a.fee_cents,
            a.status, a.source, (a.proposal_id IS NOT NULL) AS from_flow,
            (SELECT m.state FROM money_actions m
              WHERE m.tenant_id = current_tenant_id() AND m.subject_table = 'advances'
                AND m.subject_id = a.id AND m.kind = 'advance_payout'
              ORDER BY m.created_at DESC, m.attempt DESC LIMIT 1) AS payout_state,
            CAST(rc.id AS text) AS recorded_id, rc.last4 AS recorded_last4, rc.status AS recorded_status,
            ac.last4 AS active_last4, ac.status AS active_status, l.load_number, d.money_armed
       FROM advances a
       JOIN drivers d ON d.tenant_id = a.tenant_id AND d.id = a.driver_id
       -- The card the advance recorded, only when it is the advance's own driver's (as on the
       -- record page), and the driver's default card (at most one: driver_cards_one_default).
       LEFT JOIN driver_cards rc ON rc.tenant_id = current_tenant_id() AND rc.id = a.card_id
                                AND rc.driver_id = a.driver_id
       LEFT JOIN driver_cards ac ON ac.tenant_id = current_tenant_id() AND ac.driver_id = a.driver_id
                                AND ac.status = 'active' AND ac.is_default
       -- The load, only when it is the advance's own driver's (the foreign key names the tenant).
       LEFT JOIN loads l ON l.tenant_id = current_tenant_id() AND l.id = a.load_id
                        AND l.driver_id = a.driver_id
      WHERE a.tenant_id = current_tenant_id() AND d.tenant_id = current_tenant_id()
        AND (CAST($1 AS text) IS NULL OR a.status = CAST($1 AS text))
        AND (NOT CAST($2 AS boolean) OR NOT d.money_armed)
      ORDER BY a.requested_at DESC, a.id
      LIMIT ${LIST_LIMIT}`,
    [status, notArmed],
  );
  return rows.map((r) => ({
    id: r.id,
    driverId: r.driver_id,
    driverCode: r.driver_code,
    driverName: `${r.first_name} ${r.last_name}`,
    requestRef: r.request_ref,
    requestedOn: r.requested_on,
    amountCents: whole(r.amount_cents),
    feeCents: whole(r.fee_cents),
    status: r.status,
    source: r.source,
    fromFlow: r.from_flow === true,
    payoutState: r.payout_state,
    cardLine: listCardLineFor(
      r.status,
      r.recorded_id === null ? null : { last4: r.recorded_last4 ?? "", status: r.recorded_status ?? "" },
      r.active_last4 === null ? null : { last4: r.active_last4, status: r.active_status ?? "" },
    ),
    loadNumber: r.load_number,
    driverArmed: r.money_armed === true,
  }));
}

export type DriverOption = { id: string; code: string; name: string };

// One driver's advances that are open or paid, newest first, for the driver page.
export type DriverAdvance = { id: string; requestRef: string; requestedOn: string; amountCents: number; status: string };

export async function readDriverAdvances(q: Queryable, driverId: string): Promise<DriverAdvance[]> {
  if (!isCanonicalUuid(driverId)) return [];
  const rows = await q.query<{
    id: string;
    request_ref: string;
    requested_on: string;
    amount_cents: number | string;
    status: string;
  }>(
    `SELECT id, request_ref, to_char(requested_on, 'YYYY-MM-DD') AS requested_on, amount_cents, status
       FROM advances
      WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
        AND status IN ('requested', 'approved', 'paid')
      ORDER BY requested_at DESC, id
      LIMIT 20`,
    [driverId],
  );
  return rows.map((r) => ({
    id: r.id,
    requestRef: r.request_ref,
    requestedOn: r.requested_on,
    amountCents: whole(r.amount_cents),
    status: r.status,
  }));
}

// The request desk's driver list: this carrier's drivers by code.
export async function readDriverOptions(q: Queryable): Promise<DriverOption[]> {
  const rows = await q.query<{ id: string; code: string; first_name: string; last_name: string }>(
    `SELECT id, code, first_name, last_name FROM drivers
      WHERE tenant_id = current_tenant_id() ORDER BY code LIMIT 500`,
  );
  return rows.map((r) => ({ id: r.id, code: r.code, name: `${r.first_name} ${r.last_name}` }));
}

// The driver's code for the desk's request text, or null for an id that is not this carrier's.
export async function readDriverCode(q: Queryable, driverId: string): Promise<string | null> {
  if (!isCanonicalUuid(driverId)) return null;
  const rows = await q.query<{ code: string }>(
    "SELECT code FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [driverId],
  );
  return rows.length === 1 ? rows[0].code : null;
}

// The desk's "For load" choices: the driver's loads delivered in the 45 days up to the carrier's
// today, newest first. now is passed in, so the window never reads the wall clock here. A load
// whose number the desk's sentence refuses (DESK_LOAD_NUMBER) is left out, so the form never
// offers a load the request then turns away.
export const DESK_LOAD_DAYS = 45;
export type DeskLoad = { id: string; number: string; deliveredOn: string };

export async function readDeskLoads(q: Queryable, driverId: string, now: Date): Promise<DeskLoad[]> {
  if (!isCanonicalUuid(driverId)) return [];
  const rows = await q.query<{ id: string; load_number: string; delivered_on: string }>(
    `SELECT l.id, l.load_number, to_char(l.delivered_on, 'YYYY-MM-DD') AS delivered_on
       FROM loads l
       JOIN tenants t ON t.id = l.tenant_id
      WHERE l.tenant_id = current_tenant_id() AND l.driver_id = CAST($1 AS uuid)
        AND l.delivered_on IS NOT NULL
        AND l.delivered_on <= CAST(CAST($2 AS timestamptz) AT TIME ZONE t.timezone AS date)
        AND l.delivered_on > CAST(CAST($2 AS timestamptz) AT TIME ZONE t.timezone AS date) - CAST($3 AS int)
      ORDER BY l.delivered_on DESC, l.load_number
      LIMIT 50`,
    [driverId, now.toISOString(), DESK_LOAD_DAYS],
  );
  return rows
    .filter((r) => DESK_LOAD_NUMBER.test(r.load_number))
    .map((r) => ({ id: r.id, number: r.load_number, deliveredOn: r.delivered_on }));
}

// The desk's suggestion once a driver (and maybe a load) is picked: the engine at the most it
// allows now, floored to whole dollars, and the load's cap when one is named. No model. A driver
// that is not this carrier's answers not_found and a load that is not this driver's answers
// load_not_drivers, never a guess.
export type DeskSuggestion = {
  armed: boolean;
  maxCents: number;
  suggestedCents: number;
  feeCents: number;
  load: LoadHeadroom | null;
};

export async function readDeskSuggestion(
  q: Queryable,
  driverId: string,
  loadId: string | null,
  now: Date,
): Promise<DeskSuggestion | "not_found" | "load_not_drivers"> {
  if ((await readDriverCode(q, driverId)) === null) return "not_found";
  if (loadId !== null && !isCanonicalUuid(loadId)) return "load_not_drivers";
  const input = await readAdvanceInput(q, driverId, now.toISOString(), 1, loadId);
  if (loadId !== null && !input.load) return "load_not_drivers";
  const first = advanceEligibility(input);
  const e = first.maxCents > 0 ? advanceEligibility({ ...input, amountCents: first.maxCents }) : first;
  return {
    armed: input.driver.moneyArmed,
    maxCents: e.maxCents,
    suggestedCents: e.suggestedCents,
    feeCents: e.feeCents,
    load:
      e.loadCapCents !== null && e.loadHeadroomCents !== null
        ? { capCents: e.loadCapCents, openOnLoadCents: e.openOnLoadCents, headroomCents: e.loadHeadroomCents }
        : null,
  };
}

// The load's number for the desk's sentence, or null for a load that is not this driver's.
export async function readDriverLoadNumber(q: Queryable, driverId: string, loadId: string): Promise<string | null> {
  if (!isCanonicalUuid(driverId) || !isCanonicalUuid(loadId)) return null;
  const rows = await q.query<{ load_number: string }>(
    `SELECT load_number FROM loads
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)`,
    [loadId, driverId],
  );
  return rows.length === 1 ? rows[0].load_number : null;
}

export type LedgerEntry = {
  id: string;
  kind: MoneyAction["kind"];
  state: MoneyAction["state"];
  attempt: number;
  amountCents: number;
  failureCategory: string | null;
  // Which provider answered (fuel_card_sim, stripe_test, mock, qbo_sandbox); null until one did.
  outsideSystem: string | null;
  // The outside record's id, last four characters only.
  outsideTail: string | null;
  createdAt: string;
  settledAt: string | null;
};

export function outsideTail(id: string | null): string | null {
  if (typeof id !== "string" || id.length === 0) return null;
  return id.slice(-4);
}

function entryOf(a: MoneyAction): LedgerEntry {
  return {
    id: a.id,
    kind: a.kind,
    state: a.state,
    attempt: a.attempt,
    amountCents: a.amountCents,
    failureCategory: a.failureCategory,
    outsideSystem: a.outsideSystem,
    outsideTail: outsideTail(a.outsideId),
    createdAt: a.createdAt,
    settledAt: a.settledAt,
  };
}

export type EligibilityNow = {
  eligible: boolean;
  maxCents: number;
  feeCents: number;
  earnedUnpaidCents: number;
  openCents: number;
  limitCents: number;
  // The carrier's rule numbers the refusal sentences name.
  minCents: number;
  shareBps: number;
  reasons: AdvanceRefusal[];
  sources: SourceRef[];
};

export type ProposalSummary = {
  id: string;
  status: string;
  title: string;
  decisionNote: string | null;
  operatorVerdict: string;
  flagged: boolean;
  createdAt: string;
  decidedAt: string | null;
};

export type InputSummary = { id: string; kind: string; receivedAt: string };

// takeBack: the Take back button (the switch on and the advance still takeable); the route asks
// the switch, the role and the advance's state again.
export type RecordActions = { retry: boolean; check: boolean; post: boolean; takeBack: boolean };

// The load an advance is for, and the room left on it as of now under the carrier's per-load cap
// (null when the carrier has none or it could not be checked).
export type RecordLoad = { id: string; number: string };
export type LoadHeadroom = { capCents: number; openOnLoadCents: number; headroomCents: number };
export type Sibling = { id: string; requestRef: string; amountCents: number; status: string };
export type Takeback = { cents: number; at: string; reason: string };

// The fuel card an advance pays: last four and whether it is still active.
export type CardSummary = { last4: string; status: "active" | "closed" };

// recorded: true only for the card the advance's latest payout attempt recorded. The driver's
// default card, shown in its place, is only the card on file, never where it was paid.
export type RecordCard = CardSummary & { recorded: boolean };

export type AdvanceRecord = {
  advance: AdvanceView;
  driver: { id: string; code: string; name: string };
  // The card this advance's latest payout attempt recorded (for an unpaid advance, only while it
  // is still active), else the driver's default card, else null (no fuel card on file, or a
  // rejected or cancelled advance).
  card: RecordCard | null;
  proposal: ProposalSummary | null;
  ledger: LedgerEntry[];
  input: InputSummary | null;
  // null: it could not be checked (never shown as zero).
  eligibility: EligibilityNow | null;
  actions: RecordActions;
  load: RecordLoad | null;
  headroom: LoadHeadroom | null;
  // The driver's other advances on the same load, newest first.
  siblingsOnLoad: Sibling[];
  takeback: Takeback | null;
};

const ISO = (col: string, as: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${as}`;

// The buttons a flow advance offers in its state. Seeded history offers none; the switches are
// asked again by every route behind these buttons.
export function actionsFor(advance: AdvanceView, ledger: readonly LedgerEntry[]): RecordActions {
  const takeBack = takeBackOffered(advance, ledger);
  if (advance.proposalId === null || flags.advancesEnabled !== true) {
    return { retry: false, check: false, post: false, takeBack };
  }
  const payouts = ledger.filter((e) => e.kind === "advance_payout");
  const posts = ledger.filter((e) => e.kind === "advance_expense");
  const lastPayout = payouts.at(-1) ?? null;
  const lastPost = posts.at(-1) ?? null;
  const retryable = (e: LedgerEntry | null) =>
    e === null ||
    (e.state === "failed" &&
      e.failureCategory !== "amount_mismatch" &&
      e.attempt < flags.advancesLimits.maxPayoutAttempts);
  return {
    retry:
      (advance.status === "approved" && retryable(lastPayout)) ||
      (advance.status === "requested" && lastPayout === null),
    check: ledger.some((e) => e.state === "unknown" || e.state === "sent"),
    post: advance.status === "paid" && flags.accountingEnabled === true && retryable(lastPost),
    takeBack,
  };
}

// Take back is offered on a paid advance not yet taken back, and on an unpaid one whose payouts
// all definitely failed (or that has none), with both switches on. Seeded history may be taken
// back too: it only records, nothing is sent.
export function takeBackOffered(advance: AdvanceView, ledger: readonly LedgerEntry[]): boolean {
  if (flags.advancesEnabled !== true || flags.advanceTakeback.enabled !== true) return false;
  if (advance.takenBackAt !== null) return false;
  if (advance.status === "paid") return true;
  if (advance.status !== "requested" && advance.status !== "approved") return false;
  return ledger.filter((e) => e.kind === "advance_payout").every((e) => e.state === "failed");
}

function cardSummaryOf(row: { last4: string; status: string } | undefined): CardSummary | null {
  const last4 = last4Of(row?.last4);
  if (!row || !last4 || (row.status !== "active" && row.status !== "closed")) return null;
  return { last4, status: row.status };
}

// The advance statuses a card line is about: one that can still be paid (requested, approved)
// or one that was (paid). A rejected or cancelled advance is never paid, and any other status is
// not known, so neither names a card.
const CARD_STATUSES: readonly string[] = ["requested", "approved", "paid"];

function namesCard(status: string): boolean {
  return CARD_STATUSES.includes(status);
}

// The card the record page names, from the card the advance recorded and the driver's default
// card. A paid advance names the card it recorded, closed or not. An unpaid advance names its
// recorded card only while that card is still active, since a retry pays that card again;
// otherwise the driver's default card is shown as not recorded, or nothing when there is none. A
// rejected or cancelled advance names none.
export function recordCardFor(
  status: string,
  recorded: CardSummary | null,
  active: CardSummary | null,
): RecordCard | null {
  if (!namesCard(status)) return null;
  if (recorded !== null && (status === "paid" || recorded.status === "active")) return { ...recorded, recorded: true };
  return active === null ? null : { ...active, recorded: false };
}

// The recorded card must be the advance's own driver's. A recorded card of any other shape is
// never shown and never replaced by the default card.
async function readRecordCard(
  q: Queryable,
  advanceId: string,
  driverId: string,
  status: string,
): Promise<RecordCard | null> {
  const recorded = await q.query<{ last4: string; status: string }>(
    `SELECT c.last4, c.status
       FROM advances a
       JOIN driver_cards c ON c.tenant_id = a.tenant_id AND c.id = a.card_id AND c.driver_id = a.driver_id
      WHERE a.tenant_id = current_tenant_id() AND a.id = CAST($1 AS uuid)`,
    [advanceId],
  );
  const recordedCard = recorded.length === 1 ? cardSummaryOf(recorded[0]) : null;
  if (recorded.length === 1 && recordedCard === null) return null;
  const active = await q.query<{ last4: string; status: string }>(
    `SELECT last4, status FROM driver_cards
      WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND status = 'active'
        AND is_default`,
    [driverId],
  );
  return recordCardFor(status, recordedCard, active.length === 1 ? cardSummaryOf(active[0]) : null);
}

export type CardLine = { label: "Paid to" | "Pays to" | "Card on file"; card: CardSummary | null };

// The record page's card line. "Paid to" and "Pays to" name only the card the advance recorded;
// the driver's default card, shown in its place, reads "Card on file". A paid advance with no card
// at all shows no line (null), since where it was paid is not known, and a rejected or cancelled
// advance shows none, since it is never paid.
export function cardLineFor(status: string, card: RecordCard | null): CardLine | null {
  if (!namesCard(status)) return null;
  const paid = status === "paid";
  if (card === null) return paid ? null : { label: "Pays to", card: null };
  const summary: CardSummary = { last4: card.last4, status: card.status };
  if (card.recorded !== true) return { label: "Card on file", card: summary };
  return { label: paid ? "Paid to" : "Pays to", card: summary };
}

// The advance list's card line: a card, labelled as the record page labels it. A paid advance
// names only the card it recorded ("Paid to", closed or not), and nothing without one, since the
// driver's card now is not where it was paid. An unpaid advance names its recorded card while it
// is still active ("Pays to"), else the driver's default card ("Card on file"). A recorded card of
// any other shape names nothing, and a rejected or cancelled advance names none. No card named,
// no line.
export type ListCardLine = { label: CardLine["label"]; card: CardSummary };

export function listCardLineFor(
  status: string,
  recorded: { last4: string; status: string } | null,
  active: { last4: string; status: string } | null,
): ListCardLine | null {
  const recordedCard = recorded === null ? null : cardSummaryOf(recorded);
  if (recorded !== null && recordedCard === null) return null;
  const activeCard = status === "paid" || active === null ? null : cardSummaryOf(active);
  const line = cardLineFor(status, recordCardFor(status, recordedCard, activeCard));
  return line !== null && line.card !== null ? { label: line.label, card: line.card } : null;
}

// One advance with everything its page shows; null for a missing or another carrier's id (the
// page says not found, never forbidden, so an id's existence elsewhere is not revealed).
export async function readAdvanceRecord(
  q: Queryable,
  id: string,
  now: Date,
): Promise<AdvanceRecord | null> {
  const advance = await readAdvanceView(q, id);
  if (!advance) return null;
  const drivers = await q.query<{ id: string; code: string; first_name: string; last_name: string }>(
    `SELECT id, code, first_name, last_name FROM drivers
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [advance.driverId],
  );
  if (drivers.length !== 1) throw new DbError("unknown");
  const d = drivers[0];

  let proposal: ProposalSummary | null = null;
  if (advance.proposalId) {
    const rows = await q.query<{
      id: string;
      status: string;
      title: string;
      decision_note: string | null;
      operator_verdict: string;
      flagged: boolean;
      created_at: string;
      decided_at: string | null;
    }>(
      `SELECT id, status, title, decision_note, operator_verdict,
              (flagged_input_id IS NOT NULL) AS flagged,
              ${ISO("created_at", "created_at")}, ${ISO("decided_at", "decided_at")}
         FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [advance.proposalId],
    );
    if (rows[0]) {
      const r = rows[0];
      proposal = {
        id: r.id,
        status: r.status,
        title: r.title,
        decisionNote: r.decision_note,
        operatorVerdict: r.operator_verdict,
        flagged: r.flagged === true,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
      };
    }
  }

  let input: InputSummary | null = null;
  if (advance.sourceInputId) {
    const rows = await q.query<{ id: string; kind: string; received_at: string }>(
      `SELECT id, kind, ${ISO("received_at", "received_at")}
         FROM untrusted_inputs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [advance.sourceInputId],
    );
    if (rows[0]) input = { id: rows[0].id, kind: rows[0].kind, receivedAt: rows[0].received_at };
  }

  const ledger = (await readBySubject(q, "advances", advance.id)).map(entryOf);
  const card = await readRecordCard(q, advance.id, advance.driverId, advance.status);

  let load: RecordLoad | null = null;
  let siblingsOnLoad: Sibling[] = [];
  if (advance.loadId) {
    const loads = await q.query<{ id: string; load_number: string }>(
      `SELECT id, load_number FROM loads
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)`,
      [advance.loadId, advance.driverId],
    );
    if (loads.length === 1) {
      load = { id: loads[0].id, number: loads[0].load_number };
      const rows = await q.query<{
        id: string;
        request_ref: string;
        amount_cents: number | string;
        status: string;
      }>(
        `SELECT id, request_ref, amount_cents, status FROM advances
          WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)
            AND driver_id = CAST($2 AS uuid) AND id <> CAST($3 AS uuid)
          ORDER BY requested_at DESC, id LIMIT 20`,
        [load.id, advance.driverId, advance.id],
      );
      siblingsOnLoad = rows.map((r) => ({
        id: r.id,
        requestRef: r.request_ref,
        amountCents: whole(r.amount_cents),
        status: r.status,
      }));
    }
  }
  const takeback: Takeback | null =
    advance.takenBackAt !== null && advance.takebackReason !== null
      ? { cents: advance.takenBackCents, at: advance.takenBackAt, reason: advance.takebackReason }
      : null;

  // Last: the engine as of now, no model. A failure shows as "could not be checked".
  let eligibility: EligibilityNow | null = null;
  let headroom: LoadHeadroom | null = null;
  try {
    const input = await readAdvanceInput(q, advance.driverId, now.toISOString(), advance.amountCents, load?.id);
    const e = advanceEligibility(input);
    if (e.loadCapCents !== null && e.loadHeadroomCents !== null) {
      headroom = { capCents: e.loadCapCents, openOnLoadCents: e.openOnLoadCents, headroomCents: e.loadHeadroomCents };
    }
    eligibility = {
      eligible: e.eligible,
      maxCents: e.maxCents,
      feeCents: e.feeCents,
      earnedUnpaidCents: e.earnedUnpaidCents,
      openCents: e.openCents,
      limitCents: e.limitCents,
      minCents: input.config.advanceMinCents,
      shareBps: input.config.advanceMaxBpsOfEarned,
      reasons: [...e.reasons],
      sources: e.sources,
    };
  } catch {
    eligibility = null;
  }

  return {
    advance,
    driver: { id: d.id, code: d.code, name: `${d.first_name} ${d.last_name}` },
    card,
    proposal,
    ledger,
    input,
    eligibility,
    actions: actionsFor(advance, ledger),
    load,
    headroom,
    siblingsOnLoad,
    takeback,
  };
}
