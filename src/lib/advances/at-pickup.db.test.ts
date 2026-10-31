import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { readAdvanceInput } from "../data/read";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { deskHandlers } from "../desk/handlers";
import { eventKey } from "../desk/keys";
import type { OpenEvent } from "../desk/log";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { advanceEligibility } from "../rules-engine";
import { proposeAdvanceAtPickup } from "./at-pickup";

// The advance at pickup against a fresh database, as the app's role, with a fixed clock: a load's
// move to in transit drafts exactly one advance card at the rules engine's suggestion, and nothing
// with the switch off, before the start date, for a driver nobody armed, or at a carrier whose
// advances unlock at delivery. 0073's check refuses any other stage. Every move here is written
// with its own recorded time, so nothing reads the wall clock. Only this file's carriers are made
// (America/Chicago, makeTenant); they are removed after.

// Monday Nov 2, 2026, 12:00 in Chicago.
const NOW = new Date("2026-11-02T18:00:00.000Z");
const savedPickup = structuredClone(flags.advanceAtPickup);
const savedMove = structuredClone(flags.loadMovement);

let admin: Db;
let app: Db;
const made: Fixture[] = [];

// Pay rules where the per-load cap binds: 70% of trip pay from pickup, a $5 fee, the whole of
// earned pay as the share and a $1,500 limit. stage null leaves the column to its default.
async function carrier(slug: string, stage: string | null = "picked_up"): Promise<Fixture> {
  const f = await makeTenant(admin, `${slug}-${randomUUID().slice(0, 8)}`);
  made.push(f);
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents,
         advance_per_load_bps_of_pay${stage === null ? "" : ", advance_unlock_stage"})
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'ui', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 500, 150000, 10000, 5000, 7000${stage === null ? "" : ", $2"})`,
      stage === null ? [randomUUID()] : [randomUUID(), stage],
    ),
  );
  return f;
}

let loadSeq = 0;
// A load on the road: 1,000 loaded miles at the fixture driver's 60 cents is $600.00 of trip pay,
// so 70% is $420.00 and, after the $5.00 fee, $415.00 is the most on it. Nothing is delivered.
async function onRoad(f: Fixture, recordedAt = "2026-11-02T14:05:00.000Z"): Promise<{ loadId: string; eventId: string }> {
  loadSeq += 1;
  const loadId = randomUUID();
  const eventId = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'in_transit', 'Joliet',
         'IL', 'Gary', 'IN', CAST($5 AS date), 1000, 150000)`,
      [loadId, `AP-L${String(20000 + loadSeq)}`, f.customerId, f.driverId, recordedAt.slice(0, 10)],
    );
    // The state miles add up to the load's miles, as the rules engine checks.
    await q.execute(
      `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'IL', 1000)`,
      [randomUUID(), loadId],
    );
    await q.execute(
      `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, source, at, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'planned', 'in_transit', 'staff',
         CAST($3 AS timestamptz), CAST($3 AS timestamptz))`,
      [eventId, loadId, recordedAt],
    );
  });
  return { loadId, eventId };
}

const event = (id: string): OpenEvent => ({
  eventKey: eventKey("load_event", id),
  source: "load_event",
  subjectId: id,
  state: "seen",
  attempts: 0,
  carries: 0,
  threw: 0,
  runId: null,
  found: null,
  firstAt: NOW.toISOString(),
});

const ctx = { deadlineMs: NOW.getTime() + 25_000, clock: () => NOW };

type CardRow = {
  subject_id: string;
  amount_cents: number;
  status: string;
  origin: string;
  operator_verdict: string;
  dedupe_key: string;
  args: Record<string, unknown>;
  reasons: { category: string }[];
};

const advanceCards = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<CardRow>(
      `SELECT CAST(subject_id AS text) AS subject_id, CAST(amount_cents AS integer) AS amount_cents, status, origin,
              operator_verdict, dedupe_key, args, reasons
         FROM proposals WHERE tenant_id = current_tenant_id() AND kind = 'advance_payout' ORDER BY created_at, id`,
    ),
  );

const direct = (f: Fixture, eventId: string) =>
  app.withTenant(f.tenantId, (q) => proposeAdvanceAtPickup(q, f.session, eventId, NOW));

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl(), max: 2 });
});

afterAll(async () => {
  for (const f of made) await dropTenant(admin, f);
  await app?.close();
  await admin?.close();
});

beforeEach(() => {
  flags.advanceAtPickup.enabled = true;
  flags.advanceAtPickup.startDate = "2026-10-31";
  flags.loadMovement.enabled = false;
});

afterEach(() => {
  Object.assign(flags.advanceAtPickup, savedPickup);
  Object.assign(flags.loadMovement, savedMove);
});

describe("the advance at pickup", () => {
  it("drafts one card at the engine's suggestion when a load is picked up, and one only under two desk runs", async () => {
    const f = await carrier("pickup-one");
    const { loadId, eventId } = await onRoad(f);
    const handlers = deskHandlers({ db: app });
    expect(handlers.load_event.switchOn()).toBe(true);

    const first = await handlers.load_event.run(f.session, event(eventId), ctx);
    expect(first).toEqual({ outcome: "done", detail: { found: 1, category: "advance_proposed" } });
    const second = await handlers.load_event.run(f.session, event(eventId), ctx);
    expect(second).toEqual({ outcome: "done", detail: { found: 0, category: "load_has_card" } });

    const cards = await advanceCards(f);
    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card).toMatchObject({
      subject_id: f.driverId,
      amount_cents: 41_500,
      status: "proposed",
      origin: "engine",
      operator_verdict: "at_pickup",
      reasons: [{ category: "load_picked_up" }],
    });
    expect(card.args).toMatchObject({
      driverId: f.driverId,
      amountCents: 41_500,
      requestedOn: "2026-11-02",
      loadId,
      loadEventId: eventId,
      load: { capCents: null, leftAfterCents: null, shareBps: 7_000 },
      revision: 0,
    });
    // The dedupe key names the kind and the driver, then hashes the whole args (the load among them).
    expect(card.dedupe_key.startsWith(`advance_payout:${f.driverId}:`)).toBe(true);

    // The engine check's recompute, as the approval reads it: the same amount is eligible.
    const again = await app.withTenant(f.tenantId, async (q) =>
      advanceEligibility(await readAdvanceInput(q, f.driverId, NOW.toISOString(), 41_500, loadId)),
    );
    expect(again).toMatchObject({ eligible: true, approvedCents: 41_500, loadCapCents: 42_000, earnedUnpaidCents: 60_000 });

    // A second load picked up while the driver's card waits: no second card, none retired.
    const other = await onRoad(f, "2026-11-02T15:00:00.000Z");
    expect(await direct(f, other.eventId)).toEqual({ kind: "nothing", category: "live_card" });
    expect((await advanceCards(f)).map((c) => c.status)).toEqual(["proposed"]);
  });

  it("drafts nothing with the switch off, even while load movement is on", async () => {
    const f = await carrier("pickup-off");
    const { eventId } = await onRoad(f);
    flags.advanceAtPickup.enabled = false;
    const handlers = deskHandlers({ db: app });
    expect(handlers.load_event.switchOn()).toBe(false);
    flags.loadMovement.enabled = true;
    expect(handlers.load_event.switchOn()).toBe(true);
    expect(await handlers.load_event.run(f.session, event(eventId), ctx)).toEqual({
      outcome: "done",
      detail: { found: 0, category: "recorded" },
    });
    expect(await direct(f, eventId)).toEqual({ kind: "nothing", category: "switched_off" });
    expect(await advanceCards(f)).toEqual([]);
  });

  it("drafts nothing for a move recorded before the start date, or before a later start date", async () => {
    const f = await carrier("pickup-early");
    // Friday Oct 30 in Chicago, the day before the start date.
    const early = await onRoad(f, "2026-10-30T20:00:00.000Z");
    expect(await direct(f, early.eventId)).toEqual({ kind: "nothing", category: "before_start" });
    const today = await onRoad(f);
    flags.advanceAtPickup.startDate = "2026-11-03";
    expect(await direct(f, today.eventId)).toEqual({ kind: "nothing", category: "before_start" });
    flags.advanceAtPickup.startDate = "not-a-date";
    expect(await direct(f, today.eventId)).toEqual({ kind: "nothing", category: "before_start" });
    expect(await advanceCards(f)).toEqual([]);
  });

  it("drafts nothing for a driver nobody has armed", async () => {
    const f = await carrier("pickup-unarmed");
    await admin.withTenant(f.tenantId, (q) =>
      q.execute("UPDATE drivers SET money_armed = false WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        f.driverId,
      ]),
    );
    const { eventId } = await onRoad(f);
    expect(await direct(f, eventId)).toEqual({ kind: "nothing", category: "nothing_to_advance" });
    expect(await advanceCards(f)).toEqual([]);
  });

  it("drafts nothing at a carrier whose advances unlock at delivery, the column's default", async () => {
    const f = await carrier("pickup-default", null);
    const stage = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ advance_unlock_stage: string }>(
        "SELECT advance_unlock_stage FROM pay_configs WHERE tenant_id = current_tenant_id()",
      ),
    );
    expect(stage).toEqual([{ advance_unlock_stage: "delivered" }]);
    const { eventId } = await onRoad(f);
    expect(await direct(f, eventId)).toEqual({ kind: "nothing", category: "stage_delivered" });
    expect(await advanceCards(f)).toEqual([]);
  });
});

describe("0073's check on the unlock stage", () => {
  it("refuses any stage but delivered or picked up", async () => {
    const f = await carrier("pickup-check");
    for (const bad of ["dispatched", "PICKED_UP", ""]) {
      const state = await sqlStateOf(
        admin.withTenant(f.tenantId, (q) =>
          q.execute("UPDATE pay_configs SET advance_unlock_stage = $1 WHERE tenant_id = current_tenant_id()", [bad]),
        ),
      );
      expect(state, bad).toBe("23514");
    }
    const nulled = await sqlStateOf(
      admin.withTenant(f.tenantId, (q) =>
        q.execute("UPDATE pay_configs SET advance_unlock_stage = NULL WHERE tenant_id = current_tenant_id()"),
      ),
    );
    expect(nulled).toBe("23502");
    const ok = await admin.withTenant(f.tenantId, (q) =>
      q.execute("UPDATE pay_configs SET advance_unlock_stage = 'delivered' WHERE tenant_id = current_tenant_id()"),
    );
    expect(ok).toBe(1);
  });
});
