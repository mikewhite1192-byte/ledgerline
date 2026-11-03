import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { getDriverIdentity } from "../agent/gateway/tools/read/get-driver-identity";
import type { Session } from "../auth/claims";
import { proposeCardLoadRuling } from "../card-loads/ruling";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { setDriverStatus } from "../drivers/status";
import { addCard, clearLedger, dropTenant, makeTenant, setArmed, sqlStateOf, type Fixture } from "../money/test-db";
import { serviceSession } from "../sweep/service-session";
import { assertMembership } from "../tenant/context";
import { readActivationChecklist, recordActivationStep, type ActivationStep } from "./activation";
import { armDriver } from "./arming";

// Migration 0085 and the activation checklist against the real database, as the app's role, with a
// fixed clock: before an admin arms a driver who is not armed, three steps are on record for the
// driver's default card; a statement that names someone else and a load nobody recorded block it;
// a new default card starts over; a driver armed before the switch keeps it. Every tenant made here
// is removed after each test.

// Monday Nov 2, 2026, 10:00 in Chicago (the fixture carriers' zone), after the ruling's start date.
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const clock = () => new Date(NOW);
const WRITTEN = "2026-11-02T14:00:00.000Z";
const BEFORE_START = "2026-10-30T14:00:00.000Z";
const saved = structuredClone(flags);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;

const deps = () => ({ db: app, clock });

const makeAdmin = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
      f.memberId,
    ]),
  );

// A step on the card the page would show: the driver's default card, unless the test names another.
const record = async (f: Fixture, step: ActivationStep, driverId: string = f.driverId, cardId?: string) =>
  recordActivationStep(f.session, driverId, { step, cardId: cardId ?? (await cardOf(f, driverId))?.id ?? randomUUID() }, deps());

const arm = (f: Fixture, driverId: string = f.driverId, note: string | null = null) =>
  armDriver(f.session, driverId, { armed: true, note }, deps());

async function recordAll(f: Fixture, driverId: string = f.driverId): Promise<void> {
  for (const step of ["identity_confirmed", "zero_test_sent", "hand_load_acknowledged"] as const) {
    expect(await record(f, step, driverId), step).toMatchObject({ ok: true });
  }
}

const stepRows = (f: Fixture, driverId: string = f.driverId) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ card_id: string; step: string; note: string | null; membership_id: string; created_at: string }>(
      `SELECT CAST(card_id AS text) AS card_id, step, note, CAST(membership_id AS text) AS membership_id,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         FROM driver_activation_steps WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
        ORDER BY step, card_id`,
      [driverId],
    ),
  );

const armEvents = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ driver_id: string; armed: boolean; note: string | null; membership_id: string | null; source: string; created_at: string }>(
      `SELECT CAST(driver_id AS text) AS driver_id, armed, note, CAST(membership_id AS text) AS membership_id, source,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         FROM driver_arm_events WHERE tenant_id = current_tenant_id() ORDER BY created_at, id`,
    ),
  );

const driverArm = async (f: Fixture, driverId: string = f.driverId) =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<{ money_armed: boolean; money_armed_at: string | null }>(
        `SELECT money_armed,
                to_char(money_armed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS money_armed_at
           FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [driverId],
      ),
    )
  )[0];

async function cardOf(f: Fixture, driverId: string = f.driverId): Promise<{ id: string; token: string; last4: string }> {
  const [c] = await admin.withTenant(f.tenantId, (q) =>
    q.query<{ id: string; token: string; last4: string }>(
      `SELECT CAST(id AS text) AS id, provider_token AS token, last4 FROM driver_cards
        WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid) AND is_default`,
      [driverId],
    ),
  );
  return c;
}

// A fuel row on the driver's default card's statement, naming its holder (the seed writes the
// statement). A later posted_at is the latest name.
async function statement(f: Fixture, portalName: string, postedAt: string, driverId: string = f.driverId): Promise<void> {
  const card = await cardOf(f, driverId);
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO card_transactions (id, tenant_id, provider, provider_ref, kind, card_token, card_last4, portal_name,
         posted_at, posted_on, amount_cents, state, gallons_milli, source, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'fuel_card_sim', $2, 'fuel', $3, $4, $5,
         CAST($6 AS timestamptz), CAST('2026-11-02' AS date), 12000, 'TX', 30000, 'seed', CAST($6 AS timestamptz))`,
      [randomUUID(), `fcs_fuel_${randomBytes(12).toString("hex")}`, card.token, card.last4, portalName, postedAt],
    ),
  );
}

// A statement load on the driver's default card with no payment record behind it, written at a
// fixed instant.
async function handLoad(f: Fixture, createdAt: string, driverId: string = f.driverId): Promise<string> {
  const card = await cardOf(f, driverId);
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO card_transactions (id, tenant_id, provider, provider_ref, kind, card_token, card_last4, portal_name,
         posted_at, posted_on, amount_cents, source, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'fuel_card_sim', $2, 'load', $3, $4, 'DRV-1',
         CAST($5 AS timestamptz), CAST('2026-11-02' AS date), 40000, 'seed', CAST($5 AS timestamptz))`,
      [id, `fcs_load_${randomBytes(12).toString("hex")}`, card.token, card.last4, createdAt],
    ),
  );
  return id;
}

async function addService(f: Fixture): Promise<Session> {
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@activation-test.invalid', 'staff')`,
    ),
  );
  const s = await serviceSession(app, f.tenantId);
  if (!s) throw new Error("no service login");
  return s;
}

// The deficit a Yes ruling books on a load: a drafted ruling card, then its deficit row.
async function ruleDeficit(f: Fixture, loadId: string): Promise<void> {
  const service = await addService(f);
  const r = await app.withTenant(f.tenantId, async (q) => {
    await assertMembership(q, service);
    return proposeCardLoadRuling(q, service, loadId, clock());
  });
  if (r.kind !== "proposed") throw new Error(`nothing drafted: ${r.category}`);
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id, named_by, proposal_id)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 40000, 'A note.', 'card_load', CAST($2 AS uuid),
         CAST($3 AS uuid), CAST($4 AS uuid))`,
      [f.driverId, loadId, f.memberId, r.proposalId],
    ),
  );
}

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
});

beforeEach(async () => {
  flags.activationChecklist.enabled = true;
  flags.driverAdmin.enabled = true;
  const tag = randomUUID().slice(0, 8);
  A = await makeTenant(admin, `activation-a-${tag}`);
  B = await makeTenant(admin, `activation-b-${tag}`);
});

afterEach(async () => {
  Object.assign(flags, structuredClone(saved));
  for (const f of [A, B]) {
    if (f) await clearLedger(admin, f);
    await dropTenant(admin, f);
  }
});

afterAll(async () => {
  await app?.close();
  await admin?.close();
});

describe("migration 0085: the steps table", () => {
  it("names its constraints, forces row level security, is append-only and leaves an armed driver armed", async () => {
    const cons = await admin.withoutTenant((q) =>
      q.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = CAST('driver_activation_steps' AS regclass) AND conname LIKE 'driver_activation_steps_%'
          ORDER BY conname`,
      ),
    );
    expect(cons).toEqual([
      {
        conname: "driver_activation_steps_card_fk",
        def: "FOREIGN KEY (tenant_id, driver_id, card_id) REFERENCES driver_cards(tenant_id, driver_id, id) ON DELETE CASCADE",
      },
      {
        conname: "driver_activation_steps_driver_fk",
        def: "FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, id) ON DELETE CASCADE",
      },
      {
        conname: "driver_activation_steps_member_fk",
        def: "FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id)",
      },
      {
        conname: "driver_activation_steps_note_check",
        def: "CHECK (((note IS NULL) OR ((length(note) >= 1) AND (length(note) <= 240))))",
      },
      {
        conname: "driver_activation_steps_one_per_card_step",
        def: "UNIQUE (tenant_id, driver_id, card_id, step)",
      },
      { conname: "driver_activation_steps_pkey", def: "PRIMARY KEY (id)" },
      {
        conname: "driver_activation_steps_step_check",
        def: "CHECK ((step = ANY (ARRAY['identity_confirmed'::text, 'zero_test_sent'::text, 'hand_load_acknowledged'::text])))",
      },
      {
        conname: "driver_activation_steps_tenant_id_fkey",
        def: "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
      },
      { conname: "driver_activation_steps_tenant_id_key", def: "UNIQUE (tenant_id, id)" },
    ]);
    const [rls] = await admin.withoutTenant((q) =>
      q.query<{ enabled: boolean; forced: boolean }>(
        "SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE relname = 'driver_activation_steps'",
      ),
    );
    expect(rls).toEqual({ enabled: true, forced: true });
    const index = await admin.withoutTenant((q) =>
      q.query<{ def: string }>("SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'driver_cards_tenant_driver_id'"),
    );
    expect(index).toHaveLength(1);
    expect(index[0].def).toContain("UNIQUE INDEX driver_cards_tenant_driver_id ON public.driver_cards USING btree (tenant_id, driver_id, id)");

    await makeAdmin(A);
    await setArmed(admin, A, A.otherDriverId, false);
    await recordAll(A, A.otherDriverId);
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute("UPDATE driver_activation_steps SET note = 'changed'")))).toBe(
      "42501",
    );
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute("DELETE FROM driver_activation_steps")))).toBe("42501");
    expect(await stepRows(A, A.otherDriverId)).toHaveLength(3);

    // The upgrade probe: the driver armed before anything here ran keeps it, with no arm log
    // written, and asking to arm them again is no change and reads no checklist.
    expect(await driverArm(A)).toEqual({ money_armed: true, money_armed_at: "2026-01-01T14:00:00.000Z" });
    expect(await arm(A)).toEqual({ ok: true, changed: false, armed: true, armedAt: "2026-01-01T14:00:00.000Z" });
    expect(await driverArm(A)).toEqual({ money_armed: true, money_armed_at: "2026-01-01T14:00:00.000Z" });
    expect(await armEvents(A)).toEqual([]);
  });
});

describe("arming with the activation checklist", () => {
  it("with the switch off, arming is exactly as today", async () => {
    flags.activationChecklist.enabled = false;
    await makeAdmin(A);
    await setArmed(admin, A, A.driverId, false);
    expect(await arm(A)).toMatchObject({ ok: true, changed: true, armed: true });
    expect(await armEvents(A)).toHaveLength(1);
    expect(await stepRows(A)).toEqual([]);
    // Off, no step is recorded either.
    expect(await record(A, "zero_test_sent", A.otherDriverId)).toEqual({ ok: false, category: "disabled", retryable: false });
    expect(await stepRows(A, A.otherDriverId)).toEqual([]);
  });

  it("with the switch on, an unprepared driver is refused and nothing is written", async () => {
    await makeAdmin(A);
    await setArmed(admin, A, A.driverId, false);
    expect(await arm(A)).toEqual({ ok: false, category: "identity_confirm", retryable: false });
    expect(await driverArm(A)).toMatchObject({ money_armed: false });
    expect(await armEvents(A)).toEqual([]);
    // Each missing step in turn is the arm's category.
    await record(A, "identity_confirmed");
    expect(await arm(A)).toMatchObject({ ok: false, category: "activate_without_zero_test" });
    await record(A, "zero_test_sent");
    expect(await arm(A)).toMatchObject({ ok: false, category: "activate_after_hand_load" });
    // Disarming never reads the checklist.
    await setArmed(admin, A, A.otherDriverId, true);
    expect(await armDriver(A.session, A.otherDriverId, { armed: false }, deps())).toMatchObject({ ok: true, changed: true, armed: false });
  });

  it("each step is an admin's click, recorded once per card", async () => {
    expect(await record(A, "zero_test_sent")).toEqual({ ok: false, category: "role", retryable: false });
    await makeAdmin(A);
    const card = await cardOf(A);
    const first = await record(A, "zero_test_sent");
    expect(first).toMatchObject({ ok: true, changed: true });
    if (!first.ok) throw new Error("refused");
    expect(first.checklist.card).toEqual({ id: card.id, last4: card.last4 });
    expect(first.checklist.steps).toEqual({ identity_confirmed: false, zero_test_sent: true, hand_load_acknowledged: false });
    expect(await record(A, "zero_test_sent")).toMatchObject({ ok: true, changed: false });
    expect(await stepRows(A)).toEqual([
      { card_id: card.id, step: "zero_test_sent", note: null, membership_id: A.memberId, created_at: "2026-11-02T16:00:00.000Z" },
    ]);
    // Another carrier's driver is not found, and another carrier reads none of the rows.
    expect(await record(A, "zero_test_sent", B.driverId)).toEqual({ ok: false, category: "not_found", retryable: false });
    const seen = await app.withTenant(B.tenantId, (q) =>
      q.query<{ n: number }>("SELECT count(*)::int AS n FROM driver_activation_steps WHERE tenant_id = CAST($1 AS uuid)", [A.tenantId]),
    );
    expect(seen).toEqual([{ n: 0 }]);
    // A row written across carriers is refused: row level security, then the references.
    const insertAs = (tenantId: string, driverId: string, cardId: string, memberId: string) =>
      app.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO driver_activation_steps (id, tenant_id, driver_id, card_id, step, membership_id)
           VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), 'identity_confirmed', CAST($5 AS uuid))`,
          [randomUUID(), tenantId, driverId, cardId, memberId],
        ),
      );
    const cardB = await cardOf(B);
    expect(await sqlStateOf(insertAs(B.tenantId, B.driverId, cardB.id, B.memberId))).toBe("42501");
    expect(await sqlStateOf(insertAs(A.tenantId, B.driverId, cardB.id, A.memberId))).toBe("23503");
    // A card of the other driver in the same carrier cannot be named for this one.
    const other = await cardOf(A, A.otherDriverId);
    expect(await sqlStateOf(insertAs(A.tenantId, A.driverId, other.id, A.memberId))).toBe("23503");
    expect(await stepRows(A)).toHaveLength(1);
  });

  it("identity cannot be confirmed against a statement that names someone else", async () => {
    await makeAdmin(A);
    await makeAdmin(B);
    await statement(A, "SOMEONE ELSE", "2026-11-01T14:00:00.000Z");
    expect(await record(A, "identity_confirmed")).toEqual({ ok: false, category: "identity_mismatch", retryable: false });
    expect(await stepRows(A)).toEqual([]);
    // The latest statement row names the driver by code: the step records.
    await statement(A, "DRV-1", "2026-11-02T14:00:00.000Z");
    expect(await record(A, "identity_confirmed")).toMatchObject({ ok: true, changed: true, checklist: { identity: "match" } });
    // No statement row yet: recorded with the person's word.
    expect(await record(B, "identity_confirmed")).toMatchObject({ ok: true, changed: true, checklist: { identity: "no_statement" } });
    // A statement naming someone else after the step was recorded still blocks the arm.
    await setArmed(admin, B, B.driverId, false);
    await record(B, "zero_test_sent");
    await record(B, "hand_load_acknowledged");
    await statement(B, "SOMEONE ELSE", "2026-11-02T15:00:00.000Z");
    expect(await arm(B)).toEqual({ ok: false, category: "identity_confirm", retryable: false });
  });

  it("a hand load with no record blocks the acknowledgement and the arm until it is ruled", async () => {
    await makeAdmin(A);
    await setArmed(admin, A, A.driverId, false);
    const loadId = await handLoad(A, WRITTEN);
    expect(await record(A, "hand_load_acknowledged")).toEqual({ ok: false, category: "hand_load_open", retryable: false });
    await record(A, "identity_confirmed");
    await record(A, "zero_test_sent");
    expect(await arm(A)).toEqual({ ok: false, category: "activate_after_hand_load", retryable: false });
    expect(await stepRows(A)).toHaveLength(2);
    await ruleDeficit(A, loadId);
    expect(await record(A, "hand_load_acknowledged")).toMatchObject({ ok: true, changed: true, checklist: { openHandLoads: 0 } });
    // A load written before the ruling's start date never counts.
    await handLoad(A, BEFORE_START);
    const checklist = await app.withTenant(A.tenantId, (q) => readActivationChecklist(q, A.driverId));
    expect(checklist).toMatchObject({ openHandLoads: 0, blockers: [] });
    expect(await arm(A)).toMatchObject({ ok: true, changed: true, armed: true });
  });

  it("a new default card needs its own steps", async () => {
    await makeAdmin(A);
    await setArmed(admin, A, A.driverId, false);
    const one = await cardOf(A);
    await recordAll(A);
    await admin.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE driver_cards SET is_default = false WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)", [
        A.driverId,
      ]),
    );
    const two = await addCard(admin, A, A.driverId);
    // A page loaded before the change still shows card one: its step is refused and writes nothing.
    expect(await record(A, "zero_test_sent", A.driverId, one.id)).toEqual({ ok: false, category: "card_changed", retryable: false });
    expect(await record(A, "identity_confirmed", A.driverId, one.id.toUpperCase())).toEqual({
      ok: false,
      category: "bad_request",
      retryable: false,
    });
    expect((await stepRows(A)).filter((r) => r.card_id === two)).toEqual([]);
    expect(await arm(A)).toEqual({ ok: false, category: "identity_confirm", retryable: false });
    expect((await stepRows(A)).map((r) => r.card_id)).toEqual([one.id, one.id, one.id]);
    await recordAll(A);
    expect((await stepRows(A)).filter((r) => r.card_id === two)).toHaveLength(3);
    expect(await arm(A)).toMatchObject({ ok: true, changed: true });
  });

  it("a deactivated driver is refused before the checklist, and the same card's steps stand after reactivation", async () => {
    await makeAdmin(A);
    await setArmed(admin, A, A.driverId, false);
    await recordAll(A);
    expect(await setDriverStatus(A.session, A.driverId, { active: false }, deps())).toMatchObject({ ok: true, changed: true });
    expect(await arm(A)).toEqual({ ok: false, category: "driver_inactive", retryable: false });
    expect(await record(A, "zero_test_sent")).toEqual({ ok: false, category: "driver_inactive", retryable: false });
    expect(await setDriverStatus(A.session, A.driverId, { active: true }, deps())).toMatchObject({ ok: true, changed: true });
    expect(await arm(A)).toMatchObject({ ok: true, changed: true, armed: true });
  });

  it("the arm after a passing checklist writes today's event", async () => {
    await makeAdmin(A);
    await setArmed(admin, A, A.driverId, false);
    await recordAll(A);
    expect(await arm(A, A.driverId, "Checklist done")).toEqual({
      ok: true,
      changed: true,
      armed: true,
      armedAt: "2026-11-02T16:00:00.000Z",
    });
    expect(await armEvents(A)).toEqual([
      {
        driver_id: A.driverId,
        armed: true,
        note: "Checklist done",
        membership_id: A.memberId,
        source: "ui",
        created_at: "2026-11-02T16:00:00.000Z",
      },
    ]);
    expect(await driverArm(A)).toEqual({ money_armed: true, money_armed_at: "2026-11-02T16:00:00.000Z" });
  });

  it("the agent's identity read names the blocker the arm would refuse with", async () => {
    await makeAdmin(A);
    await setArmed(admin, A, A.driverId, false);
    await record(A, "identity_confirmed");
    const ctx = { now: clock(), timeZone: "America/Chicago", session: A.session } as never;
    const read = () =>
      app.withTenant(A.tenantId, (q) => getDriverIdentity.run(q, ctx, { driverId: A.driverId }, { screen: null, limit: null } as never));
    const out = await read();
    const activation = (out.result as { activation: { blockers: string[]; steps: Record<string, boolean> } }).activation;
    expect(activation.blockers).toEqual(["activate_without_zero_test", "activate_after_hand_load"]);
    expect(activation.steps).toEqual({ identity_confirmed: true, zero_test_sent: false, hand_load_acknowledged: false });
    const refused = await arm(A);
    expect(refused).toMatchObject({ ok: false, category: activation.blockers[0] });
    expect(JSON.stringify(out.result)).not.toContain((await cardOf(A)).token);
    // The read writes nothing.
    expect(await stepRows(A)).toHaveLength(1);
    // An armed, paying driver and a driver with a last day on file get no checklist at all.
    const armed = await app.withTenant(A.tenantId, (q) =>
      getDriverIdentity.run(q, ctx, { driverId: A.otherDriverId }, { screen: null, limit: null } as never),
    );
    expect(Object.keys(armed.result as object)).toEqual(["driver"]);
    expect(await setDriverStatus(A.session, A.driverId, { active: false }, deps())).toMatchObject({ ok: true, changed: true });
    expect(Object.keys((await read()).result as object)).toEqual(["driver"]);
  });
});
