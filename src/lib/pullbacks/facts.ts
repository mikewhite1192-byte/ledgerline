import { readDefaultCard, readPayoutCard, type CardOnFile } from "../advances/cards";
import type { FuelCardDestination } from "../adapters/types";
import { ledgerRecordSql } from "../card-loads/facts";
import type { Queryable } from "../db";
import { isCanonicalUuid } from "../money/keys";
import { readTenantZone } from "../money/read";
import { SIM_BEHAVIORS, type SimBehavior } from "../money/types";
import { pullbackPlan, type PullbackBalance } from "../rules-engine/pullback";
import { isLocalDate, localDateOf, type LocalDate } from "../time/local-date";
import { isPullbackReason, type PullbackReason } from "./words";

// The facts a card pull-back stands on (S6 design 4.2), shared by the propose tool, the take-back,
// the precheck and the executor. Reads only, inside a tenant transaction the caller holds. The
// card's token stays inside this file and the adapter's request: it never reaches a card, a page
// or a log line.
//
// The balance is the engine's number from our own records (owner decision 1), labeled with the
// day it is as of:
//   loads       confirmed advance payouts whose latest attempt went to this card (advances.card_id)
//   hand loads  statement loads on the card's token with no payment record behind them
//               (ledgerRecordSql, which fails closed: a payout in flight to the card counts as a
//               record, so the balance is never read high)
//   fuel        statement fuel on the card's token
//   pulled      this card's pulls that are not a definite no (issuing, pulled or unknown), the
//               proposal's own row left out so a resume reads the same balance it was made on
//   as of       the newest statement row's day for the token, or the carrier's today when none

export { isPullbackReason, PULLBACK_REASONS, type PullbackReason } from "./words";

// The plan's refusals in the card's words, plus the facts' own: no such driver or advance, an
// advance not paid or already taken back, and no active card to pull from.
export type PullFactRefusal =
  | "bad_request"
  | "not_found"
  | "not_takeable"
  | "card_closed"
  | "over_bound"
  | "nothing_to_pull";

export type PullAsk = {
  driverId: string;
  advanceId: string | null;
  reason: PullbackReason;
  requestedCents: number;
};

// What a pull-back card carries, every number the engine's. The token is not here.
export type PullPlanned = {
  driverId: string;
  cardId: string;
  cardLast4: string;
  advanceId: string | null;
  reason: PullbackReason;
  requestedCents: number;
  balanceCents: number;
  pullCents: number;
  shortfallCents: number;
  balanceAsOf: LocalDate;
};

export type PullFacts = { ok: true; plan: PullPlanned } | { ok: false; refusal: PullFactRefusal };

type AdvanceRow = {
  driver_id: string;
  status: string;
  amount_cents: string;
  fee_cents: string;
  recovered_cents: string;
  taken_back_at: string | null;
  card_id: string | null;
};

export type PullAdvance = {
  driverId: string;
  status: string;
  stillOwedCents: number;
  takenBack: boolean;
  cardId: string | null;
};

const whole = (v: unknown): number | null => {
  const n = Number(v);
  return typeof v === "string" && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

// The advance a pull takes back, read whole; null when there is none or a column does not read.
// lock takes the advance FOR UPDATE (the executor's prepare).
export async function readPullAdvance(q: Queryable, advanceId: string, lock = false): Promise<PullAdvance | null> {
  if (!isCanonicalUuid(advanceId)) return null;
  const rows = await q.query<AdvanceRow>(
    `SELECT CAST(driver_id AS text) AS driver_id, status, CAST(amount_cents AS text) AS amount_cents,
            CAST(fee_cents AS text) AS fee_cents, CAST(recovered_cents AS text) AS recovered_cents,
            CAST(taken_back_at AS text) AS taken_back_at, CAST(card_id AS text) AS card_id
       FROM advances WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
       ${lock ? "FOR UPDATE" : ""}`,
    [advanceId],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  const amount = whole(r.amount_cents);
  const fee = whole(r.fee_cents);
  const recovered = whole(r.recovered_cents);
  if (amount === null || fee === null || recovered === null) return null;
  return {
    driverId: r.driver_id.toLowerCase(),
    status: r.status,
    stillOwedCents: Math.max(0, amount + fee - recovered),
    takenBack: r.taken_back_at !== null,
    cardId: r.card_id === null ? null : r.card_id.toLowerCase(),
  };
}

async function driverExists(q: Queryable, driverId: string, lock: boolean): Promise<boolean> {
  const rows = await q.query(
    `SELECT 1 AS one FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
     ${lock ? "FOR NO KEY UPDATE" : ""}`,
    [driverId],
  );
  return rows.length === 1;
}

type BalanceRow = {
  loads: string;
  hand_loads: string;
  fuel: string;
  pulled: string;
  as_of: string | null;
};

const BALANCE_SQL = `SELECT
    (SELECT CAST(COALESCE(sum(m.amount_cents), 0) AS text) FROM money_actions m
       JOIN advances a ON a.tenant_id = m.tenant_id AND a.id = m.subject_id
      WHERE m.tenant_id = current_tenant_id() AND m.kind = 'advance_payout' AND m.subject_table = 'advances'
        AND m.state = 'confirmed' AND m.outside_system = 'fuel_card_sim' AND a.card_id = CAST($1 AS uuid)) AS loads,
    (SELECT CAST(COALESCE(sum(t.amount_cents), 0) AS text) FROM card_transactions t
      WHERE t.tenant_id = current_tenant_id() AND t.kind = 'load' AND t.provider = $2 AND t.card_token = $3
        AND NOT ${ledgerRecordSql("t.provider_ref", "t.provider", "t.card_token")}) AS hand_loads,
    (SELECT CAST(COALESCE(sum(t.amount_cents), 0) AS text) FROM card_transactions t
      WHERE t.tenant_id = current_tenant_id() AND t.kind = 'fuel' AND t.provider = $2 AND t.card_token = $3) AS fuel,
    (SELECT CAST(COALESCE(sum(p.pull_cents), 0) AS text) FROM card_pullbacks p
      WHERE p.tenant_id = current_tenant_id() AND p.card_id = CAST($1 AS uuid)
        AND p.status IN ('issuing', 'pulled', 'unknown')
        AND (CAST($4 AS uuid) IS NULL OR p.proposal_id <> CAST($4 AS uuid))) AS pulled,
    (SELECT CAST(max(t.posted_on) AS text) FROM card_transactions t
      WHERE t.tenant_id = current_tenant_id() AND t.provider = $2 AND t.card_token = $3) AS as_of`;

// The card's balance parts and the day they are as of. Throws when a sum does not read as whole
// cents: unknown is never zero.
export async function readCardBalance(
  q: Queryable,
  card: Pick<CardOnFile, "id" | "provider" | "token">,
  exceptProposalId: string | null,
  now: Date,
): Promise<{ balance: PullbackBalance; asOf: LocalDate }> {
  const rows = await q.query<BalanceRow>(BALANCE_SQL, [card.id, card.provider, card.token, exceptProposalId]);
  const r = rows[0];
  const parts = r ? [whole(r.loads), whole(r.hand_loads), whole(r.fuel), whole(r.pulled)] : [];
  if (parts.length !== 4 || parts.some((p) => p === null)) throw new RangeError("the card's balance did not read");
  const [loadsCents, handLoadsCents, fuelCents, pulledCents] = parts as number[];
  const asOf = r.as_of !== null && isLocalDate(r.as_of) ? r.as_of : localDateOf(now.toISOString(), await readTenantZone(q));
  return { balance: { loadsCents, handLoadsCents, fuelCents, pulledCents }, asOf };
}

// The card a pull comes off. A take-back: the card the advance's latest payout went to while it is
// still active (never another in its place), else the default for history with none recorded. A
// breakdown: the driver's default active card.
async function pullCard(q: Queryable, driverId: string, advance: PullAdvance | null): Promise<CardOnFile | null> {
  if (advance === null) return readDefaultCard(q, driverId);
  return readPayoutCard(q, driverId, advance.cardId);
}

// The plan from live facts. lock: the executor's prepare, which locks the driver and the advance
// before it writes the pull row. exceptProposalId leaves that proposal's own pull out of the
// balance.
export async function planPull(
  q: Queryable,
  ask: PullAsk,
  maxCents: number,
  now: Date,
  opts: { lock?: boolean; exceptProposalId?: string | null } = {},
): Promise<PullFacts> {
  const lock = opts.lock === true;
  if (
    !isCanonicalUuid(ask.driverId) ||
    (ask.advanceId !== null && !isCanonicalUuid(ask.advanceId)) ||
    !isPullbackReason(ask.reason) ||
    !Number.isSafeInteger(ask.requestedCents) ||
    ask.requestedCents <= 0
  ) {
    return { ok: false, refusal: "bad_request" };
  }
  const driverId = ask.driverId.toLowerCase();
  if (!(await driverExists(q, driverId, lock))) return { ok: false, refusal: "not_found" };
  let advance: PullAdvance | null = null;
  if (ask.advanceId !== null) {
    advance = await readPullAdvance(q, ask.advanceId, lock);
    if (!advance || advance.driverId !== driverId) return { ok: false, refusal: "not_found" };
    if (advance.status !== "paid" || advance.takenBack) return { ok: false, refusal: "not_takeable" };
  }
  const card = await pullCard(q, driverId, advance);
  if (!card) return { ok: false, refusal: "card_closed" };
  const { balance, asOf } = await readCardBalance(q, card, opts.exceptProposalId ?? null, now);
  const plan = pullbackPlan({
    requestedCents: ask.requestedCents,
    maxCents,
    balance,
    advance: advance === null ? null : { stillOwedCents: advance.stillOwedCents },
  });
  if (!plan.ok) return { ok: false, refusal: plan.refusal };
  return {
    ok: true,
    plan: {
      driverId,
      cardId: card.id.toLowerCase(),
      cardLast4: card.last4,
      advanceId: ask.advanceId === null ? null : ask.advanceId.toLowerCase(),
      reason: ask.reason,
      requestedCents: ask.requestedCents,
      balanceCents: plan.balanceCents,
      pullCents: plan.pullCents,
      shortfallCents: plan.shortfallCents,
      balanceAsOf: asOf,
    },
  };
}

// Two plans that say the same pull: every id and number, compared whole. The as-of day is a label
// and is left out, so a card is not stale only because a day passed with nothing posted.
export function samePull(a: PullPlanned, b: PullPlanned): boolean {
  return (
    a.driverId === b.driverId &&
    a.cardId === b.cardId &&
    a.cardLast4 === b.cardLast4 &&
    a.advanceId === b.advanceId &&
    a.reason === b.reason &&
    a.requestedCents === b.requestedCents &&
    a.balanceCents === b.balanceCents &&
    a.pullCents === b.pullCents &&
    a.shortfallCents === b.shortfallCents
  );
}

type DestinationRow = { provider: string; provider_token: string; last4: string; sim_behavior: string; status: string };

const TOKEN = /^fcs_card_[0-9a-f]{24}$/;
const LAST4 = /^[0-9]{4}$/;

// Where a pull is sent: the card the row names, read fresh, only while it is still this driver's
// card. Returned even after the card was closed, so a pull sent to it can still be read back (the
// provider answers a closed card itself). activeOnly (a first send, with no ledger row yet): null
// unless the card is still active. Null when the row does not read whole.
export async function readPullDestination(
  q: Queryable,
  pull: { cardId: string; driverId: string },
  opts: { activeOnly?: boolean } = {},
): Promise<FuelCardDestination | null> {
  if (!isCanonicalUuid(pull.cardId) || !isCanonicalUuid(pull.driverId)) return null;
  const rows = await q.query<DestinationRow>(
    `SELECT provider, provider_token, last4, sim_behavior, status FROM driver_cards
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)`,
    [pull.cardId, pull.driverId],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  if (opts.activeOnly === true && r.status !== "active") return null;
  if (
    r.provider !== "fuel_card_sim" ||
    !TOKEN.test(r.provider_token) ||
    !LAST4.test(r.last4) ||
    !(SIM_BEHAVIORS as readonly string[]).includes(r.sim_behavior)
  ) {
    return null;
  }
  return {
    rail: "fuel_card",
    provider: "fuel_card_sim",
    token: r.provider_token,
    last4: r.last4,
    simBehavior: r.sim_behavior as SimBehavior,
  };
}
