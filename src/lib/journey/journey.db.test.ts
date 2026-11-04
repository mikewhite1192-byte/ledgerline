import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { BOARD_CANDIDATES, BOARD_LIMIT, readBoardLoadIds, readJourneys } from "./read";
import { boardPick, boardRowOf, journeyStepsOf, onTheRoad, sortBoard } from "./steps";

// The journey reads against a real database, as the app's role: one carrier seeded with the demo
// plan under its own slug, every one of its loads read back in one pass (one statement per table),
// the paystub that cites a load found by its line, and another carrier's wall held. Only reads
// run here, at a fixed instant, so nothing depends on the wall clock. Both tenants are removed
// after, by cascade.

const ANCHOR = golden.anchor;
const NOW = new Date(`${ANCHOR}T18:00:00.000Z`);
const CARRIER = { ...DEMO_CARRIERS[0], slug: "journey-read-test", name: "Journey Read Test" } as unknown as DemoCarrier;
const plan = buildCarrierPlan(CARRIER, ANCHOR);
const T = randomUUID();
const OTHER = randomUUID();
const OPTS = { zone: CARRIER.timezone, books: { enabled: true, startDate: ANCHOR, maxAttempts: 5 } };

let admin: Db;
let app: Db;

const rows = plan.rows;
// A load the plan pays: a paid paystub's line cites it.
const paidStub = rows.settlements.find(
  (s) => s.status === "paid" && rows.settlement_lines.some((l) => l.settlement_id === s.id && l.sources.some((x) => x.table === "loads")),
);
const paidLoadId = rows.settlement_lines.find(
  (l) => l.settlement_id === paidStub?.id && l.sources.some((x) => x.table === "loads"),
)?.sources.find((x) => x.table === "loads")?.id;

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  for (const [id, slug, name] of [
    [T, CARRIER.slug, CARRIER.name],
    [OTHER, `journey-other-${OTHER.slice(0, 8)}`, "Journey Other Test"],
  ] as const) {
    await admin.withTenant(id, (q) =>
      q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
        slug,
        name,
        CARRIER.timezone,
      ]),
    );
  }
  await replaceTenantData(admin, T, plan);
});

afterAll(async () => {
  if (admin) {
    for (const id of [T, OTHER]) {
      await admin.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
  }
  await app?.close();
  await admin?.close();
});

describe("readJourneys", () => {
  it("reads every seeded load back in one pass, each with its own moves", async () => {
    const ids = rows.loads.map((l) => l.id);
    const facts = await app.withTenant(T, (q) => readJourneys(q, [...ids, randomUUID(), "not-a-uuid"], NOW));
    expect(facts.size).toBe(ids.length);
    for (const load of rows.loads) {
      const f = facts.get(load.id);
      expect(f?.load).toMatchObject({ id: load.id, number: load.load_number, status: load.status, driverId: load.driver_id });
      const moves = rows.load_events.filter((e) => e.load_id === load.id && e.to_status !== "cancelled");
      expect(f?.moves.map((m) => m.id).sort()).toEqual(moves.map((e) => e.id).sort());
      // Eight steps for every load, whatever its stage, and none of them throws.
      expect(journeyStepsOf(f!, OPTS)).toHaveLength(8);
    }
  });

  it("finds the paid paystub that cites a load, with its stored lines and totals", async () => {
    expect(paidStub, "the plan has a paid paystub citing a load").toBeDefined();
    const facts = await app.withTenant(T, (q) => readJourneys(q, [paidLoadId!], NOW));
    const s = facts.get(paidLoadId!)?.settlement;
    expect(s).toMatchObject({ id: paidStub!.id, status: "paid", netCents: paidStub!.net_cents, grossCents: paidStub!.gross_cents });
    const lines = rows.settlement_lines.filter((l) => l.settlement_id === paidStub!.id).sort((a, b) => a.seq - b.seq);
    expect(s?.lines.map((l) => [l.seq, l.amountCents])).toEqual(lines.map((l) => [l.seq, l.amount_cents]));
    const steps = journeyStepsOf(facts.get(paidLoadId!)!, OPTS);
    const stub = steps.find((x) => x.key === "paystub_drafted");
    expect(stub?.state).toBe("done");
    expect(stub?.paystub?.netCents).toBe(paidStub!.net_cents);
    expect(stub?.paystub?.lines.some((l) => l.thisLoad)).toBe(true);
    expect(steps.find((x) => x.key === "paystub_paid")?.state).toBe("done");
  });

  it("reads the bill of lading behind a driver's photo, as Muse Spark read it and code matched it", async () => {
    // The seed's moves come from the dispatch board, with no photo behind them: one photo move is
    // added here, with the stored read and match behind it, and removed after.
    const load = rows.loads.find((l) => l.status === "in_transit");
    expect(load, "the plan has a load on its way").toBeDefined();
    const [doc, move] = [randomUUID(), randomUUID()];
    const at = `${ANCHOR}T15:05:00.000Z`;
    const confidence = Object.fromEntries(
      ["document_kind", "vendor", "date_mmddyyyy", "total_cents", "load_number", "truck_unit", "gallons_milli", "price_cents",
        "loaded_miles", "rate_per_mile_cents", "linehaul_cents", "fuel_surcharge_cents", "customer_name", "stops"].map((k) => [k, "high"]),
    );
    const reading = {
      document_kind: "bill_of_lading", sample_word: false, vendor: null, date_mmddyyyy: "11/02/2026", total_cents: null,
      load_number: load!.load_number, truck_unit: null, gallons_milli: null, price_cents: null, loaded_miles: null,
      rate_per_mile_cents: null, linehaul_cents: null, fuel_surcharge_cents: null, customer_name: null, stops: [],
      text_lines: [], confidence,
    };
    const match = {
      found: true, table: "loads", id: load!.id, humanRef: load!.load_number, loadId: load!.id, driverId: load!.driver_id,
      fields: [{ name: "load_number", claim: load!.load_number, record: load!.load_number, status: "same" }], notes: [], supports: null,
    };
    await admin.withTenant(T, async (q) => {
      await q.execute(
        `INSERT INTO documents (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash, trace_id,
           read_status, document_kind, reading, match, created_at, updated_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'ops', 'bol.pdf', 'application/pdf', 1, decode('00', 'hex'), $2,
           CAST($3 AS uuid), 'read', 'bill_of_lading', CAST($4 AS jsonb), CAST($5 AS jsonb), CAST($6 AS timestamptz),
           CAST($6 AS timestamptz))`,
        [doc, createHash("sha256").update(doc).digest("hex"), randomUUID(), JSON.stringify(reading), JSON.stringify(match), at],
      );
      await q.execute(
        `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, source, evidence_table, evidence_id, at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'planned', 'in_transit', 'driver_photo',
           'documents', CAST($3 AS uuid), CAST($4 AS timestamptz))`,
        [move, load!.id, doc, at],
      );
      await q.execute(
        `INSERT INTO desk_log (id, tenant_id, wake_id, at, kind, event_key, source, by, detail)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS timestamptz), 'done', $4, 'load_event',
           'schedule', CAST($5 AS jsonb))`,
        [randomUUID(), randomUUID(), at, `load_event:${move}`, JSON.stringify({ found: 0, category: "daily_cap" })],
      );
    });
    try {
      const f = (await app.withTenant(T, (q) => readJourneys(q, [load!.id], NOW))).get(load!.id)!;
      const m = f.moves.find((x) => x.id === move);
      expect(m).toMatchObject({ toStatus: "in_transit", source: "driver_photo", desk: { kind: "done", category: "daily_cap" } });
      expect(m?.document).toMatchObject({ id: doc, kind: "bill_of_lading", readStatus: "read", match: { found: true, loadId: load!.id } });
      expect(m?.document?.read?.fields.loadNumber).toBe(load!.load_number);
      expect(journeyStepsOf(f, OPTS)).toHaveLength(8);
    } finally {
      // The desk line is never removed on its own: it goes with the carrier, after.
      await admin.withTenant(T, async (q) => {
        await q.execute("DELETE FROM load_events WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [move]);
        await q.execute("DELETE FROM documents WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [doc]);
      });
    }
  });

  it("never reads another carrier's loads", async () => {
    const facts = await app.withTenant(OTHER, (q) => readJourneys(q, rows.loads.map((l) => l.id), NOW));
    expect(facts.size).toBe(0);
  });
});

describe("readBoardLoadIds", () => {
  it("names the loads with a driver still on the road, and the board keeps only those not yet paid and recorded", async () => {
    const { ids, more } = await app.withTenant(T, (q) => readBoardLoadIds(q, NOW, CARRIER.timezone));
    // At most the candidate cap, and more reported only when it bites.
    expect(ids.length).toBeLessThanOrEqual(BOARD_CANDIDATES);
    if (more) expect(ids).toHaveLength(BOARD_CANDIDATES);
    const byId = new Map(rows.loads.map((l) => [l.id, l]));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const l = byId.get(id);
      expect(l, "every id is this carrier's load").toBeDefined();
      expect(l!.status === "in_transit" || l!.status === "delivered" || l!.status === "invoiced" || (l!.status === "planned" && l!.driver_id !== null)).toBe(true);
    }
    // Loads on the way come first, then delivered, then planned.
    const rank = (id: string) => ({ in_transit: 0, delivered: 1, invoiced: 1 })[byId.get(id)!.status as string] ?? 2;
    expect(ids.map(rank)).toEqual(ids.map(rank).sort((a, b) => a - b));
    const onWay = rows.loads.filter((l) => l.status === "in_transit").map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(onWay));
    expect(await app.withTenant(OTHER, (q) => readBoardLoadIds(q, NOW, CARRIER.timezone))).toEqual({ ids: [], more: false });

    // As the board page builds it: candidates in their read order, the finished ones out, then the cap.
    const facts = await app.withTenant(T, (q) => readJourneys(q, ids, NOW));
    const journeys = ids.map((id) => ({ facts: facts.get(id)!, steps: journeyStepsOf(facts.get(id)!, OPTS) }));
    const { shown, capped } = boardPick(journeys, more, BOARD_LIMIT);
    const stillOut = journeys.filter((j) => onTheRoad(j.facts, j.steps));
    expect(shown).toEqual(stillOut.slice(0, BOARD_LIMIT));
    expect(capped).toBe(stillOut.length > BOARD_LIMIT || more);
    // A finished load never takes a place on the board.
    expect(shown.every((j) => onTheRoad(j.facts, j.steps))).toBe(true);
    const board = sortBoard(shown.map((j) => boardRowOf(j.facts, j.steps, { zone: CARRIER.timezone, now: NOW.getTime() })));
    expect(board.map((r) => r.loadId)).toEqual(expect.arrayContaining(onWay));
    expect(board.every((r) => r.steps.length === 8 && r.where.length > 0)).toBe(true);
  });
});
