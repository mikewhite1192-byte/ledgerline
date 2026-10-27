import { randomUUID } from "node:crypto";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { readRowsWhereId } from "../data/read";
import { isCanonicalUuid } from "../money/keys";
import { readMember, type Member } from "./member";

// One driver's identity map: whether they are armed to receive money, the ids other systems know
// them by, and the fuel cards on file. Reads show last four digits and portal names only, never a
// card's token. The writes here are our own rows: nothing reaches the card provider or another
// system. Adding an outside id is open to any member; adding, closing or choosing the default
// card is an admin's (decision D-034), each in one tenant transaction with the driver locked.

export type IdentityCard = {
  id: string;
  last4: string;
  status: "active" | "closed";
  isDefault: boolean;
  holderKind: "named" | "generic";
  // What the provider's portal shows on a generic card; never shown for a named card.
  portalName: string | null;
  // Every card on file is the simulated provider's, so every one is in test mode.
  testMode: true;
};

export type DriverIdentity = {
  driverId: string;
  code: string;
  name: string;
  // The last day they drive for this carrier; null while they still do.
  activeTo: string | null;
  armed: { on: boolean; since: string | null };
  tmsIds: string[];
  cards: IdentityCard[];
};

const LAST4 = /^[0-9]{4}$/;
const EXTERNAL_ID = /^[A-Za-z0-9._-]{1,40}$/;
const PORTAL_NAME = /^[A-Z0-9 -]{2,40}$/;

// The portal name a page may show: a generic card's placeholder of the allowed shape, else none.
export function portalNameOf(holderKind: string, value: unknown): string | null {
  if (holderKind !== "generic" || typeof value !== "string") return null;
  return PORTAL_NAME.test(value) ? value : null;
}

// A portal name a person typed, as stored: trimmed, upper case, inner spaces collapsed. Null when
// it is not of the allowed shape, so it is refused, never cut to fit.
export function normalizePortalName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/\s+/g, " ").toUpperCase();
  return PORTAL_NAME.test(v) ? v : null;
}

// A new card's provider reference: drawn at random, never from anything a person typed.
export function newCardToken(uuid: () => string = randomUUID): string {
  const token = `fcs_card_${uuid().replace(/-/g, "").slice(0, 24)}`;
  if (!/^fcs_card_[0-9a-f]{24}$/.test(token)) throw new RangeError("a card token is not well formed");
  return token;
}

// Read through the shared row readers, so the agent's tool and the driver page see the same
// rows. A card's token is read with its row but never leaves this function.
export async function readDriverIdentity(q: Queryable, driverId: string): Promise<DriverIdentity | null> {
  if (!isCanonicalUuid(driverId)) return null;
  const drivers = await readRowsWhereId(q, "drivers", "id", driverId);
  if (drivers.length !== 1) return null;
  const d = drivers[0];
  const ids = await readRowsWhereId(q, "driver_identities", "driver_id", driverId);
  const cards = await readRowsWhereId(q, "driver_cards", "driver_id", driverId);
  const armed = d.money_armed === true;
  return {
    driverId: d.id,
    code: d.code,
    name: `${d.first_name} ${d.last_name}`,
    activeTo: d.active_to,
    armed: { on: armed, since: armed ? d.money_armed_at : null },
    tmsIds: ids
      .filter((r) => r.system === "tms" && EXTERNAL_ID.test(r.external_id))
      .map((r) => r.external_id)
      .sort(),
    cards: cards
      .flatMap((c): IdentityCard[] => {
        // A row of any other shape is never shown.
        if (!LAST4.test(c.last4) || (c.status !== "active" && c.status !== "closed")) return [];
        if (c.holder_kind !== "named" && c.holder_kind !== "generic") return [];
        return [
          {
            id: c.id,
            last4: c.last4,
            status: c.status,
            isDefault: c.is_default === true,
            holderKind: c.holder_kind,
            portalName: portalNameOf(c.holder_kind, c.portal_name),
            testMode: true,
          },
        ];
      })
      // Active before closed, the default first, then by last four digits and id.
      .sort((a, b) => cardRank(a) - cardRank(b) || cmp(a.last4, b.last4) || cmp(a.id, b.id)),
  };
}

function cardRank(c: IdentityCard): number {
  return c.status !== "active" ? 2 : c.isDefault ? 0 : 1;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type IdentityRefusal =
  | "bad_request"
  | "not_found"
  | "role"
  | "card_not_drivers"
  | "identity_taken";

export type IdentityResult =
  | { ok: true; changed: boolean; id: string }
  | { ok: false; category: IdentityRefusal; retryable: false };

type Deps = { db?: TenantDb; clock?: () => Date; newId?: () => string };

const refuse = (category: IdentityRefusal): IdentityResult => ({ ok: false, category, retryable: false });

class Refused extends Error {
  constructor(readonly category: IdentityRefusal) {
    super(`identity: ${category}`);
    this.name = "Refused";
  }
}

// One tenant transaction with the member read and the driver locked; a Refused throw rolls it
// back and answers with its category.
async function withDriver(
  session: Session,
  driverId: string,
  deps: Deps,
  adminOnly: boolean,
  fn: (q: Queryable, member: Member, nowIso: string) => Promise<IdentityResult>,
): Promise<IdentityResult> {
  if (!isCanonicalUuid(driverId)) return refuse("bad_request");
  const db = deps.db ?? getDb();
  const nowIso = (deps.clock ?? (() => new Date()))().toISOString();
  try {
    return await db.withTenant(session.tenantId, async (q) => {
      const member = await readMember(q, session);
      if (adminOnly && member.role !== "admin") throw new Refused("role");
      const rows = await q.query<{ id: string }>(
        "SELECT id FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE",
        [driverId],
      );
      if (rows.length !== 1) throw new Refused("not_found");
      return fn(q, member, nowIso);
    });
  } catch (err) {
    if (err instanceof Refused) return refuse(err.category);
    throw err;
  }
}

// An id the dispatch system knows this driver by. The same id again for the same driver is no
// change; an id another driver already holds is refused, never moved.
export async function addIdentity(
  session: Session,
  driverId: string,
  input: { system: "tms"; externalId: string },
  deps: Deps = {},
): Promise<IdentityResult> {
  if (input.system !== "tms" || typeof input.externalId !== "string" || !EXTERNAL_ID.test(input.externalId)) {
    return refuse("bad_request");
  }
  const newId = deps.newId ?? randomUUID;
  return withDriver(session, driverId, deps, false, async (q, _member, nowIso) => {
    const inserted = await q.execute(
      `INSERT INTO driver_identities (id, tenant_id, driver_id, system, external_id, source, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'tms', $3, 'ui', CAST($4 AS timestamptz))
       ON CONFLICT (tenant_id, system, external_id) DO NOTHING`,
      [newId(), driverId, input.externalId, nowIso],
    );
    const rows = await q.query<{ id: string; driver_id: string }>(
      `SELECT id, driver_id FROM driver_identities
        WHERE tenant_id = current_tenant_id() AND system = 'tms' AND external_id = $1`,
      [input.externalId],
    );
    if (rows.length !== 1) throw new Refused("identity_taken");
    if (rows[0].driver_id !== driverId) throw new Refused("identity_taken");
    return { ok: true, changed: inserted === 1, id: rows[0].id };
  });
}

// Whether the driver has a default active card now.
async function hasDefault(q: Queryable, driverId: string): Promise<boolean> {
  const rows = await q.query<{ id: string }>(
    `SELECT id FROM driver_cards
      WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND status = 'active' AND is_default`,
    [driverId],
  );
  return rows.length === 1;
}

async function clearDefault(q: Queryable, driverId: string): Promise<void> {
  await q.execute(
    `UPDATE driver_cards SET is_default = false
      WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND is_default`,
    [driverId],
  );
}

// A new card on file, in test mode with the simulated provider. A generic card carries the
// placeholder the provider's portal shows; a named card stores none. It becomes the default when
// asked, or when the driver has no default card, so a driver with a card can always be paid.
export async function addCard(
  session: Session,
  driverId: string,
  input: { last4: string; holderKind: "named" | "generic"; portalName?: string | null; makeDefault: boolean },
  deps: Deps = {},
): Promise<IdentityResult> {
  if (typeof input.last4 !== "string" || !LAST4.test(input.last4)) return refuse("bad_request");
  if (input.holderKind !== "named" && input.holderKind !== "generic") return refuse("bad_request");
  if (typeof input.makeDefault !== "boolean") return refuse("bad_request");
  const portalName = input.holderKind === "generic" ? normalizePortalName(input.portalName) : null;
  if (input.holderKind === "generic" && portalName === null) return refuse("bad_request");
  const newId = deps.newId ?? randomUUID;
  return withDriver(session, driverId, deps, true, async (q, _member, nowIso) => {
    const makeDefault = input.makeDefault || !(await hasDefault(q, driverId));
    if (makeDefault) await clearDefault(q, driverId);
    const id = newId();
    await q.execute(
      `INSERT INTO driver_cards (id, tenant_id, driver_id, provider, provider_token, last4, status,
                                 sim_behavior, source, created_at, is_default, holder_kind, portal_name)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'fuel_card_sim', $3, $4, 'active',
               'ok', 'ui', CAST($5 AS timestamptz), $6, $7, $8)`,
      [id, driverId, newCardToken(), input.last4, nowIso, makeDefault, input.holderKind, portalName],
    );
    return { ok: true, changed: true, id };
  });
}

// Closing a card: it is no longer paid and no longer the default. A closed card again is no
// change. Closing the default leaves the driver with none until a person picks another.
export async function closeCard(
  session: Session,
  driverId: string,
  cardId: string,
  deps: Deps = {},
): Promise<IdentityResult> {
  if (!isCanonicalUuid(cardId)) return refuse("bad_request");
  return withDriver(session, driverId, deps, true, async (q, _member, nowIso) => {
    const rows = await q.query<{ status: string }>(
      `SELECT status FROM driver_cards
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)
        FOR UPDATE`,
      [cardId, driverId],
    );
    if (rows.length !== 1) throw new Refused("card_not_drivers");
    if (rows[0].status === "closed") return { ok: true, changed: false, id: cardId };
    await q.execute(
      `UPDATE driver_cards SET status = 'closed', closed_at = CAST($3 AS timestamptz), is_default = false
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)
          AND status = 'active'`,
      [cardId, driverId, nowIso],
    );
    return { ok: true, changed: true, id: cardId };
  });
}

// One of the driver's active cards becomes the default, in one transaction: the old default is
// cleared first, and the partial unique index is the real guard against two.
export async function setDefaultCard(
  session: Session,
  driverId: string,
  cardId: string,
  deps: Deps = {},
): Promise<IdentityResult> {
  if (!isCanonicalUuid(cardId)) return refuse("bad_request");
  return withDriver(session, driverId, deps, true, async (q) => {
    const rows = await q.query<{ is_default: boolean }>(
      `SELECT is_default FROM driver_cards
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)
          AND status = 'active'
        FOR UPDATE`,
      [cardId, driverId],
    );
    if (rows.length !== 1) throw new Refused("card_not_drivers");
    if (rows[0].is_default === true) return { ok: true, changed: false, id: cardId };
    await clearDefault(q, driverId);
    await q.execute(
      `UPDATE driver_cards SET is_default = true
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)
          AND status = 'active'`,
      [cardId, driverId],
    );
    return { ok: true, changed: true, id: cardId };
  });
}
