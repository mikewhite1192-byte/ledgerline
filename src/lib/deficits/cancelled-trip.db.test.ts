import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { dedupeKey } from "../agent/gateway/store/proposals";
import type { Session } from "../auth/claims";
import { autopilotSub } from "../autopilot/session";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { deskHandlers } from "../desk/handlers";
import { eventKey } from "../desk/keys";
import type { OpenEvent } from "../desk/log";
import { dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { EXECUTORS, executeProposal, type ApproveOptions, type Executor, type ProposalRow } from "../proposals/execute";
import { deficitBookExecutor } from "../proposals/executors/deficit-book";
import { serviceSession } from "../sweep/service-session";

// The cancelled trip against the real database, as the app's role, with a fixed clock: a person
// cancels a load after its driver was paid an advance on it, the desk drafts one deficit card per
// advance still owed (never one for an advance already earned back, never one for a cancel before
// the start date, never two for one cancel), and a person's Yes closes the advance and books the
// same whole cents as one named deficit. A card whose advance pay recovered part of since, or that
// is otherwise no longer bookable, ends failed with its note; one a card pull-back or an approved
// paystub holds right now is refused and stays proposed. The autopilot never approves one, and
// either switch off (the cancelled trip, or deficit recovery) refuses at every path. Only this
// file's carriers are made (America/Chicago, makeTenant), and they are removed after.

// Monday Nov 2, 2026, 12:00 in Chicago (CST since Nov 1).
const NOW = new Date("2026-11-02T18:00:00.000Z");
const clock = () => NOW;
const saved = structuredClone(flags);

let admin: Db;
let app: Db;
const made: Fixture[] = [];

type Carrier = Fixture & { service: Session };

async function carrier(slug: string): Promise<Carrier> {
  const f = await makeTenant(admin, `${slug}-${randomUUID().slice(0, 8)}`);
  made.push(f);
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@trip-test.invalid', 'staff')`,
    ),
  );
  const service = await serviceSession(app, f.tenantId);
  if (!service) throw new Error("no service login");
  return { ...f, service };
}

let seq = 0;
// A load on the road for the fixture driver.
async function onRoad(f: Fixture): Promise<{ id: string; number: string }> {
  seq += 1;
  const id = randomUUID();
  const number = `CT-L${String(30000 + seq)}`;
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'in_transit', 'Joliet',
         'IL', 'Gary', 'IN', CAST('2026-11-01' AS date), 420, 150000)`,
      [id, number, f.customerId, f.driverId],
    ),
  );
  return { id, number };
}

// A paid advance on the load, with its fee and what pay already recovered.
async function paidAdvance(
  f: Fixture,
  loadId: string,
  over: { cents?: number; fee?: number; recovered?: number; requestedAt?: string } = {},
): Promise<string> {
  seq += 1;
  const id = randomUUID();
  const at = over.requestedAt ?? "2026-11-02T15:00:00.000Z";
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO advances (id, tenant_id, driver_id, request_ref, requested_at, requested_on, amount_cents, fee_cents,
         recovered_cents, status, source, paid_at, load_id)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS timestamptz), CAST('2026-11-02' AS date),
         $5, $6, $7, 'paid', 'ui', CAST($4 AS timestamptz), CAST($8 AS uuid))`,
      [id, f.driverId, `CT-${seq}-${id.slice(0, 8)}`, at, over.cents ?? 40_000, over.fee ?? 0, over.recovered ?? 0, loadId],
    ),
  );
  return id;
}

// The cancel a person pressed, as staffMove records it (src/lib/loads/movement.db.test.ts runs
// the press itself), with its recorded time pinned so no test reads the wall clock: the load's
// status and one load_events row in one transaction. Returns the event's id.
async function cancelled(f: Fixture, loadId: string, at = NOW.toISOString()): Promise<string> {
  return admin.withTenant(f.tenantId, async (q) => {
    const n = await q.execute(
      `UPDATE loads SET status = 'cancelled'
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'in_transit'`,
      [loadId],
    );
    if (n !== 1) throw new Error("the load did not cancel");
    const [e] = await q.query<{ id: string }>(
      `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, source, at, created_at)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 'in_transit', 'cancelled', 'staff',
         CAST($2 AS timestamptz), CAST($2 AS timestamptz))
       RETURNING CAST(id AS text) AS id`,
      [loadId, at],
    );
    return e.id;
  });
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

const ctx = { deadlineMs: NOW.getTime() + 25_000, clock };

const run = (f: Carrier, eventId: string) => deskHandlers({ db: app }).load_event.run(f.service, event(eventId), ctx);

type Card = { id: string; subject_id: string; amount_cents: number; status: string; args: Record<string, unknown> };

const cardsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<Card>(
      `SELECT CAST(id AS text) AS id, CAST(subject_id AS text) AS subject_id, CAST(amount_cents AS integer) AS amount_cents,
              status, args
         FROM proposals WHERE tenant_id = current_tenant_id() AND kind = 'deficit_book' ORDER BY created_at, id`,
    ),
  );

async function count(f: Fixture, sql: string, params: Param[] = []): Promise<number> {
  const [r] = await admin.withTenant(f.tenantId, (q) => q.query<{ n: string }>(sql, params));
  return Number(r.n);
}

const deficitsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ driver_id: string; amount_cents: string; source_kind: string; source_id: string; named_by: string; proposal_id: string; note: string }>(
      `SELECT CAST(driver_id AS text) AS driver_id, CAST(amount_cents AS text) AS amount_cents, source_kind,
              CAST(source_id AS text) AS source_id, CAST(named_by AS text) AS named_by,
              CAST(proposal_id AS text) AS proposal_id, note
         FROM driver_deficits WHERE tenant_id = current_tenant_id() ORDER BY created_at, id`,
    ),
  );

const advanceOf = async (f: Fixture, id: string) =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<{ owed: string; taken_back_cents: string; takeback_reason: string | null; taken_back_by: string | null }>(
        `SELECT CAST(amount_cents + fee_cents - recovered_cents - taken_back_cents AS text) AS owed,
                CAST(taken_back_cents AS text) AS taken_back_cents, takeback_reason,
                CAST(taken_back_by_membership_id AS text) AS taken_back_by
           FROM advances WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0];

const proposalOf = async (f: Fixture, id: string) =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<{ status: string; decision_note: string | null }>(
        "SELECT status, decision_note FROM proposals WHERE id = CAST($1 AS uuid)",
        [id],
      ),
    )
  )[0];

// The auditor's pass, as a finished audit stores it.
const audited = (f: Fixture, id: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_checked_at = CAST($2 AS timestamptz)
        WHERE id = CAST($1 AS uuid)`,
      [id, NOW.toISOString()],
    ),
  );

const approve = (session: Session, id: string, opts: ApproveOptions = { confirmed: false }, executors?: Record<string, Executor>) =>
  executeProposal(session, id, opts, { db: app, clock, ...(executors ? { executors } : {}) });

// One cancelled load with one paid $400.00 advance, drafted and audited: the card's id.
async function oneCard(f: Carrier): Promise<{ loadId: string; advanceId: string; cardId: string; number: string }> {
  const l = await onRoad(f);
  const advanceId = await paidAdvance(f, l.id);
  const eventId = await cancelled(f, l.id);
  expect(await run(f, eventId)).toEqual({ outcome: "done", detail: { found: 1, category: "deficit_proposed" } });
  const [card] = await cardsOf(f);
  await audited(f, card.id);
  return { loadId: l.id, advanceId, cardId: card.id, number: l.number };
}

// A card pull-back row against the advance, with the card_pullback proposal it belongs to, in the
// status given (src/lib/settlements/deficit-recovery.db.test.ts makes them the same way).
async function addPull(f: Fixture, advanceId: string, status: "issuing" | "unknown"): Promise<void> {
  const [conversation, turn, decision, proposal, trace, pull] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const args = { driverId: f.driverId, advanceId, reason: "driver_request", requestedCents: 20_000 };
  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute("INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)", [
      conversation,
      f.session.sub,
    ]);
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Take it off the card', 'done', $3,
         CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
      [turn, conversation, trace, at],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark', 'propose_card_pullback',
         'propose', 'allowed', 'ok', 1)`,
      [decision, turn, trace],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
         created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'card_pullback',
         'advances', CAST($4 AS uuid), 20000, 'in', 'Pull money back off a fuel card', CAST($5 AS jsonb), 'not_given',
         CAST($6 AS uuid), $7, $8, CAST($9 AS timestamptz), CAST($9 AS timestamptz))`,
      [proposal, conversation, turn, advanceId, JSON.stringify(args), decision, dedupeKey("card_pullback", advanceId, args), trace, at],
    );
    await q.execute(
      `INSERT INTO card_pullbacks (id, tenant_id, driver_id, card_id, proposal_id, advance_id, reason, requested_cents,
         balance_cents, pull_cents, shortfall_cents, status)
       SELECT CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), c.id, CAST($3 AS uuid), CAST($4 AS uuid),
              'driver_request', 20000, 25000, 20000, 0, $5
         FROM driver_cards c
        WHERE c.tenant_id = current_tenant_id() AND c.driver_id = CAST($2 AS uuid) AND c.is_default`,
      [pull, f.driverId, proposal, advanceId, status],
    );
  });
}

// An approved paystub, not booked, with a $50.00 recovery line on the advance.
async function approvedRecovery(f: Fixture, advanceId: string): Promise<void> {
  const [config, periodId, id] = [randomUUID(), randomUUID(), randomUUID()];
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 0, 50000, 5000, 5000)`,
      [config],
    );
    await q.execute(
      `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-11-02' AS date), CAST('2026-11-08' AS date), 'approved')`,
      [periodId],
    );
    await q.execute(
      `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
         deductions_cents, net_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid),
         'approved', 100000, 5000, 95000)`,
      [id, periodId, f.driverId, config],
    );
    const lines: [string, number, { table: string; id: string }[]][] = [
      ["load_pay", 100_000, [{ table: "loads", id: randomUUID() }]],
      ["advance_recovery", -5_000, [{ table: "advances", id: advanceId }]],
    ];
    let n = 0;
    for (const [kind, amount, sources] of lines) {
      n += 1;
      await q.execute(
        `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $4, $5, CAST($6 AS jsonb))`,
        [randomUUID(), id, n, kind, amount, JSON.stringify(sources)],
      );
    }
  });
}

// A cancelled-trip deficit already on the advance, booked some other way (no card).
const tripDeficit = (f: Fixture, advanceId: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO driver_deficits (id, tenant_id, driver_id, amount_cents, note, source_kind, source_id, named_by, created_at)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 40000, 'Booked by hand', 'cancelled_trip',
         CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS timestamptz))`,
      [f.driverId, advanceId, f.memberId, NOW.toISOString()],
    ),
  );

// The card as the gate hands it to its executor, for calls that reach the executor directly.
const rowFor = (c: { cardId: string; advanceId: string }, status: string): ProposalRow => ({
  id: c.cardId,
  conversationId: null,
  turnId: null,
  kind: "deficit_book",
  subjectTable: "advances",
  subjectId: c.advanceId,
  amountCents: 40_000,
  direction: "none",
  args: {},
  status,
  flaggedInputId: null,
  auditorVerdict: "pass",
  auditorAgrees: true,
  moneyActionId: null,
  traceId: null,
});

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
  flags.cancelledTrip = { enabled: true, startDate: "2026-11-02" };
  flags.deficitRecovery = { enabled: true, startDate: "2026-11-02" };
  flags.loadMovement.enabled = false;
  flags.advanceAtPickup.enabled = false;
  flags.agentAsks.enabled = true;
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
});

describe("drafting the deficit card", () => {
  it("drafts one card per advance still owed, with what each still owes, and one question each", async () => {
    const f = await carrier("trip-two");
    const l = await onRoad(f);
    const later = await paidAdvance(f, l.id, { cents: 25_000, fee: 500, recovered: 5_000, requestedAt: "2026-11-02T16:00:00.000Z" });
    const first = await paidAdvance(f, l.id, { cents: 40_000, requestedAt: "2026-11-02T14:00:00.000Z" });
    const eventId = await cancelled(f, l.id);
    expect(await run(f, eventId)).toEqual({ outcome: "done", detail: { found: 2, category: "deficit_proposed" } });
    // Both cards carry the same clock, so they are compared largest first.
    const cards = (await cardsOf(f)).sort((x, y) => y.amount_cents - x.amount_cents);
    expect(cards.map((c) => [c.subject_id, c.amount_cents, c.status])).toEqual([
      [first, 40_000, "proposed"],
      [later, 20_500, "proposed"],
    ]);
    expect(cards[0].args).toMatchObject({
      driverId: f.driverId,
      advanceId: first,
      loadId: l.id,
      loadEventId: eventId,
      amountCents: 40_000,
      sourceKind: "cancelled_trip",
    });
    const asks = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ text: string }>(
        "SELECT text FROM agent_asks WHERE tenant_id = current_tenant_id() AND subject_id = CAST($1 AS uuid)",
        [first],
      ),
    );
    expect(asks).toEqual([
      {
        text:
          `Load ${l.number} was cancelled after Test Driver got a $400.00 advance on it. ` +
          "Yes books the $400.00 as money Test Driver owes, taken back from later pay.",
      },
    ]);
    // Nothing moved: no deficit, and the advances still owe what they owed.
    expect(await deficitsOf(f)).toEqual([]);
    expect((await advanceOf(f, first)).owed).toBe("40000");
  });

  it("makes one card under the same event worked twice, and two runs at once", async () => {
    const f = await carrier("trip-twice");
    const l = await onRoad(f);
    await paidAdvance(f, l.id);
    const eventId = await cancelled(f, l.id);
    const both = await Promise.all([run(f, eventId), run(f, eventId)]);
    expect(both.map((r) => (r.outcome === "done" ? r.detail?.category : r.outcome)).sort()).toEqual([
      "already_drafted",
      "deficit_proposed",
    ]);
    expect(await run(f, eventId)).toEqual({ outcome: "done", detail: { found: 0, category: "already_drafted" } });
    expect(await cardsOf(f)).toHaveLength(1);
  });

  it("drafts nothing for an advance already earned back, or a cancelled load with no advance", async () => {
    const f = await carrier("trip-repaid");
    const l = await onRoad(f);
    await paidAdvance(f, l.id, { cents: 30_000, fee: 500, recovered: 30_500 });
    expect(await run(f, await cancelled(f, l.id))).toEqual({ outcome: "done", detail: { found: 0, category: "no_advance" } });
    const bare = await onRoad(f);
    expect(await run(f, await cancelled(f, bare.id))).toEqual({ outcome: "done", detail: { found: 0, category: "no_advance" } });
    expect(await cardsOf(f)).toEqual([]);
  });

  it("drafts nothing for a cancel recorded before the start date", async () => {
    const f = await carrier("trip-backlog");
    const l = await onRoad(f);
    await paidAdvance(f, l.id, { requestedAt: "2026-11-01T15:00:00.000Z" });
    // A cancel made on Sunday Nov 1 in Chicago, the day before the switch's start date.
    const eventId = await cancelled(f, l.id, "2026-11-01T20:00:00.000Z");
    expect(await run(f, eventId)).toEqual({ outcome: "done", detail: { found: 0, category: "before_start" } });
    expect(await cardsOf(f)).toEqual([]);
  });

  it("leaves a move that is not a cancel to the advance at pickup, and drafts nothing on it", async () => {
    const f = await carrier("trip-notcancel");
    const l = await onRoad(f);
    await paidAdvance(f, l.id);
    const [e] = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ id: string }>(
        `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, source, at, created_at)
         VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 'in_transit', 'delivered', 'staff',
           CAST($2 AS timestamptz), CAST($2 AS timestamptz))
         RETURNING CAST(id AS text) AS id`,
        [l.id, NOW.toISOString()],
      ),
    );
    expect(await run(f, e.id)).toEqual({ outcome: "done", detail: { found: 0, category: "recorded" } });
    expect(await cardsOf(f)).toEqual([]);
  });

  it("drafts nothing with the switch off, records the event as before, and has no executor", async () => {
    const f = await carrier("trip-off");
    const l = await onRoad(f);
    await paidAdvance(f, l.id);
    const eventId = await cancelled(f, l.id);
    flags.cancelledTrip = { enabled: false, startDate: "2026-11-02" };
    const handlers = deskHandlers({ db: app });
    expect(handlers.load_event.switchOn()).toBe(false);
    expect(await run(f, eventId)).toEqual({ outcome: "done", detail: { found: 0, category: "recorded" } });
    expect(await cardsOf(f)).toEqual([]);
    expect(EXECUTORS.deficit_book).toBeUndefined();
    flags.cancelledTrip = { enabled: true, startDate: "2026-11-02" };
    expect(EXECUTORS.deficit_book).toBe(deficitBookExecutor);
  });

  it("drafts nothing with deficit recovery off, records the event as before, and has no executor", async () => {
    const f = await carrier("trip-norecovery");
    const l = await onRoad(f);
    await paidAdvance(f, l.id);
    const eventId = await cancelled(f, l.id);
    flags.deficitRecovery = { enabled: false, startDate: "2026-11-02" };
    expect(deskHandlers({ db: app }).load_event.switchOn()).toBe(false);
    expect(await run(f, eventId)).toEqual({ outcome: "done", detail: { found: 0, category: "recorded" } });
    expect(await cardsOf(f)).toEqual([]);
    expect(EXECUTORS.deficit_book).toBeUndefined();
    flags.deficitRecovery = { enabled: true, startDate: "2026-11-02" };
    expect(EXECUTORS.deficit_book).toBe(deficitBookExecutor);
  });

  it("drafts nothing for an advance a card pull-back is taking back right now", async () => {
    const f = await carrier("trip-livepull");
    const l = await onRoad(f);
    const advanceId = await paidAdvance(f, l.id);
    await addPull(f, advanceId, "issuing");
    expect(await run(f, await cancelled(f, l.id))).toEqual({ outcome: "done", detail: { found: 0, category: "already_drafted" } });
    expect(await cardsOf(f)).toEqual([]);
  });

  it("drafts nothing for an advance that already has a cancelled-trip deficit", async () => {
    const f = await carrier("trip-hasdeficit");
    const l = await onRoad(f);
    const advanceId = await paidAdvance(f, l.id);
    await tripDeficit(f, advanceId);
    expect(await run(f, await cancelled(f, l.id))).toEqual({ outcome: "done", detail: { found: 0, category: "already_drafted" } });
    expect(await cardsOf(f)).toEqual([]);
  });
});

describe("approving the deficit card", () => {
  it("closes the advance and books one deficit for the same cents, and books no second on another Yes", async () => {
    const f = await carrier("trip-yes");
    const c = await oneCard(f);
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: true, status: "done", moneyActionId: null });
    expect(await proposalOf(f, c.cardId)).toEqual({ status: "done", decision_note: "booked" });
    expect(await advanceOf(f, c.advanceId)).toEqual({
      owed: "0",
      taken_back_cents: "40000",
      takeback_reason: "cancelled_trip",
      taken_back_by: f.memberId,
    });
    expect(await deficitsOf(f)).toEqual([
      {
        driver_id: f.driverId,
        amount_cents: "40000",
        source_kind: "cancelled_trip",
        source_id: c.advanceId,
        named_by: f.memberId,
        proposal_id: c.cardId,
        note: `Load ${c.number} cancelled after a $400.00 advance on it.`,
      },
    ]);
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: false, category: "already_decided" });
    // The executor reached straight on the done card finds it done and writes nothing more.
    expect(await deficitBookExecutor(app, f.session, rowFor(c, "done"), { confirmed: false }, { db: app, clock })).toMatchObject({
      ok: true,
      status: "done",
    });
    const [card] = await cardsOf(f);
    expect(card.status).toBe("done");
    expect(await deficitsOf(f)).toHaveLength(1);
    expect(await advanceOf(f, c.advanceId)).toMatchObject({ owed: "0", taken_back_cents: "40000" });
    // Nothing paid or sent.
    expect(await count(f, "SELECT count(*) AS n FROM money_actions WHERE tenant_id = current_tenant_id()")).toBe(0);
  });

  it("ends the card failed as recovered_by_pay when pay recovered part of the advance first, and writes nothing else", async () => {
    const f = await carrier("trip-stale");
    const c = await oneCard(f);
    await admin.withTenant(f.tenantId, (q) =>
      q.execute("UPDATE advances SET recovered_cents = 10000 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        c.advanceId,
      ]),
    );
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalOf(f, c.cardId)).toEqual({ status: "failed", decision_note: "recovered_by_pay" });
    expect(await deficitsOf(f)).toEqual([]);
    expect(await advanceOf(f, c.advanceId)).toMatchObject({ owed: "30000", taken_back_cents: "0", takeback_reason: null });
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: false, category: "already_decided" });
  });

  it("ends the card failed as stale when the advance was taken back first, and writes nothing else", async () => {
    const f = await carrier("trip-takenback");
    const c = await oneCard(f);
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `UPDATE advances SET taken_back_cents = 40000, taken_back_at = CAST($2 AS timestamptz),
                taken_back_by_membership_id = CAST($3 AS uuid), takeback_reason = 'other'
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [c.advanceId, NOW.toISOString(), f.memberId],
      ),
    );
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalOf(f, c.cardId)).toEqual({ status: "failed", decision_note: "stale" });
    expect(await deficitsOf(f)).toEqual([]);
    expect(await advanceOf(f, c.advanceId)).toMatchObject({ taken_back_cents: "40000", takeback_reason: "other" });
  });

  it("ends the card failed as stale when a cancelled-trip deficit was booked on the advance first", async () => {
    const f = await carrier("trip-deficitfirst");
    const c = await oneCard(f);
    await tripDeficit(f, c.advanceId);
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalOf(f, c.cardId)).toEqual({ status: "failed", decision_note: "stale" });
    expect(await deficitsOf(f)).toHaveLength(1);
    expect(await advanceOf(f, c.advanceId)).toMatchObject({ owed: "40000", taken_back_cents: "0", takeback_reason: null });
  });

  it("refuses the card as stale and leaves it proposed while a card pull-back is taking the advance back", async () => {
    const f = await carrier("trip-pullfirst");
    const c = await oneCard(f);
    await addPull(f, c.advanceId, "unknown");
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalOf(f, c.cardId)).toEqual({ status: "proposed", decision_note: null });
    expect(await deficitsOf(f)).toEqual([]);
    expect((await advanceOf(f, c.advanceId)).owed).toBe("40000");
  });

  it("refuses the card as stale and leaves it proposed while an approved paystub recovers the advance", async () => {
    const f = await carrier("trip-stubfirst");
    const c = await oneCard(f);
    await approvedRecovery(f, c.advanceId);
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: false, category: "stale" });
    expect(await proposalOf(f, c.cardId)).toEqual({ status: "proposed", decision_note: null });
    expect(await deficitsOf(f)).toEqual([]);
    expect((await advanceOf(f, c.advanceId)).owed).toBe("40000");
  });

  it("fails the card with nothing written when the facts change between the approval and the booking", async () => {
    const f = await carrier("trip-race");
    const c = await oneCard(f);
    const racing: Executor = async (db, session, proposal, opts, deps) => {
      await admin.withTenant(f.tenantId, (q) =>
        q.execute("UPDATE advances SET recovered_cents = 1000 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
          c.advanceId,
        ]),
      );
      return deficitBookExecutor(db, session, proposal, opts, deps);
    };
    expect(await approve(f.session, c.cardId, { confirmed: false }, { deficit_book: racing })).toMatchObject({
      ok: false,
      category: "stale",
    });
    expect(await proposalOf(f, c.cardId)).toEqual({ status: "failed", decision_note: "recovered_by_pay" });
    expect(await deficitsOf(f)).toEqual([]);
    expect(await advanceOf(f, c.advanceId)).toMatchObject({ taken_back_cents: "0", takeback_reason: null });
  });

  it("never lets the autopilot or the sweep's login approve one", async () => {
    const f = await carrier("trip-auto");
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), $1, 'autopilot@trip-test.invalid', 'staff')`,
        [autopilotSub(f.tenantId)],
      ),
    );
    const auto: Session = { sub: autopilotSub(f.tenantId), email: "", tenantId: f.tenantId };
    const c = await oneCard(f);
    expect(await approve(auto, c.cardId, { confirmed: false, autopilot: { ruleId: randomUUID(), version: 1 } })).toMatchObject({
      ok: false,
      category: "kind_never_alone",
    });
    expect(await approve(f.service, c.cardId)).toMatchObject({ ok: false, category: "service_login" });
    expect((await proposalOf(f, c.cardId)).status).toBe("proposed");
    expect(await deficitsOf(f)).toEqual([]);
  });

  it("refuses the autopilot's login at the executor itself, with nothing written", async () => {
    const f = await carrier("trip-autowall");
    const auto: Session = { sub: autopilotSub(f.tenantId), email: "", tenantId: f.tenantId };
    const c = await oneCard(f);
    expect(await deficitBookExecutor(app, auto, rowFor(c, "approved"), { confirmed: false }, { db: app, clock })).toEqual({
      ok: false,
      category: "kind_never_alone",
      retryable: false,
    });
    expect((await proposalOf(f, c.cardId)).status).toBe("proposed");
    expect(await deficitsOf(f)).toEqual([]);
    expect((await advanceOf(f, c.advanceId)).owed).toBe("40000");
  });

  it("refuses the approval as not_executable with the switch off, and writes nothing", async () => {
    const f = await carrier("trip-yes-off");
    const c = await oneCard(f);
    flags.cancelledTrip = { enabled: false, startDate: "2026-11-02" };
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: false, category: "not_executable" });
    expect(await approve(f.session, c.cardId, { confirmed: false }, { deficit_book: deficitBookExecutor })).toMatchObject({
      ok: false,
      category: "not_executable",
    });
    expect((await proposalOf(f, c.cardId)).status).toBe("proposed");
    expect(await deficitsOf(f)).toEqual([]);
    expect((await advanceOf(f, c.advanceId)).owed).toBe("40000");
  });

  it("refuses as not_executable with deficit recovery off, at the gate, the precheck and the executor, and writes nothing", async () => {
    const f = await carrier("trip-yes-norecovery");
    const c = await oneCard(f);
    flags.deficitRecovery = { enabled: false, startDate: "2026-11-02" };
    expect(await approve(f.session, c.cardId)).toMatchObject({ ok: false, category: "not_executable" });
    expect(await approve(f.session, c.cardId, { confirmed: false }, { deficit_book: deficitBookExecutor })).toMatchObject({
      ok: false,
      category: "not_executable",
    });
    const precheck = deficitBookExecutor.precheck;
    if (!precheck) throw new Error("no precheck");
    expect(
      await app.withTenant(f.tenantId, (q) =>
        precheck(q, rowFor(c, "proposed"), NOW, { session: f.session, opts: { confirmed: false } }),
      ),
    ).toEqual({ ok: false, category: "not_executable", retryable: false });
    expect(await deficitBookExecutor(app, f.session, rowFor(c, "approved"), { confirmed: false }, { db: app, clock })).toEqual({
      ok: false,
      category: "not_executable",
      retryable: false,
    });
    expect((await proposalOf(f, c.cardId)).status).toBe("proposed");
    expect(await deficitsOf(f)).toEqual([]);
    expect((await advanceOf(f, c.advanceId)).owed).toBe("40000");
  });
});
