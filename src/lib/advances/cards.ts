import type { FuelCardDestination } from "../adapters/types";
import type { Queryable } from "../db";
import { isCanonicalUuid } from "../money/keys";
import { SIM_BEHAVIORS, type MoneyAction, type SimBehavior } from "../money/types";

// The driver's fuel cards on file (driver_cards, 0017 and 0027): where an advance lands. Only the
// provider's own token and the last four digits exist; the token is for the payment adapter and
// never reaches a page, a card or a log line. A driver may hold several active cards; the one
// marked default is paid unless a proposal names another of the driver's active cards.

export type CardOnFile = {
  id: string;
  provider: "fuel_card_sim";
  token: string;
  last4: string;
  simBehavior: SimBehavior;
};

type CardRow = {
  id: string;
  provider: string;
  provider_token: string;
  last4: string;
  sim_behavior: string;
};

const TOKEN = /^fcs_card_[0-9a-f]{24}$/;
const LAST4 = /^[0-9]{4}$/;

// A row read whole: the provider this app knows, a token and last four of the right shape, a
// behavior on the list. Anything else is no card at all, never a guess.
function cardOf(row: CardRow | undefined): CardOnFile | null {
  if (!row) return null;
  if (
    !isCanonicalUuid(row.id) ||
    row.provider !== "fuel_card_sim" ||
    !TOKEN.test(row.provider_token) ||
    !LAST4.test(row.last4) ||
    !(SIM_BEHAVIORS as readonly string[]).includes(row.sim_behavior)
  ) {
    return null;
  }
  return {
    id: row.id,
    provider: "fuel_card_sim",
    token: row.provider_token,
    last4: row.last4,
    simBehavior: row.sim_behavior as SimBehavior,
  };
}

// The driver's default active card (a unique index allows at most one), or null when the driver
// has none, for instance after the default was closed and no other was picked.
export async function readDefaultCard(q: Queryable, driverId: string): Promise<CardOnFile | null> {
  if (!isCanonicalUuid(driverId)) return null;
  const rows = await q.query<CardRow>(
    `SELECT id, provider, provider_token, last4, sim_behavior
       FROM driver_cards
      WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND status = 'active'
        AND is_default`,
    [driverId],
  );
  return rows.length === 1 ? cardOf(rows[0]) : null;
}

// The name FUEL-CARD gave it: still the card an advance is paid to when it names none.
export const readActiveCard = readDefaultCard;

// One named card, only when it is an active card of this driver (compared whole), or null.
export async function readActiveCardById(
  q: Queryable,
  driverId: string,
  cardId: string,
): Promise<CardOnFile | null> {
  if (!isCanonicalUuid(driverId) || !isCanonicalUuid(cardId)) return null;
  const rows = await q.query<CardRow>(
    `SELECT id, provider, provider_token, last4, sim_behavior
       FROM driver_cards
      WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
        AND id = CAST($2 AS uuid) AND status = 'active'`,
    [driverId, cardId],
  );
  return rows.length === 1 ? cardOf(rows[0]) : null;
}

// The card a payout goes to: the one the proposal named when it named one (never the default in
// its place), else the default.
export async function readPayoutCard(
  q: Queryable,
  driverId: string,
  cardId: string | null | undefined,
): Promise<CardOnFile | null> {
  return cardId === null || cardId === undefined
    ? readDefaultCard(q, driverId)
    : readActiveCardById(q, driverId, cardId);
}

// The money executor's destination hook for an advance payout: the card this advance's latest
// attempt recorded (advances.card_id), read for the send and again for every read-back. The card
// must belong to the payout's driver, and it is returned even after it was closed, so a load sent
// to it can still be read back. Null when the row is not an advance payout or no card is recorded.
export async function readCardDestination(
  q: Queryable,
  action: MoneyAction,
): Promise<FuelCardDestination | null> {
  if (
    action?.kind !== "advance_payout" ||
    action.subjectTable !== "advances" ||
    !isCanonicalUuid(action.subjectId) ||
    !isCanonicalUuid(action.counterpartyId)
  ) {
    return null;
  }
  const rows = await q.query<CardRow>(
    `SELECT c.id, c.provider, c.provider_token, c.last4, c.sim_behavior
       FROM advances a
       JOIN driver_cards c ON c.tenant_id = a.tenant_id AND c.id = a.card_id
      WHERE a.tenant_id = current_tenant_id() AND a.id = CAST($1 AS uuid)
        AND a.driver_id = CAST($2 AS uuid) AND c.driver_id = CAST($2 AS uuid)`,
    [action.subjectId, action.counterpartyId],
  );
  const card = rows.length === 1 ? cardOf(rows[0]) : null;
  if (!card) return null;
  return {
    rail: "fuel_card",
    provider: card.provider,
    token: card.token,
    last4: card.last4,
    simBehavior: card.simBehavior,
  };
}

// How a card reads in a sentence: "fuel card ···· 4417". Last four only, never more.
export function cardLabel(last4: string): string {
  return `fuel card ···· ${last4}`;
}
