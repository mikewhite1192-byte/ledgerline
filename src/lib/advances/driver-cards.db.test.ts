import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { addAdvance, addCard, closeCard, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import type { MoneyAction } from "../money/types";
import { readActiveCard, readCardDestination } from "./cards";

// Migrations 0017 and 0027's fuel cards as the app role sees them: the tenant wall, one default
// active card per driver (0027; more active cards beside it), the composite reference to the
// driver, the shape checks, and an advance's reference cleared (never the advance) when its card
// is deleted. Every tenant made here is removed after each test.

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;

const token = () => `fcs_card_${randomBytes(12).toString("hex")}`;

// One card row written as the app role in `as`'s tenant (or naming `tenantId` outright).
function insertCard(
  as: Fixture,
  o: {
    driverId?: string;
    tenantId?: string;
    tok?: string;
    last4?: string;
    status?: string;
    closedAt?: string | null;
    isDefault?: boolean;
    holderKind?: string;
    portalName?: string | null;
  } = {},
) {
  return app.withTenant(as.tenantId, (q) =>
    q.execute(
      `INSERT INTO driver_cards (id, tenant_id, driver_id, provider, provider_token, last4, status, sim_behavior,
         source, closed_at, is_default, holder_kind, portal_name)
       VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), 'fuel_card_sim', $4, $5, $6, 'ok', 'ui',
         CAST($7 AS timestamptz), $8, $9, $10)`,
      [
        randomUUID(),
        o.tenantId ?? as.tenantId,
        o.driverId ?? as.otherDriverId,
        o.tok ?? token(),
        o.last4 ?? "0042",
        o.status ?? "active",
        o.closedAt ?? null,
        o.isDefault ?? false,
        o.holderKind ?? "named",
        o.portalName ?? null,
      ],
    ),
  );
}

const cardsOf = (f: Fixture, as: Fixture = f) =>
  app.withTenant(as.tenantId, (q) =>
    q.query<{ id: string; driver_id: string; status: string }>(
      `SELECT CAST(id AS text) AS id, CAST(driver_id AS text) AS driver_id, status FROM driver_cards
        WHERE tenant_id = CAST($1 AS uuid) ORDER BY created_at, id`,
      [f.tenantId],
    ),
  );

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
});

beforeEach(async () => {
  const tag = randomUUID().slice(0, 8);
  A = await makeTenant(admin, `cards-a-${tag}`);
  B = await makeTenant(admin, `cards-b-${tag}`);
});

afterEach(async () => {
  await dropTenant(admin, A);
  await dropTenant(admin, B);
});

afterAll(async () => {
  await app?.close();
  await admin?.close();
});

describe("driver_cards (0017)", () => {
  it("shows another carrier nothing and refuses a card written into this carrier from another", async () => {
    expect(await cardsOf(A)).toHaveLength(2);
    expect(await cardsOf(A, B)).toEqual([]);
    expect(await app.withTenant(B.tenantId, (q) => readActiveCard(q, A.driverId))).toBeNull();
    await closeCard(admin, A, A.otherDriverId);
    expect(await sqlStateOf(insertCard(B, { tenantId: A.tenantId, driverId: A.otherDriverId }))).toBe("42501");
  });

  it("refuses a card that names another carrier's driver", async () => {
    await closeCard(admin, A, A.otherDriverId);
    expect(await sqlStateOf(insertCard(B, { driverId: A.otherDriverId }))).toBe("23503");
  });

  it("allows one default active card per driver and more active cards beside it; a closed default makes room", async () => {
    expect(await sqlStateOf(insertCard(A, { isDefault: true }))).toBe("23505");
    expect(await sqlStateOf(insertCard(A, { last4: "0043" }))).toBe("no error");
    // The default is still the one paid; the second active card is not it.
    expect(await app.withTenant(A.tenantId, (q) => readActiveCard(q, A.otherDriverId))).not.toMatchObject({ last4: "0043" });
    await closeCard(admin, A, A.otherDriverId);
    expect(await app.withTenant(A.tenantId, (q) => readActiveCard(q, A.otherDriverId))).toBeNull();
    expect(await sqlStateOf(insertCard(A, { isDefault: true }))).toBe("no error");
    const rows = (await cardsOf(A)).filter((c) => c.driver_id === A.otherDriverId);
    expect(rows.map((c) => c.status).sort()).toEqual(["active", "closed", "closed"]);
    expect(await app.withTenant(A.tenantId, (q) => readActiveCard(q, A.otherDriverId))).toMatchObject({ last4: "0042" });
  });

  it("holds 0027's card rules: a closed card is never the default, a generic card has a portal name of its shape", async () => {
    expect(await sqlStateOf(insertCard(A, { status: "closed", closedAt: "2026-11-02T16:00:00Z", isDefault: true }))).toBe("23514");
    expect(await sqlStateOf(insertCard(A, { holderKind: "generic" }))).toBe("23514");
    expect(await sqlStateOf(insertCard(A, { holderKind: "generic", portalName: "pool card" }))).toBe("23514");
    expect(await sqlStateOf(insertCard(A, { holderKind: "person" }))).toBe("23514");
    expect(await sqlStateOf(insertCard(A, { holderKind: "generic", portalName: "POOL CARD 3" }))).toBe("no error");
  });

  it("holds the shapes: provider token, last four, a closed card's close time, one provider per token", async () => {
    await closeCard(admin, A, A.otherDriverId);
    expect(await sqlStateOf(insertCard(A, { tok: "fcs_card_short" }))).toBe("23514");
    expect(await sqlStateOf(insertCard(A, { tok: `${token()}0` }))).toBe("23514");
    expect(await sqlStateOf(insertCard(A, { last4: "12345" }))).toBe("23514");
    expect(await sqlStateOf(insertCard(A, { last4: "12a4" }))).toBe("23514");
    expect(await sqlStateOf(insertCard(A, { status: "closed" }))).toBe("23514");
    expect(await sqlStateOf(insertCard(A, { status: "active", closedAt: "2026-11-02T16:00:00Z" }))).toBe("23514");
    const same = token();
    expect(await sqlStateOf(insertCard(A, { tok: same }))).toBe("no error");
    expect(await sqlStateOf(insertCard(A, { tok: same, status: "closed", closedAt: "2026-11-02T16:00:00Z" }))).toBe("23505");
  });

  it("reads back the card an advance recorded even after it closed, and only for that advance's driver", async () => {
    const advance = await addAdvance(admin, A);
    const card = await app.withTenant(A.tenantId, (q) => readActiveCard(q, A.driverId));
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE advances SET card_id = CAST($2 AS uuid) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [advance, card!.id],
      ),
    );
    const action = {
      kind: "advance_payout",
      subjectTable: "advances",
      subjectId: advance,
      counterpartyId: A.driverId,
    } as MoneyAction;
    await closeCard(admin, A, A.driverId);
    expect(await app.withTenant(A.tenantId, (q) => readCardDestination(q, action))).toEqual({
      rail: "fuel_card",
      provider: "fuel_card_sim",
      token: card!.token,
      last4: card!.last4,
      simBehavior: "ok",
    });
    expect(await app.withTenant(A.tenantId, (q) => readCardDestination(q, { ...action, counterpartyId: A.otherDriverId }))).toBeNull();
    expect(await app.withTenant(B.tenantId, (q) => readCardDestination(q, action))).toBeNull();
  });

  it("clears an advance's card reference, never the advance, when its card is deleted", async () => {
    const advance = await addAdvance(admin, A);
    const fresh = await (async () => {
      await closeCard(admin, A, A.driverId);
      return addCard(admin, A, A.driverId);
    })();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE advances SET card_id = CAST($2 AS uuid) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [advance, fresh],
      ),
    );
    await admin.withTenant(A.tenantId, (q) =>
      q.execute("DELETE FROM driver_cards WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [fresh]),
    );
    const rows = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ card_id: string | null }>(
        "SELECT CAST(card_id AS text) AS card_id FROM advances WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [advance],
      ),
    );
    expect(rows).toEqual([{ card_id: null }]);
  });

  it("refuses an advance that names another carrier's card", async () => {
    const advance = await addAdvance(admin, A);
    const theirs = await app.withTenant(B.tenantId, (q) => readActiveCard(q, B.driverId));
    expect(
      await sqlStateOf(
        admin.withTenant(A.tenantId, (q) =>
          q.execute(
            "UPDATE advances SET card_id = CAST($2 AS uuid) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
            [advance, theirs!.id],
          ),
        ),
      ),
    ).toBe("23503");
  });
});
