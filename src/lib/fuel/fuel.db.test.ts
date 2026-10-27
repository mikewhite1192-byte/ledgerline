import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { runChecks } from "../agent/gateway/tools/read/run-checks";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import { AiError, type AiResult } from "../ai/types";
import type { Session } from "../auth/claims";
import { checkInputOf } from "../data/records";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param, Queryable, TenantDb } from "../db/types";
import { mmddyyyyOf } from "../documents/match";
import { sqlStateOf } from "../money/test-db";
import { persistEngineProposal } from "../proposals/engine";
import { executeProposal } from "../proposals/execute";
import { rejectProposal } from "../proposals/reject";
import { runFuelChecks, type FuelCheckName, type FuelFinding } from "../rules-engine/fuel";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../seed/run";
import { COMPARE_PURPOSE, type CompareComplete } from "./compare";
import { dismissFuelFinding, proposeFuelCorrection } from "./propose";
import { runFuelCheck, type FuelRunDeps } from "./run";
import { readFuelPage } from "./view";

// The fuel checks against the real database, as the app's role: the run, the findings it keeps,
// the propose and dismiss actions, the receipt compare's bounds and the tables' guards. Only the
// model call is a stand-in (it writes the ledger row a real call would). One tenant, seeded with
// the demo plan under its own slug, removed after; every test starts with no runs, findings,
// documents or proposals.

const ANCHOR = "2026-11-02";
const NOW = new Date("2026-11-02T16:00:00.000Z");
const clock = () => NOW;
const CARRIER = { ...DEMO_CARRIERS[0], slug: "fuel-check-test", name: "Fuel Check Test" } as unknown as DemoCarrier;
const plan = buildCarrierPlan(CARRIER, ANCHOR);
const T = randomUUID();
const SESSION: Session = { sub: `sub-${T}`, email: "ops@fuel-check-test.example", tenantId: T };
// The plan's random stream follows the slug, so this tenant's four plants fall on other days of the
// same open week (Oct 26 to Nov 1) than the demo carrier's; the window starts on its first day.
const LIMITS = {
  from: "2026-10-26",
  duplicateWindowMinutes: 60,
  chargebackMaxCents: 50_000,
  compareMaxCostCents: 5,
  compareMaxOutputTokens: 200,
  comparesPerRun: 10,
  comparesPerTenantPerDay: 20,
};
const saved = { ...flags, fuelAnomalyLimits: { ...flags.fuelAnomalyLimits } };
const FUEL_CHECKS = new Set(["fuel_off_route", "fuel_over_tank", "fuel_while_parked", "fuel_duplicate"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// What the engine finds in the plan, one per check (the four planted problems).
const input = checkInputOf(plan.rows);
const expected = runFuelChecks(input, LIMITS);
const CHECKED = input.fuelPurchases.filter((p) => p.purchasedOn >= LIMITS.from).length;
function planted(check: FuelCheckName): FuelFinding {
  const f = expected.find((x) => x.check === check);
  if (!f) throw new Error(`the plan has no ${check}`);
  return f;
}

const SAMPLES = path.join(process.cwd(), "public", "samples", "docs");
const PHOTO_A = new Uint8Array(readFileSync(path.join(SAMPLES, "br-fuel-465.webp")));
const PHOTO_B = new Uint8Array(readFileSync(path.join(SAMPLES, "br-fuel-465-again.webp")));

let admin: Db;
let app: Db;

type FindingRow = {
  id: string;
  finding_key: string;
  check_name: FuelCheckName;
  status: string;
  proposal_id: string | null;
  dismiss_category: string | null;
  first_run_id: string;
  last_run_id: string;
  suggested_cents: string | null;
  no_suggestion: string | null;
  compare_verdict: string | null;
  compare_confidence: string | null;
  compare_category: string | null;
  compare_call_id: string | null;
  compare_document_ids: string;
};

async function findings(): Promise<FindingRow[]> {
  return admin.withTenant(T, (q) =>
    q.query<FindingRow>(
      `SELECT CAST(id AS text) AS id, finding_key, check_name, status, CAST(proposal_id AS text) AS proposal_id,
              dismiss_category, CAST(first_run_id AS text) AS first_run_id, CAST(last_run_id AS text) AS last_run_id,
              CAST(suggested_cents AS text) AS suggested_cents, no_suggestion, compare_verdict, compare_confidence,
              compare_category, CAST(compare_call_id AS text) AS compare_call_id,
              CAST(compare_document_ids AS text) AS compare_document_ids
         FROM fuel_findings WHERE tenant_id = current_tenant_id() ORDER BY finding_key`,
    ),
  );
}

async function finding(check: FuelCheckName): Promise<FindingRow> {
  const row = (await findings()).find((r) => r.check_name === check);
  if (!row) throw new Error(`no ${check} finding`);
  return row;
}

type RunRow = {
  id: string;
  status: string;
  fail_category: string | null;
  checked_count: number;
  found_count: number;
  compare_count: number;
  spent_cents: number;
};

async function runs(): Promise<RunRow[]> {
  return admin.withTenant(T, (q) =>
    q.query<RunRow>(
      `SELECT CAST(id AS text) AS id, status, fail_category, checked_count, found_count, compare_count, spent_cents
         FROM fuel_check_runs WHERE tenant_id = current_tenant_id() ORDER BY started_at, id`,
    ),
  );
}

async function proposalRow(id: string) {
  const rows = await admin.withTenant(T, (q) =>
    q.query<{ kind: string; origin: string; status: string; subject_id: string; args: string }>(
      `SELECT kind, origin, status, CAST(subject_id AS text) AS subject_id, CAST(args AS text) AS args
         FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    ),
  );
  return rows[0];
}

// The model call stand-in: never expected unless a test says so.
const complete = vi.fn<CompareComplete>(async () => {
  throw new Error("no model call was expected");
});

// A call the ledger holds, as the wrapper writes it, inside the carrier's day.
async function ledgerCall(createdAt: Date, costNanocents: number): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(T, (q) =>
    q.execute(
      `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, trace_id, status,
         reserved_nanocents, cost_nanocents, created_at, settled_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'spark', 'meta', 'test-model', 'text', $2,
         CAST($3 AS uuid), 'ok', $4, $4, CAST($5 AS timestamptz), CAST($5 AS timestamptz))`,
      [id, COMPARE_PURPOSE, randomUUID(), costNanocents, createdAt.toISOString()],
    ),
  );
  return id;
}

const COST = Math.round(1.5 * NANOCENTS_PER_CENT);
function answer(text: string): CompareComplete {
  return async () => {
    const callId = await ledgerCall(NOW, COST);
    const result: AiResult = {
      callId,
      status: "ok",
      text,
      toolCalls: [],
      usage: { input: 900, cached: 0, output: 20, reasoning: 0 },
      costNanocents: COST,
      upstreamId: null,
      replay: [],
      toolSearches: 0,
    };
    return result;
  };
}
const SAME = JSON.stringify({ same_receipt: true, confidence: "high", differs_in: [] });

const run = (over: FuelRunDeps = {}) => runFuelCheck(SESSION, { db: app, clock, complete, ...over });
const actions = () => ({ db: app, clock });

// The two receipt photos of the duplicate, read as the reader would have read them.
async function filePhotos(): Promise<string[]> {
  const dup = planted("fuel_duplicate");
  const [driver] = await admin.withTenant(T, (q) =>
    q.query<{ truck_unit: string }>("SELECT truck_unit FROM drivers WHERE id = CAST($1 AS uuid)", [dup.driverId]),
  );
  const reading = {
    total_cents: dup.amountCents,
    gallons_milli: dup.gallonsMilli,
    date_mmddyyyy: mmddyyyyOf(dup.purchasedOn),
    truck_unit: driver.truck_unit,
  };
  const ids: string[] = [];
  for (const [i, bytes] of [PHOTO_A, PHOTO_B].entries()) {
    const id = randomUUID();
    ids.push(id);
    await admin.withTenant(T, (q) =>
      q.execute(
        `INSERT INTO documents (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash,
           read_status, document_kind, reading, trace_id, created_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'fuel-test', $2, 'image/webp', $3, decode($4, 'base64'), $5, 'read',
           'fuel_receipt', CAST($6 AS jsonb), CAST($7 AS uuid), CAST($8 AS timestamptz))`,
        [
          id,
          `receipt-${i + 1}.webp`,
          bytes.byteLength,
          Buffer.from(bytes).toString("base64"),
          createHash("sha256").update(bytes).digest("hex"),
          JSON.stringify(reading),
          randomUUID(),
          new Date(NOW.getTime() - (2 - i) * 60_000).toISOString(),
        ],
      ),
    );
  }
  return ids;
}

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  await admin.withTenant(T, (q) =>
    q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
      CARRIER.slug,
      CARRIER.name,
      CARRIER.timezone,
    ]),
  );
  await replaceTenantData(admin, T, plan);
  await admin.withTenant(T, (q) =>
    q.execute(
      "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')",
      [SESSION.sub, SESSION.email],
    ),
  );
});

beforeEach(async () => {
  flags.fuelAnomalyEnabled = true;
  flags.fuelAnomalyLimits = { ...LIMITS };
  vi.spyOn(console, "error").mockImplementation(() => {});
  complete.mockClear();
  complete.mockImplementation(async () => {
    throw new Error("no model call was expected");
  });
  await clearTenantAgent(admin, T);
  await admin.withTenant(T, (q) =>
    q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id() AND purpose = $1", [COMPARE_PURPOSE]),
  );
});

afterEach(() => {
  Object.assign(flags, saved, { fuelAnomalyLimits: { ...saved.fuelAnomalyLimits } });
  vi.restoreAllMocks();
});

afterAll(async () => {
  Object.assign(flags, saved);
  if (admin) {
    await clearTenantAgent(admin, T).catch(() => undefined);
    await admin.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
  }
  await app?.close();
  await admin?.close();
});

describe("the plan", () => {
  it("plants one problem for each fuel check inside the window", () => {
    expect(expected.map((f) => f.check).sort()).toEqual([
      "fuel_duplicate",
      "fuel_off_route",
      "fuel_over_tank",
      "fuel_while_parked",
    ]);
    expect(CHECKED).toBeGreaterThan(0);
  });
});

describe("runFuelCheck", () => {
  it("keeps the four planted problems, and a rerun updates the same rows in place", async () => {
    const first = await run();
    expect(first).toEqual({ ok: true, runId: expect.any(String), checked: CHECKED, needYou: 4 });
    if (!first.ok) throw new Error("the run failed");
    const rows = await findings();
    expect(rows.map((r) => r.finding_key)).toEqual(expected.map((f) => f.findingKey).sort());
    for (const r of rows) {
      const f = expected.find((x) => x.findingKey === r.finding_key)!;
      expect(r).toMatchObject({ status: "open", first_run_id: first.runId, last_run_id: first.runId });
      expect(r.suggested_cents).toBe(f.suggestedCents === null ? null : String(f.suggestedCents));
      expect(r.no_suggestion).toBe(f.noSuggestion);
    }
    expect(await finding("fuel_over_tank")).toMatchObject({ suggested_cents: null, no_suggestion: "over_tank" });
    // No photos are on file, so the duplicate waits for them; nothing was called.
    expect(await finding("fuel_duplicate")).toMatchObject({ compare_verdict: "unknown", compare_category: "no_photos" });
    expect(complete).not.toHaveBeenCalled();
    expect(await runs()).toEqual([
      expect.objectContaining({ id: first.runId, status: "done", checked_count: CHECKED, found_count: 4, compare_count: 0, spent_cents: 0 }),
    ]);

    const second = await run();
    if (!second.ok) throw new Error("the rerun failed");
    const again = await findings();
    expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    for (const r of again) expect(r).toMatchObject({ status: "open", first_run_id: first.runId, last_run_id: second.runId });
    expect((await runs()).map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("clears what the engine no longer finds, opens it again when found, and never undoes a dismissal", async () => {
    await run();
    const tank = await finding("fuel_over_tank");
    expect(await dismissFuelFinding(SESSION, tank.id, "pump_error", actions())).toEqual({ ok: true });

    // Start the window on the latest planted day: what is older is no longer found.
    const cut = expected.map((f) => f.purchasedOn).sort().at(-1)!;
    const want = Object.fromEntries(
      expected.map((f) => [f.check, f.check === "fuel_over_tank" ? "dismissed" : f.purchasedOn >= cut ? "open" : "cleared"]),
    );
    const stillOpen = Object.values(want).filter((v) => v === "open").length;
    expect(Object.values(want)).toContain("cleared");
    expect(stillOpen).toBeGreaterThan(0);
    flags.fuelAnomalyLimits = { ...LIMITS, from: cut };
    expect(await run()).toMatchObject({ ok: true, needYou: stillOpen });
    const narrowed = Object.fromEntries((await findings()).map((r) => [r.check_name, r.status]));
    expect(narrowed).toEqual(want);

    flags.fuelAnomalyLimits = { ...LIMITS };
    expect(await run()).toMatchObject({ ok: true, needYou: 3 });
    const back = Object.fromEntries((await findings()).map((r) => [r.check_name, r.status]));
    expect(back).toEqual({
      fuel_off_route: "open",
      fuel_duplicate: "open",
      fuel_over_tank: "dismissed",
      fuel_while_parked: "open",
    });
    expect((await finding("fuel_over_tank")).dismiss_category).toBe("pump_error");
  });

  it("writes nothing but a failed run row when a read fails", async () => {
    const failing: TenantDb = {
      withTenant: (tenantId, fn) =>
        app.withTenant(tenantId, (q) => {
          const wrapped: Queryable = {
            query: (sql, params) => {
              if (/\bFROM fuel_purchases\b/.test(sql)) throw new Error("connection reset");
              return q.query(sql, params);
            },
            execute: (sql, params) => q.execute(sql, params),
          };
          return fn(wrapped);
        }),
    };
    expect(await run({ db: failing })).toEqual({ ok: false, category: "failed" });
    expect(await findings()).toEqual([]);
    expect(await runs()).toEqual([expect.objectContaining({ status: "failed", fail_category: "unavailable", found_count: 0 })]);
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).not.toContain("connection reset");
  });

  it("answers busy while another run is going, and gives up a run left running too long", async () => {
    const recent = randomUUID();
    await admin.withTenant(T, (q) =>
      q.execute(
        `INSERT INTO fuel_check_runs (id, tenant_id, as_of, started_by, started_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-11-02' AS date), 'other-person', CAST($2 AS timestamptz))`,
        [recent, new Date(NOW.getTime() - 60_000).toISOString()],
      ),
    );
    expect(await run()).toEqual({ ok: false, category: "busy" });
    expect(await findings()).toEqual([]);
    expect(await runs()).toEqual([expect.objectContaining({ id: recent, status: "running" })]);

    await admin.withTenant(T, (q) => q.execute("DELETE FROM fuel_check_runs WHERE id = CAST($1 AS uuid)", [recent]));
    const stale = randomUUID();
    await admin.withTenant(T, (q) =>
      q.execute(
        `INSERT INTO fuel_check_runs (id, tenant_id, as_of, started_by, started_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-11-02' AS date), 'other-person', CAST($2 AS timestamptz))`,
        [stale, new Date(NOW.getTime() - 11 * 60_000).toISOString()],
      ),
    );
    expect(await run()).toMatchObject({ ok: true, needYou: 4 });
    expect((await runs()).find((r) => r.id === stale)).toMatchObject({ status: "failed", fail_category: "abandoned" });
  });

  it("does nothing with the switch off", async () => {
    flags.fuelAnomalyEnabled = false;
    expect(await run()).toEqual({ ok: false, category: "disabled" });
    expect(await runs()).toEqual([]);
    expect(await proposeFuelCorrection(SESSION, randomUUID(), actions())).toEqual({ ok: false, category: "disabled" });
    expect(await dismissFuelFinding(SESSION, randomUUID(), "other", actions())).toEqual({ ok: false, category: "disabled" });
  });

  it("refuses a limit that does not read as one", async () => {
    flags.fuelAnomalyLimits = { ...LIMITS, from: "next week" };
    expect(await run()).toEqual({ ok: false, category: "not_configured" });
    expect(await runs()).toEqual([]);
  });
});

describe("proposeFuelCorrection", () => {
  it("drafts the engine's correction once and answers a repeat with the same card", async () => {
    await run();
    const off = await finding("fuel_off_route");
    const first = await proposeFuelCorrection(SESSION, off.id, actions());
    expect(first).toEqual({ ok: true, proposalId: expect.any(String), existing: false });
    if (!first.ok) throw new Error("not proposed");
    expect(await proposeFuelCorrection(SESSION, off.id, actions())).toEqual({
      ok: true,
      proposalId: first.proposalId,
      existing: true,
    });
    const card = await proposalRow(first.proposalId);
    const want = planted("fuel_off_route");
    expect(card).toMatchObject({ kind: "pay_correction", origin: "engine", status: "proposed", subject_id: want.driverId });
    const args = JSON.parse(card.args) as Record<string, unknown>;
    expect(args).toMatchObject({ driverId: want.driverId, deltaCents: want.suggestedCents, findingId: off.id });
    expect(want.suggestedCents).toBe(-want.amountCents);
    expect(args.payItemId).toBeUndefined();
    expect(await finding("fuel_off_route")).toMatchObject({ status: "proposed", proposal_id: first.proposalId });

    // The duplicate takes back the second pay line; over the tank suggests nothing.
    const dup = await finding("fuel_duplicate");
    const dupCard = await proposeFuelCorrection(SESSION, dup.id, actions());
    if (!dupCard.ok) throw new Error("duplicate not proposed");
    const dupArgs = JSON.parse((await proposalRow(dupCard.proposalId)).args) as Record<string, unknown>;
    expect(dupArgs).toMatchObject({ payItemId: planted("fuel_duplicate").payItemId, deltaCents: planted("fuel_duplicate").suggestedCents });
    const tank = await finding("fuel_over_tank");
    expect(await proposeFuelCorrection(SESSION, tank.id, actions())).toEqual({ ok: false, category: "no_suggestion" });

    // A rerun leaves the cards' findings where they are.
    await run();
    expect((await finding("fuel_off_route")).status).toBe("proposed");
    expect((await finding("fuel_duplicate")).status).toBe("proposed");
  });

  it("lets a rejected card's finding come back, and does not draft the same correction again", async () => {
    await run();
    const off = await finding("fuel_off_route");
    const card = await proposeFuelCorrection(SESSION, off.id, actions());
    if (!card.ok) throw new Error("not proposed");
    expect(await rejectProposal(SESSION, card.proposalId, "not_needed", actions())).toEqual({ ok: true });
    await run();
    expect(await finding("fuel_off_route")).toMatchObject({ status: "open", proposal_id: null });
    expect(await proposeFuelCorrection(SESSION, off.id, actions())).toEqual({ ok: false, category: "already_decided" });
    expect((await finding("fuel_off_route")).status).toBe("open");
  });

  it("leaves another waiting correction for the driver alone", async () => {
    await run();
    const want = planted("fuel_off_route");
    await app.withTenant(T, (q) =>
      persistEngineProposal(
        q,
        {
          kind: "pay_correction",
          subjectTable: "drivers",
          subjectId: want.driverId,
          amountCents: -100,
          args: { driverId: want.driverId, periodId: randomUUID(), deltaCents: -100, reasonCategories: ["other"] },
          exceptions: [],
          reasons: ["other"],
          sources: [{ table: "drivers", id: want.driverId }],
        },
        SESSION,
        NOW,
      ),
    );
    const off = await finding("fuel_off_route");
    expect(await proposeFuelCorrection(SESSION, off.id, actions())).toEqual({ ok: false, category: "live_exists" });
    expect(await finding("fuel_off_route")).toMatchObject({ status: "open", proposal_id: null });
  });

  it("answers changed when the records moved since the check, and not_found for no finding", async () => {
    await run();
    const off = await finding("fuel_off_route");
    // Every plant is in the open week, which ends the day before the anchor.
    flags.fuelAnomalyLimits = { ...LIMITS, from: ANCHOR };
    expect(await proposeFuelCorrection(SESSION, off.id, actions())).toEqual({ ok: false, category: "changed" });
    flags.fuelAnomalyLimits = { ...LIMITS };
    expect(await proposeFuelCorrection(SESSION, randomUUID(), actions())).toEqual({ ok: false, category: "not_found" });
    expect(await proposeFuelCorrection(SESSION, "not-an-id", actions())).toEqual({ ok: false, category: "bad_request" });
  });

  it("is carried out by the pay correction path once approved", async () => {
    flags.payCorrectionsEnabled = true;
    await run();
    const off = await finding("fuel_off_route");
    const card = await proposeFuelCorrection(SESSION, off.id, actions());
    if (!card.ok) throw new Error("not proposed");
    await admin.withTenant(T, (q) =>
      q.execute(
        `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_checked_at = CAST($2 AS timestamptz)
          WHERE id = CAST($1 AS uuid)`,
        [card.proposalId, NOW.toISOString()],
      ),
    );
    const done = await executeProposal(SESSION, card.proposalId, { confirmed: false }, actions());
    expect(done).toMatchObject({ ok: true });
    const want = planted("fuel_off_route");
    const lines = await admin.withTenant(T, (q) =>
      q.query<{ amount_cents: string; driver_id: string }>(
        `SELECT CAST(amount_cents AS text) AS amount_cents, CAST(driver_id AS text) AS driver_id FROM pay_items
          WHERE tenant_id = current_tenant_id() AND item_ref LIKE $1`,
        [`%${card.proposalId}%`],
      ),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].driver_id).toBe(want.driverId);
    expect(Math.abs(Number(lines[0].amount_cents))).toBe(want.amountCents);
  });
});

describe("dismissFuelFinding", () => {
  it("records the reason once, answers a repeat the same, and refuses a different one", async () => {
    await run();
    const parked = await finding("fuel_while_parked");
    expect(await dismissFuelFinding(SESSION, parked.id, "driver_explained", actions())).toEqual({ ok: true });
    expect(await dismissFuelFinding(SESSION, parked.id, "driver_explained", actions())).toEqual({ ok: true });
    expect(await dismissFuelFinding(SESSION, parked.id, "other", actions())).toEqual({ ok: false, category: "changed" });
    expect(await finding("fuel_while_parked")).toMatchObject({ status: "dismissed", dismiss_category: "driver_explained" });
    expect(await dismissFuelFinding(SESSION, parked.id, "a reason I typed", actions())).toEqual({
      ok: false,
      category: "bad_request",
    });
    expect(await dismissFuelFinding(SESSION, randomUUID(), "other", actions())).toEqual({ ok: false, category: "not_found" });
  });
});

describe("the receipt compare", () => {
  it("compares the two photos on file once and keeps the answer", async () => {
    const docs = await filePhotos();
    complete.mockImplementation(answer(SAME));
    const first = await run();
    if (!first.ok) throw new Error("the run failed");
    expect(complete).toHaveBeenCalledTimes(1);
    const [target, request, session] = complete.mock.calls[0];
    expect(target).toBe("spark");
    expect(session).toBe(SESSION);
    expect(request).toMatchObject({ purpose: COMPARE_PURPOSE, traceId: first.runId, maxCostCents: 5, maxOutputTokens: 200 });
    const dup = await finding("fuel_duplicate");
    expect(dup).toMatchObject({ compare_verdict: "same", compare_confidence: "high", compare_category: null });
    expect(dup.compare_call_id).toMatch(UUID);
    expect(JSON.parse(dup.compare_document_ids)).toEqual(docs);
    expect((await runs())[0]).toMatchObject({ compare_count: 1, spent_cents: 2 });

    // A kept answer is final: the next run does not ask again.
    await run();
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await finding("fuel_duplicate")).compare_verdict).toBe("same");
  });

  it("stops at the carrier's daily allowance and tries again once there is room", async () => {
    await filePhotos();
    await ledgerCall(new Date(NOW.getTime() - 60 * 60_000), COST);
    flags.fuelAnomalyLimits = { ...LIMITS, comparesPerTenantPerDay: 1 };
    complete.mockImplementation(answer(SAME));
    expect(await run()).toMatchObject({ ok: true });
    expect(complete).not.toHaveBeenCalled();
    expect(await finding("fuel_duplicate")).toMatchObject({ compare_verdict: "unknown", compare_category: "budget" });

    flags.fuelAnomalyLimits = { ...LIMITS, comparesPerTenantPerDay: 2 };
    await run();
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await finding("fuel_duplicate")).compare_verdict).toBe("same");
  });

  it("keeps a timeout open to try again and counts its cap as spent", async () => {
    await filePhotos();
    complete.mockImplementation(async () => {
      throw new AiError("timeout");
    });
    expect(await run()).toMatchObject({ ok: true });
    expect(await finding("fuel_duplicate")).toMatchObject({ compare_verdict: "unknown", compare_category: "timeout" });
    expect((await runs())[0]).toMatchObject({ compare_count: 1, spent_cents: LIMITS.compareMaxCostCents });

    complete.mockImplementation(answer(SAME));
    await run();
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await finding("fuel_duplicate")).compare_verdict).toBe("same");
  });

  it("keeps an unreadable answer as final and never stores its text", async () => {
    await filePhotos();
    complete.mockImplementation(answer("They look alike to me."));
    await run();
    const dup = await finding("fuel_duplicate");
    expect(dup).toMatchObject({ compare_verdict: "unknown", compare_category: "unreadable" });
    expect(JSON.stringify(dup)).not.toContain("alike");
    await run();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("tenant walls and guards", () => {
  it("shows another carrier none of the rows and refuses a person without a membership", async () => {
    await run();
    const other = randomUUID();
    const seen = await app.withTenant(other, (q) =>
      q.query<{ n: string }>(
        "SELECT CAST((SELECT count(*) FROM fuel_findings) + (SELECT count(*) FROM fuel_check_runs) AS text) AS n",
      ),
    );
    expect(seen[0].n).toBe("0");
    const stranger: Session = { sub: `sub-${randomUUID()}`, email: "x@example.test", tenantId: T };
    const off = await finding("fuel_off_route");
    await expect(runFuelCheck(stranger, { db: app, clock, complete })).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(proposeFuelCorrection(stranger, off.id, actions())).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(dismissFuelFinding(stranger, off.id, "other", actions())).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(readFuelPage(stranger, { db: app })).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("holds the app's role to the allowed moves and never lets it delete", async () => {
    await run();
    const parked = await finding("fuel_while_parked");
    const off = await finding("fuel_off_route");
    await dismissFuelFinding(SESSION, parked.id, "pump_error", actions());
    const asApp = (sql: string, params: Param[] = []) => app.withTenant(T, (q) => q.execute(sql, params));

    // A dismissal is never undone, and a finding names a card only when proposed.
    expect(
      await sqlStateOf(asApp("UPDATE fuel_findings SET status = 'open', dismiss_category = NULL WHERE id = CAST($1 AS uuid)", [parked.id])),
    ).toBe("23514");
    expect(
      await sqlStateOf(asApp("UPDATE fuel_findings SET status = 'cleared' WHERE id = CAST($1 AS uuid)", [parked.id])),
    ).toBe("23514");
    // A new finding is open and undecided.
    const [run1] = await runs();
    expect(
      await sqlStateOf(
        asApp(
          `INSERT INTO fuel_findings (id, tenant_id, finding_key, check_name, category, driver_id, fuel_purchase_id,
             purchased_on, state, gallons_milli, tank_gallons, paid_with, amount_cents, suggested_cents, sources,
             status, dismiss_category, first_run_id, last_run_id)
           SELECT CAST($1 AS uuid), current_tenant_id(), 'guard-test', check_name, category, driver_id, fuel_purchase_id,
             purchased_on, state, gallons_milli, tank_gallons, paid_with, amount_cents, suggested_cents, sources,
             'dismissed', 'other', first_run_id, last_run_id
             FROM fuel_findings WHERE id = CAST($2 AS uuid)`,
          [randomUUID(), off.id],
        ),
      ),
    ).toBe("23514");
    // A finished run never changes.
    expect(
      await sqlStateOf(asApp("UPDATE fuel_check_runs SET checked_count = 1 WHERE id = CAST($1 AS uuid)", [run1.id])),
    ).toBe("23514");
    // The app's role has no delete on either table, and no write to a finding's identity.
    expect(await sqlStateOf(asApp("DELETE FROM fuel_findings WHERE id = CAST($1 AS uuid)", [off.id]))).toBe("42501");
    expect(await sqlStateOf(asApp("DELETE FROM fuel_check_runs WHERE id = CAST($1 AS uuid)", [run1.id]))).toBe("42501");
    expect(
      await sqlStateOf(asApp("UPDATE fuel_findings SET category = 'other' WHERE id = CAST($1 AS uuid)", [off.id])),
    ).toBe("42501");
  });

  it("never changes a kept compare answer", async () => {
    await filePhotos();
    complete.mockImplementation(answer(SAME));
    await run();
    const dup = await finding("fuel_duplicate");
    expect(
      await sqlStateOf(
        app.withTenant(T, (q) =>
          q.execute(
            "UPDATE fuel_findings SET compare_verdict = 'different', compare_confidence = 'low' WHERE id = CAST($1 AS uuid)",
            [dup.id],
          ),
        ),
      ),
    ).toBe("23514");
  });
});

describe("the readers", () => {
  it("lists the fuel checks in the run_checks tool only while the switch is on", async () => {
    const ctx = { session: SESSION, now: NOW, timeZone: CARRIER.timezone } as Parameters<typeof runChecks.run>[1];
    const fuelRows = async () => {
      const out = await app.withTenant(T, (q) => runChecks.run(q, ctx, {}, { screen: null, limit: null }));
      const rows = (out as { result: { rows: { check: string; suggestedCents?: number | null }[] } }).result.rows;
      return rows.filter((r) => FUEL_CHECKS.has(r.check));
    };
    flags.fuelAnomalyEnabled = false;
    expect(await fuelRows()).toEqual([]);
    flags.fuelAnomalyEnabled = true;
    const on = await fuelRows();
    expect(on.map((r) => r.check).sort()).toEqual(expected.map((f) => f.check).sort());
    expect(on.find((r) => r.check === "fuel_off_route")?.suggestedCents).toBe(planted("fuel_off_route").suggestedCents);
  });

  it("reads the page as sentences with the numbers and no raw ids", async () => {
    expect(await readFuelPage(SESSION, { db: app })).toEqual({ lastRun: null, needYou: 0, rows: [] });
    await run();
    const page = await readFuelPage(SESSION, { db: app });
    expect(page.lastRun).toMatchObject({ status: "done", checked: CHECKED, found: 4 });
    expect(page.needYou).toBe(4);
    expect(page.rows).toHaveLength(4);
    for (const r of page.rows) {
      expect(r.sentence).not.toMatch(UUID);
      expect(r.sentence).not.toContain("_");
      expect(r.purchaseRef).not.toMatch(UUID);
    }
    const off = page.rows.find((r) => r.check === "fuel_off_route")!;
    expect(off.loadNumber).not.toBeNull();
    expect(off.sentence).toContain(`load ${off.loadNumber}`);
    const dup = page.rows.find((r) => r.check === "fuel_duplicate")!;
    expect(dup.otherPurchaseRef).not.toBeNull();
    expect(dup.payItemRef).not.toBeNull();
  });
});
