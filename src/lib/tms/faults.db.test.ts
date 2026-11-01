import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { DEMO_FAULTS, FAULT_EDIT_CENTS, NO_FAULTS, type DemoFault } from "../adapters/tms-source/faults";
import { validated } from "../adapters/tms-source";
import { createSyntheticSource, YARD_CHECK } from "../adapters/tms-source/synthetic";
import type { TmsSource } from "../adapters/tms-source/types";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { moveFromTmsEvent } from "../loads/movement";
import { dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { readFaultSettings, saveDemoFaults } from "./demo-faults";
import { syntheticLabelMap } from "./status";
import { MAX_ATTEMPTS, pullTms } from "./sync";

// The demo dispatch feed's fault switches against a fresh database, as the app's role: the real
// synthetic feed over each carrier's own loads (no stand-in source), one carrier per test, a fixed
// clock passed to every pull and every move (never the wall clock). Each fault is switched on in
// the carrier's tms_connections.demo_faults, the only place the feed reads it, and each test shows
// the sync coping the way the mirror's design says. The carriers are America/Chicago (makeTenant);
// only this file's carriers are made, removed after.

const TABLES = ["tms_loads", "tms_stops", "tms_status_events", "tms_line_items", "tms_documents"] as const;
const savedTms = structuredClone(flags.tmsSync);
const savedMove = structuredClone(flags.loadMovement);

// Our loads pick up Sunday Nov 1, 2026 (CST from that day) and run 420 miles, so the feed's script
// (synthetic.ts scriptOf) puts them: created Oct 31 16:00 CDT, booked 17:00 CDT, picked up Nov 1
// 09:20 CST, delivered Nov 2 14:14 CST.
const PICKUP_ON = "2026-11-01";
const T_PICKED = "2026-11-01T15:20:00.000Z";
const T_DELIVERED = "2026-11-02T20:14:00.000Z";
const MIN = 60_000;
const at = (base: string, minutes: number) => new Date(Date.parse(base) + minutes * MIN);

let admin: Db;
let app: Db;
const made: Fixture[] = [];
let seq = 0;

type Carrier = Fixture & { token: string; slug: string };

async function carrier(name: string, faults: Partial<Record<DemoFault, boolean>> = {}): Promise<Carrier> {
  const slug = `${name}-${randomUUID().slice(0, 6)}`;
  const f = await makeTenant(admin, slug);
  made.push(f);
  const token = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO tms_connections (id, tenant_id, system, label_map, lookback_hours, finalize_cooloff_minutes, demo_faults)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'synthetic', CAST($2 AS jsonb), 4, 30, CAST($3 AS jsonb))`,
      [randomUUID(), JSON.stringify(syntheticLabelMap()), JSON.stringify(faults)],
    );
    await q.execute(
      `INSERT INTO desk_loops (tenant_id, lease_token, lease_until, updated_at)
       VALUES (current_tenant_id(), CAST($1 AS uuid), CAST('2026-11-30T00:00:00Z' AS timestamptz),
               CAST('2026-10-25T00:00:00Z' AS timestamptz))`,
      [token],
    );
  });
  return { ...f, token, slug };
}

const setFaults = (f: Fixture, faults: Partial<Record<DemoFault, boolean>>) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute("UPDATE tms_connections SET demo_faults = CAST($1 AS jsonb) WHERE tenant_id = current_tenant_id()", [
      JSON.stringify(faults),
    ]),
  );

type OurLoad = { id: string; number: string; externalId: string };

async function ourLoad(
  f: Carrier,
  over: { status?: string; pickupOn?: string; deliveredAt?: string; deliveredOn?: string } = {},
): Promise<OurLoad> {
  seq += 1;
  const id = randomUUID();
  const number = `FL${10000 + seq}`;
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents, delivered_at, delivered_on)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), $5, 'Joliet', 'IL',
         'Gary', 'IN', CAST($6 AS date), 420, 150000, CAST($7 AS timestamptz), CAST($8 AS date))`,
      [id, number, f.customerId, f.driverId, over.status ?? "in_transit", over.pickupOn ?? PICKUP_ON, over.deliveredAt ?? null, over.deliveredOn ?? null],
    ),
  );
  return { id, number, externalId: `syn:${f.slug}:${number}` };
}

// An invoiced load of ours: picked up Oct 26, delivered Oct 27 14:00 CDT, invoiced on `issuedOn`
// (the feed finalizes it that day at 10:00 CDT, 15:00Z, after the review 53 hours on).
async function invoicedLoad(f: Carrier, issuedOn: string): Promise<OurLoad> {
  const l = await ourLoad(f, { status: "invoiced", pickupOn: "2026-10-26", deliveredAt: "2026-10-27T19:00:00.000Z", deliveredOn: "2026-10-27" });
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO invoices (id, tenant_id, source, load_id, customer_id, invoice_number, amount_cents, issued_on, due_on, status)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'load', CAST($2 AS uuid), CAST($3 AS uuid), $4, 150000,
               CAST($5 AS date), CAST('2026-11-30' AS date), 'open')`,
      [randomUUID(), l.id, f.customerId, `INV-${l.number}`, issuedOn],
    ),
  );
  return l;
}

// A minute of time to spare by a clock that stands still at `now`, so the deadline never comes.
// With `calls`, the feed's record reads are counted by id.
const pull = (f: Carrier, now: Date, calls?: string[]) => {
  let source: TmsSource | undefined;
  if (calls) {
    const inner = validated(createSyntheticSource());
    source = {
      ...inner,
      readLoad: (ctx, id) => {
        calls.push(id);
        return inner.readLoad(ctx, id);
      },
    };
  }
  return pullTms(app, f.session, { token: f.token, now, deadlineMs: now.getTime() + MIN }, { clock: () => now.getTime(), source });
};

const ts = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type MirrorRow = {
  status_code: string;
  status_label: string;
  read_attempts: number;
  source_updated_at: string;
  gone_at: string | null;
  flags: string[];
  delivered_at: string | null;
  delivered_day: string | null;
  finalized_at: string | null;
  revenue_total_cents: number | null;
};

const mirrorOf = (f: Fixture, externalId: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<MirrorRow>(
      `SELECT status_code, status_label, CAST(read_attempts AS integer) AS read_attempts,
              ${ts("source_updated_at")} AS source_updated_at, ${ts("gone_at")} AS gone_at, flags,
              ${ts("delivered_at")} AS delivered_at, to_char(delivered_day, 'YYYY-MM-DD') AS delivered_day,
              ${ts("finalized_at")} AS finalized_at, CAST(revenue_total_cents AS integer) AS revenue_total_cents
         FROM tms_loads WHERE tenant_id = current_tenant_id() AND external_id = $1`,
      [externalId],
    );
    return row as MirrorRow | undefined;
  });

const countsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, async (q) => {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const [r] = await q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${t} WHERE tenant_id = current_tenant_id()`);
      out[t] = r.n;
    }
    return out;
  });

const eventsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ id: string; external_event_id: string; field: string; new_value: string | null; clock_flag: string | null; day: string; at: string }>(
      `SELECT CAST(id AS text) AS id, external_event_id, field, new_value, clock_flag, to_char(day, 'YYYY-MM-DD') AS day,
              ${ts("at")} AS at
         FROM tms_status_events WHERE tenant_id = current_tenant_id() ORDER BY at, external_event_id`,
    ),
  );

async function eventOf(f: Fixture, externalEventId: string) {
  const e = (await eventsOf(f)).find((x) => x.external_event_id === externalEventId);
  if (!e) throw new Error(`no event ${externalEventId}`);
  return e;
}

const fromEvent = (f: Fixture, eventId: string, now: Date) => app.withTenant(f.tenantId, (q) => moveFromTmsEvent(q, f.session, eventId, now));

const loadOf = (f: Fixture, id: string) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<{ status: string; delivered_on: string | null; delivered_at: string | null }>(
      `SELECT status, to_char(delivered_on, 'YYYY-MM-DD') AS delivered_on, ${ts("delivered_at")} AS delivered_at
         FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    );
    return row;
  });

const loadEventsOf = (f: Fixture, loadId: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ to_status: string; source: string; at: string }>(
      `SELECT to_status, source, ${ts("at")} AS at FROM load_events
        WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid) ORDER BY at`,
      [loadId],
    ),
  );

const cardsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ subject_id: string; args: Record<string, unknown> }>(
      `SELECT CAST(subject_id AS text) AS subject_id, args FROM proposals
        WHERE tenant_id = current_tenant_id() AND kind = 'load_move' ORDER BY created_at, id`,
    ),
  );

const storedFaultsOf = (f: Fixture) =>
  admin.withTenant(f.tenantId, async (q) => {
    const [row] = await q.query<{ faults: Record<string, unknown> }>(
      "SELECT demo_faults AS faults FROM tms_connections WHERE tenant_id = current_tenant_id()",
    );
    return row?.faults;
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
  Object.assign(flags.tmsSync, savedTms, { enabled: true, startDate: "2026-10-25", demoFaultsEnabled: true });
  flags.loadMovement.enabled = true;
  flags.loadMovement.startDate = "2026-10-25";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(flags.tmsSync, savedTms);
  Object.assign(flags.loadMovement, savedMove);
  vi.restoreAllMocks();
});

describe("the demo dispatch feed's faults", () => {
  it("stale_list_rows: the full read writes the truth and flags the stale row; a change the list hides is caught 30 minutes on", async () => {
    const f = await carrier("flt-stale", { stale_list_rows: true });
    const l = await ourLoad(f);
    // Ten minutes after pickup the list still says Booked; the record says In Transit.
    await pull(f, at(T_PICKED, 10));
    expect(await mirrorOf(f, l.externalId)).toMatchObject({ status_code: "in_transit", source_updated_at: T_PICKED });
    expect((await mirrorOf(f, l.externalId))?.flags).toContain("stale_list_row");
    // Six minutes after delivery the list still shows the old row and time, so the load is not read.
    await pull(f, at(T_DELIVERED, 6));
    expect(await mirrorOf(f, l.externalId)).toMatchObject({ status_code: "in_transit", source_updated_at: T_PICKED });
    // Thirty minutes on, the list's time moves and the full read writes the delivery.
    await pull(f, at(T_DELIVERED, 31));
    const row = await mirrorOf(f, l.externalId);
    expect(row).toMatchObject({ status_code: "delivered", source_updated_at: T_DELIVERED, delivered_at: T_DELIVERED });
    expect(row?.flags).not.toContain("stale_list_row");
  });

  it("hard_delete: a deleted load is tombstoned once, with one card for our running load, and never read again", async () => {
    const f = await carrier("flt-gone");
    const l = await ourLoad(f);
    const t0 = at(T_PICKED, 60);
    await pull(f, t0);
    expect(await mirrorOf(f, l.externalId)).toMatchObject({ status_code: "in_transit", gone_at: null });
    const before = await countsOf(f);
    await setFaults(f, { hard_delete: true });
    const t1 = at(T_PICKED, 61);
    expect(await pull(f, t1)).toMatchObject({ ran: true, listed: 0, gone: 1 });
    expect((await mirrorOf(f, l.externalId))?.gone_at).toBe(t1.toISOString());
    expect(await countsOf(f)).toEqual(before);
    const cards = await cardsOf(f);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ subject_id: l.id });
    expect(JSON.stringify(cards[0].args)).toContain("tms_gone");
    expect((await loadOf(f, l.id)).status).toBe("in_transit");

    const calls: string[] = [];
    await pull(f, at(T_PICKED, 62), calls);
    await pull(f, at(T_PICKED, 63), calls);
    expect(calls).toEqual([]);
    expect(await cardsOf(f)).toHaveLength(1);
  });

  it("clock_skew: two delivery clocks two days apart are flagged, and the delivery is a card, never a move", async () => {
    const f = await carrier("flt-skew", { clock_skew: true });
    const l = await ourLoad(f);
    const now = at(T_DELIVERED, 30);
    await pull(f, now);
    const row = await mirrorOf(f, l.externalId);
    expect(row?.status_code).toBe("delivered");
    expect(row?.flags).toContain("clocks_disagree");
    const e = await eventOf(f, `${l.externalId}:delivered`);
    expect(e.clock_flag).toBe("clocks_disagree");
    // The day is the local clock's, as always.
    expect(e.day).toBe("2026-11-02");
    const moved = await fromEvent(f, e.id, now);
    expect(moved).toMatchObject({ kind: "card", reason: "tms_time_unclear", loadId: l.id });
    const cards = await cardsOf(f);
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0].args)).toContain("tms_time_unclear");
    expect(await loadEventsOf(f, l.id)).toEqual([]);
    expect((await loadOf(f, l.id)).status).toBe("in_transit");
  });

  it("local_date_shift: the delivery's day follows the local clock back a day, the mirror keeps the moment, and the load moves once", async () => {
    const f = await carrier("flt-shift", { local_date_shift: true });
    const l = await ourLoad(f);
    // First seen after the hand edit (ten minutes after the delivery).
    const now = at(T_DELIVERED, 30);
    await pull(f, now);
    const row = await mirrorOf(f, l.externalId);
    expect(row).toMatchObject({ status_code: "delivered", delivered_at: T_DELIVERED, delivered_day: "2026-11-01" });
    expect(row?.flags).not.toContain("clocks_disagree");
    // The edit is the latest change the feed shows.
    expect(row?.source_updated_at).toBe(at(T_DELIVERED, 10).toISOString());
    const e = await eventOf(f, `${l.externalId}:delivered`);
    expect(e).toMatchObject({ day: "2026-11-01", at: T_DELIVERED, clock_flag: null });
    expect(await fromEvent(f, e.id, now)).toMatchObject({ kind: "moved", loadId: l.id });
    // Our load takes the local day. Its own time stays on that day, as for any delivery dated a
    // day its moment is not on: the carrier's 17:00 (CST) that day.
    const ON_DAY = "2026-11-01T23:00:00.000Z";
    expect(await loadOf(f, l.id)).toEqual({ status: "delivered", delivered_on: "2026-11-01", delivered_at: ON_DAY });
    expect(await fromEvent(f, e.id, now)).toMatchObject({ kind: "already" });
    expect(await loadEventsOf(f, l.id)).toHaveLength(1);
    expect((await loadEventsOf(f, l.id))[0]).toMatchObject({ to_status: "delivered", source: "tms" });
  });

  it("server_errors: a load whose read errs keeps its mirror, counts one attempt, and is written on the next pull", async () => {
    const f = await carrier("flt-errs");
    const loads = [await ourLoad(f), await ourLoad(f), await ourLoad(f)];
    await pull(f, at(T_PICKED, 60));
    for (const l of loads) expect((await mirrorOf(f, l.externalId))?.status_code).toBe("in_transit");
    await setFaults(f, { server_errors: true });
    // All three deliver; the third read of the pull (the lowest id, as the list runs newest
    // created first, ties by id from the highest) answers a server error.
    const r = await pull(f, at(T_DELIVERED, 30));
    expect(r).toMatchObject({ ran: true, read: 3, written: 2, failed: 1 });
    const [errd, ...fine] = loads;
    expect(await mirrorOf(f, errd.externalId)).toMatchObject({ status_code: "in_transit", read_attempts: 1, source_updated_at: T_PICKED });
    expect((await mirrorOf(f, errd.externalId))?.flags).not.toContain("read_failed");
    for (const l of fine) expect(await mirrorOf(f, l.externalId)).toMatchObject({ status_code: "delivered", read_attempts: 0 });
    // The next pull reads only the load left over, well before the rest at MAX_ATTEMPTS.
    expect(MAX_ATTEMPTS).toBe(10);
    const calls: string[] = [];
    const next = await pull(f, at(T_DELIVERED, 31), calls);
    expect(calls).toEqual([errd.externalId]);
    expect(next).toMatchObject({ ran: true, read: 1, written: 1, failed: 0 });
    expect(await mirrorOf(f, errd.externalId)).toMatchObject({ status_code: "delivered", read_attempts: 0, source_updated_at: T_DELIVERED });
  });

  it("history_page_cut: a row repeated across cut pages is one event, and a later read adds only the new one", async () => {
    const f = await carrier("flt-cut", { history_page_cut: true });
    const l = await ourLoad(f);
    await pull(f, at(T_DELIVERED, 30));
    const first = await eventsOf(f);
    expect(first.map((e) => e.external_event_id)).toEqual(
      ["tendered", "booked", "in_transit", "delivered"].map((k) => `${l.externalId}:${k}`),
    );
    // The review step, 53 hours after the delivery, makes a fifth row and a third page.
    await pull(f, at(T_DELIVERED, 53 * 60 + 5));
    const second = await eventsOf(f);
    expect(second.map((e) => e.external_event_id)).toEqual([...first.map((e) => e.external_event_id), `${l.externalId}:review`]);
    expect(second.slice(0, 4)).toEqual(first);
  });

  it("relabeled_status: a renamed status the carrier's map knows moves the load like the usual one", async () => {
    const f = await carrier("flt-label", { relabeled_status: true });
    const l = await ourLoad(f, { status: "planned" });
    const now = at(T_PICKED, 30);
    await pull(f, now);
    expect(await mirrorOf(f, l.externalId)).toMatchObject({ status_code: "in_transit", status_label: "Rolling" });
    const e = await eventOf(f, `${l.externalId}:in_transit`);
    expect(e.new_value).toBe("Rolling");
    expect(await fromEvent(f, e.id, now)).toMatchObject({ kind: "moved", loadId: l.id });
    expect((await loadOf(f, l.id)).status).toBe("in_transit");
    expect(await loadEventsOf(f, l.id)).toEqual([{ to_status: "in_transit", source: "tms", at: T_PICKED }]);
  });

  it("custom_status: the carrier's own status reads custom and moves nothing", async () => {
    const f = await carrier("flt-custom", { custom_status: true });
    const l = await ourLoad(f);
    const now = at(T_PICKED, 40);
    await pull(f, now);
    expect(await mirrorOf(f, l.externalId)).toMatchObject({ status_code: "custom", status_label: YARD_CHECK });
    const e = await eventOf(f, `${l.externalId}:yard_check`);
    expect(e.new_value).toBe(YARD_CHECK);
    expect(await fromEvent(f, e.id, now)).toEqual({ kind: "nothing", category: "recorded" });
    expect(await loadEventsOf(f, l.id)).toEqual([]);
    expect(await cardsOf(f)).toEqual([]);
    expect((await loadOf(f, l.id)).status).toBe("in_transit");
  });

  it("edit_after_finalize: a revenue edit after the recheck is flagged for a person, and our invoice stays as it was", async () => {
    const f = await carrier("flt-edit", { edit_after_finalize: true });
    // Picked up Oct 26, delivered Oct 27 14:00 CDT, invoiced Oct 30: the feed finalizes it Oct 30
    // 10:00 CDT (the invoice day's morning, after the review 53 hours on).
    const l = await ourLoad(f, { status: "invoiced", pickupOn: "2026-10-26", deliveredAt: "2026-10-27T19:00:00.000Z", deliveredOn: "2026-10-27" });
    const invoiceId = randomUUID();
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO invoices (id, tenant_id, source, load_id, customer_id, invoice_number, amount_cents, issued_on, due_on, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'load', CAST($2 AS uuid), CAST($3 AS uuid), $4, 150000,
                 CAST('2026-10-30' AS date), CAST('2026-11-29' AS date), 'open')`,
        [invoiceId, l.id, f.customerId, `INV-${l.number}`],
      ),
    );
    const FINAL = "2026-10-30T15:00:00.000Z";
    // First sight 5 minutes after the finalize: the cool-off (30 minutes) starts.
    await pull(f, at(FINAL, 5));
    expect(await mirrorOf(f, l.externalId)).toMatchObject({ status_code: "finalized", finalized_at: FINAL, revenue_total_cents: 150_000 });
    // The recheck after the cool-off finds nothing new.
    await pull(f, at(FINAL, 40));
    expect((await mirrorOf(f, l.externalId))?.flags).not.toContain("edited_after_finalize");
    // An hour after the finalize the revenue goes up; the next read flags it and keeps the edit.
    await pull(f, at(FINAL, 65));
    const row = await mirrorOf(f, l.externalId);
    expect(row?.flags).toContain("edited_after_finalize");
    expect(row).toMatchObject({ revenue_total_cents: 150_000 + FAULT_EDIT_CENTS, source_updated_at: at(FINAL, 60).toISOString() });
    const e = await eventOf(f, `${l.externalId}:revenue`);
    expect(e).toMatchObject({ field: "revenue", new_value: "1575.00" });
    expect(await fromEvent(f, e.id, at(FINAL, 65))).toEqual({ kind: "nothing", category: "recorded" });
    const ours = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ amount_cents: number; status: string }>(
        "SELECT CAST(amount_cents AS integer) AS amount_cents, status FROM invoices WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [invoiceId],
      ),
    );
    expect(ours).toEqual([{ amount_cents: 150_000, status: "open" }]);
    expect((await loadOf(f, l.id)).status).toBe("invoiced");
    // The flag stays on later reads.
    await pull(f, at(FINAL, 125));
    expect((await mirrorOf(f, l.externalId))?.flags).toContain("edited_after_finalize");
  });

  it("hard_delete: the pick follows the feed's clock, so once the deleted load has delivered the next one in transit is the deleted one, and the first load's tombstone stays", async () => {
    const f = await carrier("flt-redel");
    const first = await ourLoad(f);
    const second = await ourLoad(f, { pickupOn: "2026-11-02" });
    await pull(f, at(T_PICKED, 60));
    await setFaults(f, { hard_delete: true });
    // Only the first is in transit: it is the one deleted.
    const t1 = at(T_PICKED, 61);
    expect(await pull(f, t1)).toMatchObject({ ran: true, gone: 1 });
    expect((await mirrorOf(f, first.externalId))?.gone_at).toBe(t1.toISOString());
    // The second is not in the feed yet (it is created the evening before its pickup). Once it is,
    // it is only booked, and the first is still the one deleted.
    expect(await mirrorOf(f, second.externalId)).toBeUndefined();
    await pull(f, at(T_PICKED, 8 * 60));
    expect(await mirrorOf(f, second.externalId)).toMatchObject({ status_code: "booked", gone_at: null });
    expect((await mirrorOf(f, first.externalId))?.gone_at).toBe(t1.toISOString());
    // After the first delivers, the second is in transit and is the one deleted: the feed lists the
    // first again, but a tombstoned load is never read again, so the mirror keeps its tombstone.
    const t2 = at(T_DELIVERED, 30);
    await pull(f, t2);
    expect((await mirrorOf(f, second.externalId))?.gone_at).toBe(t2.toISOString());
    expect(await mirrorOf(f, first.externalId)).toMatchObject({ status_code: "in_transit", gone_at: t1.toISOString() });
  });

  it("edit_after_finalize: the pick follows the feed's clock, so once a later load's edit time passes the earlier load's edit is gone", async () => {
    const f = await carrier("flt-reedit", { edit_after_finalize: true });
    const early = await invoicedLoad(f, "2026-10-30");
    const late = await invoicedLoad(f, "2026-10-31");
    const FINAL_EARLY = "2026-10-30T15:00:00.000Z";
    const FINAL_LATE = "2026-10-31T15:00:00.000Z";
    await pull(f, at(FINAL_EARLY, 5));
    await pull(f, at(FINAL_EARLY, 40));
    await pull(f, at(FINAL_EARLY, 65));
    expect(await mirrorOf(f, early.externalId)).toMatchObject({ revenue_total_cents: 150_000 + FAULT_EDIT_CENTS });
    expect((await mirrorOf(f, early.externalId))?.flags).toContain("edited_after_finalize");
    // The later load's edit time (an hour after its finalize) passes: it is the edited one now.
    await pull(f, at(FINAL_LATE, 5));
    await pull(f, at(FINAL_LATE, 40));
    await pull(f, at(FINAL_LATE, 65));
    expect(await mirrorOf(f, late.externalId)).toMatchObject({ revenue_total_cents: 150_000 + FAULT_EDIT_CENTS });
    expect((await mirrorOf(f, late.externalId))?.flags).toContain("edited_after_finalize");
    // The feed no longer shows the earlier load's edit, but the sync reads a finalized load again
    // only once, after its cool-off, so the mirror keeps the edit it flagged.
    expect(await mirrorOf(f, early.externalId)).toMatchObject({ revenue_total_cents: 150_000 + FAULT_EDIT_CENTS });
    expect((await mirrorOf(f, early.externalId))?.flags).toContain("edited_after_finalize");
  });

  it("serves the clean feed while the switch is off, whatever the carrier has stored", async () => {
    flags.tmsSync.demoFaultsEnabled = false;
    const f = await carrier("flt-off", Object.fromEntries(DEMO_FAULTS.map((k) => [k, true])));
    const l = await ourLoad(f);
    await pull(f, at(T_PICKED, 10));
    const row = await mirrorOf(f, l.externalId);
    expect(row).toMatchObject({ status_code: "in_transit", status_label: "In Transit", gone_at: null, read_attempts: 0, source_updated_at: T_PICKED });
    expect(row?.flags).not.toContain("stale_list_row");
    expect(Object.values(await storedFaultsOf(f) ?? {})).toEqual(DEMO_FAULTS.map(() => true));
    expect((await eventsOf(f)).map((e) => e.external_event_id)).toEqual(
      ["tendered", "booked", "in_transit"].map((k) => `${l.externalId}:${k}`),
    );
  });
});

describe("the fault switches store", () => {
  it("writes the caller's own carrier only, merging the change into all nine switches", async () => {
    const a = await carrier("flt-sa");
    const b = await carrier("flt-sb", { clock_skew: true });
    const out = await app.withTenant(a.tenantId, (q) => saveDemoFaults(q, { hard_delete: true }));
    expect(out).toEqual({ kind: "ok", faults: { ...NO_FAULTS, hard_delete: true }, feed: "synthetic" });
    const again = await app.withTenant(a.tenantId, (q) => saveDemoFaults(q, { clock_skew: true, hard_delete: false }));
    expect(again).toEqual({ kind: "ok", faults: { ...NO_FAULTS, clock_skew: true }, feed: "synthetic" });
    expect(await storedFaultsOf(a)).toEqual({ ...NO_FAULTS, clock_skew: true });
    expect(await storedFaultsOf(b)).toEqual({ clock_skew: true });
    expect(await app.withTenant(a.tenantId, (q) => readFaultSettings(q))).toEqual({ kind: "ok", faults: { ...NO_FAULTS, clock_skew: true }, feed: "synthetic" });
    expect(await app.withTenant(b.tenantId, (q) => readFaultSettings(q))).toEqual({ kind: "ok", faults: { ...NO_FAULTS, clock_skew: true }, feed: "synthetic" });
  });

  it("reads and writes nothing while the switch is off, and nothing for a carrier without the demo feed", async () => {
    const a = await carrier("flt-soff");
    flags.tmsSync.demoFaultsEnabled = false;
    expect(await app.withTenant(a.tenantId, (q) => saveDemoFaults(q, { hard_delete: true }))).toEqual({ kind: "switched_off" });
    expect(await app.withTenant(a.tenantId, (q) => readFaultSettings(q))).toEqual({ kind: "switched_off" });
    expect(await storedFaultsOf(a)).toEqual({});
    flags.tmsSync.demoFaultsEnabled = true;
    const none = await makeTenant(admin, `flt-none-${randomUUID().slice(0, 6)}`);
    made.push(none);
    expect(await app.withTenant(none.tenantId, (q) => saveDemoFaults(q, { hard_delete: true }))).toEqual({ kind: "not_synthetic" });
    expect(await app.withTenant(none.tenantId, (q) => readFaultSettings(q))).toEqual({ kind: "not_synthetic" });
  });
});
