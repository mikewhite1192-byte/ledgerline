import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { callTool } from "../agent/gateway";
import { engineCheck } from "../agent/gateway/store/engine-check";
import type { GatewayContext } from "../agent/gateway/types";
import { AiError } from "../ai";
import type { Session } from "../auth/claims";
import { untrustedContentHash } from "../data/content-hash";
import { readCheckInput } from "../data/read";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import type { ReadComplete } from "../documents/read";
import { uploadDocument } from "../documents/service";
import { CONFIDENCE_FIELDS } from "../documents/types";
import { addJudge, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { loadCreateExecutor } from "../proposals/executors/load-create";
import { EXECUTORS, executeProposal, type ExecuteDeps, type Executor, type ProposalRow } from "../proposals/execute";
import { runAllChecks } from "../rules-engine";
import { ForbiddenError } from "../tenant/context";
import type { RateConComplete } from "./read";
import { rateConTranscriptOf } from "./schema";
import { createLoadCard } from "./service";
import { countRecentRateCons } from "./store";
import { RATECON_NOW, RATECON_TOTAL_CENTS, rateConPdf, rateConReading, rateConResult, rateConText } from "./test-fixtures";

// A rate confirmation for a load no record holds, against the real database as the app's role,
// with fake model calls (no network, no model). The second read proposes a load_create card with
// whole cents and the tenant's own customer; the same file twice is one row and one read; every
// failure is a category and makes no card; a person's approval writes exactly one planned load
// with its charge lines, once, and the engine's checks run on it. Only this file's two tenants are
// made, and they are removed after, whichever way the tests end.

const MINUTE = 60_000;
const clock = () => new Date(RATECON_NOW);
const saved = {
  documents: flags.documentsEnabled,
  crop: flags.documentCrop,
  auditor: flags.auditorRequired,
  ratecon: { ...flags.ratecon },
};

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let judge: Session;

// The first read's answer for a rate confirmation printing this load number.
function genericRead(loadNumber: string): string {
  return JSON.stringify({
    document_kind: "rate_confirmation",
    sample_word: true,
    vendor: null,
    date_mmddyyyy: null,
    total_cents: null,
    load_number: loadNumber,
    truck_unit: null,
    gallons_milli: null,
    price_cents: null,
    loaded_miles: 450,
    rate_per_mile_cents: 300,
    linehaul_cents: 135_000,
    fuel_surcharge_cents: 12_000,
    customer_name: "Test Shipper",
    stops: [],
    text_lines: ["SAMPLE RATE CONFIRMATION", `Load ${loadNumber}`],
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])),
  });
}

// The second read's fake model: one answer per call, each with its own call id.
const model = (text = rateConText()) =>
  vi.fn<RateConComplete>(async () => rateConResult(text, { callId: randomUUID() }));
const failing = (category: ConstructorParameters<typeof AiError>[0]) =>
  vi.fn<RateConComplete>(async () => {
    throw new AiError(category);
  });

// An uploaded rate confirmation, read by the first read as one no load holds. Each call is its own
// file unless the same n is given again.
let files = 0;
async function upload(loadNumber: string, n = ++files, now = clock): Promise<{ id: string; duplicate: boolean }> {
  const complete = vi.fn<ReadComplete>(async () => rateConResult(genericRead(loadNumber), { callId: randomUUID() }));
  const out = await uploadDocument(
    A.session,
    { name: `rate-con-${n}.pdf`, type: "application/pdf", bytes: rateConPdf(n) },
    { db: app, now, read: { complete } },
  );
  if (!out.ok) throw new Error(`upload refused: ${out.error}`);
  expect(out.view).toMatchObject({ readStatus: "read", kind: "rate_confirmation" });
  expect(out.view.match).toMatchObject({ found: false, reason: "no_record" });
  return { id: out.view.id, duplicate: out.duplicate };
}

const card = (session: Session, documentId: string, complete: RateConComplete, now = clock) =>
  createLoadCard(session, documentId, { db: app, now, read: { complete } });

type ReadRow = {
  status: string;
  category: string | null;
  attempts: number;
  load_id: string;
  proposal_id: string | null;
  input_id: string | null;
  reading: string | null;
  read_call_id: string | null;
};

async function readRows(documentId: string): Promise<ReadRow[]> {
  return admin.withTenant(A.tenantId, (q) =>
    q.query<ReadRow>(
      `SELECT status, category, attempts::int AS attempts, CAST(load_id AS text) AS load_id,
              CAST(proposal_id AS text) AS proposal_id, CAST(input_id AS text) AS input_id,
              CAST(reading AS text) AS reading, CAST(read_call_id AS text) AS read_call_id
         FROM ratecon_reads WHERE tenant_id = current_tenant_id() AND document_id = CAST($1 AS uuid)`,
      [documentId],
    ),
  );
}

type ProposalSeen = {
  kind: string;
  subject_table: string;
  subject_id: string;
  amount_cents: number;
  direction: string;
  status: string;
  title: string;
  origin: string;
  args: string;
  decision_note: string | null;
};

async function proposal(id: string): Promise<ProposalSeen> {
  const rows = await admin.withTenant(A.tenantId, (q) =>
    q.query<ProposalSeen>(
      `SELECT kind, subject_table, CAST(subject_id AS text) AS subject_id, amount_cents::int AS amount_cents,
              direction, status, title, origin, CAST(args AS text) AS args, decision_note
         FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    ),
  );
  if (rows.length !== 1) throw new Error("no such proposal");
  return rows[0];
}

async function loadsNumbered(loadNumber: string) {
  return admin.withTenant(A.tenantId, (q) =>
    q.query<Record<string, unknown>>(
      `SELECT CAST(id AS text) AS id, load_number, CAST(customer_id AS text) AS customer_id,
              CAST(driver_id AS text) AS driver_id, status, origin_city, origin_state, dest_city, dest_state,
              to_char(pickup_on, 'YYYY-MM-DD') AS pickup_on, delivered_on, loaded_miles::int AS loaded_miles,
              empty_miles::int AS empty_miles, linehaul_cents::int AS linehaul_cents,
              fuel_surcharge_cents::int AS fuel_surcharge_cents
         FROM loads WHERE tenant_id = current_tenant_id() AND load_number = $1`,
      [loadNumber],
    ),
  );
}

async function linesOfLoad(loadId: string) {
  return admin.withTenant(A.tenantId, (q) =>
    q.query<Record<string, unknown>>(
      `SELECT kind, seq::int AS seq, amount_cents::int AS amount_cents, paid_by_driver, description,
              proposal_id
         FROM load_accessorials WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)
        ORDER BY kind, seq`,
      [loadId],
    ),
  );
}

const countIn = async (tenantId: string, sql: string, params: string[] = []) =>
  Number(
    (await admin.withTenant(tenantId, (q) => q.query<{ n: number | string }>(sql, params)))[0].n,
  );

const approve = (session: Session, id: string, deps: Pick<ExecuteDeps, "executors"> = {}) =>
  executeProposal(session, id, { confirmed: true }, { db: app, clock, ...deps });

const auditorCtx = (): GatewayContext => ({
  session: A.session,
  role: "auditor",
  model: "wonder",
  turnId: null,
  traceId: randomUUID(),
  now: clock(),
  deadlineAt: RATECON_NOW + MINUTE,
  timeZone: "America/Chicago",
});

describe("rate confirmations in the database", () => {
  // The first card, made in the first test and approved later.
  let first: { documentId: string; proposalId: string; loadId: string };
  // A second file of the same rate confirmation, refused while the first card is live.
  let second: string;

  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `ratecon-a-${randomUUID().slice(0, 8)}`);
    B = await makeTenant(admin, `ratecon-b-${randomUUID().slice(0, 8)}`);
    judge = await addJudge(admin, A);
    // One version of pay rules, so the engine's checks can run over the tenant.
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
           empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
           escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
           advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-10-05' AS date), 'seed', 1, 'linehaul',
           0, 10000, 'all', 1100, 0, 0, 0, NULL, 500, 150000, 5000, 5000)`,
        [randomUUID()],
      ),
    );
  });

  beforeEach(() => {
    flags.documentsEnabled = true;
    flags.documentCrop = false;
    flags.auditorRequired = false;
    flags.ratecon = { ...saved.ratecon, enabled: true };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    flags.documentsEnabled = saved.documents;
    flags.documentCrop = saved.crop;
    flags.auditorRequired = saved.auditor;
    flags.ratecon = { ...saved.ratecon };
    if (admin) {
      await dropTenant(admin, A);
      await dropTenant(admin, B);
    }
    await app?.close();
    await admin?.close();
  });

  it("proposes a card with the document's whole numbers and the tenant's own customer, and writes no load", async () => {
    const doc = await upload("RC-1001");
    const complete = model();
    const out = await card(A.session, doc.id, complete);
    if (!out.ok) throw new Error(`refused: ${out.error}`);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out.view).toMatchObject({ documentId: doc.id, status: "proposed", category: null, attemptsLeft: 2 });
    const [row] = await readRows(doc.id);
    expect(row).toMatchObject({ status: "proposed", category: null, attempts: 1, proposal_id: out.view.proposalId });
    expect(row.read_call_id).not.toBeNull();

    // The transcript is stored as an outside input, and the card holds its hash.
    const body = rateConTranscriptOf(rateConReading());
    const [input] = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ kind: string; source: string; body_text: string; content_hash: string }>(
        `SELECT kind, source, body_text, content_hash FROM untrusted_inputs
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [row.input_id],
      ),
    );
    expect(input).toEqual({ kind: "document", source: "upload", body_text: body, content_hash: untrustedContentHash("document", body) });

    const p = await proposal(out.view.proposalId!);
    expect(p).toMatchObject({
      kind: "load_create",
      subject_table: "loads",
      subject_id: row.load_id,
      amount_cents: RATECON_TOTAL_CENTS,
      direction: "in",
      status: "proposed",
      title: "Create load from rate confirmation",
      origin: "engine",
    });
    expect(JSON.parse(p.args)).toEqual({
      v: 1,
      loadId: row.load_id,
      documentId: doc.id,
      inputId: row.input_id,
      readingHash: untrustedContentHash("document", body),
      loadNumber: "RC-1001",
      customerId: A.customerId,
      customerCode: "CUST-1",
      originCity: "Dallas",
      originState: "TX",
      destCity: "Memphis",
      destState: "TN",
      pickupOn: "2026-11-05",
      deliveryOn: "2026-11-06",
      loadedMiles: 450,
      ratePerMileCents: 300,
      linehaulCents: 135_000,
      fuelSurchargeCents: 12_000,
      accessorials: [
        { kind: "stop", amountCents: 7_500 },
        { kind: "lumper", amountCents: 5_000 },
      ],
      totalCents: RATECON_TOTAL_CENTS,
      driverCodeClaim: "DRV-1",
      revision: 0,
    });
    // Nothing is created until a person approves.
    expect(await loadsNumbered("RC-1001")).toEqual([]);
    first = { documentId: doc.id, proposalId: out.view.proposalId!, loadId: row.load_id };
  });

  it("takes the same file again as one document, one reading and no second model call", async () => {
    const again = await upload("RC-1001", 1);
    expect(again).toEqual({ id: first.documentId, duplicate: true });
    const complete = model();
    const out = await card(A.session, first.documentId, complete);
    expect(out).toMatchObject({ ok: true, view: { status: "proposed", proposalId: first.proposalId } });
    expect(complete).not.toHaveBeenCalled();
    expect(await readRows(first.documentId)).toHaveLength(1);
    expect(
      await countIn(A.tenantId, "SELECT count(*) AS n FROM proposals WHERE tenant_id = current_tenant_id() AND kind = 'load_create'"),
    ).toBe(1);
  });

  it("refuses a second file of the same rate confirmation while its card is live", async () => {
    const doc = await upload("RC-1001");
    const out = await card(A.session, doc.id, model());
    expect(out).toMatchObject({ ok: true, view: { status: "refused", category: "card_exists", proposalId: null } });
    const [row] = await readRows(doc.id);
    // The reading is kept with its category; the transcript is stored; no card.
    expect(row).toMatchObject({ status: "refused", category: "card_exists", proposal_id: null });
    expect(row.reading).not.toBeNull();
    expect(row.input_id).not.toBeNull();
    second = doc.id;
  });

  it("refuses an unknown customer and a total that disagrees with its lines, by category, with no card", async () => {
    const stranger = await upload("RC-3001");
    const unknown = await card(
      A.session,
      stranger.id,
      model(rateConText({ loadNumber: "RC-3001", customerName: "Nobody Freight", customerCode: "NOPE" })),
    );
    expect(unknown).toMatchObject({ ok: true, view: { status: "refused", category: "unknown_customer", proposalId: null } });

    const off = await upload("RC-4001");
    // The document prints $1,800.00 while its lines come to $1,595.00.
    const arithmetic = await card(A.session, off.id, model(rateConText({ loadNumber: "RC-4001", totalCents: 180_000 })));
    expect(arithmetic).toMatchObject({ ok: true, view: { status: "refused", category: "arithmetic_off", proposalId: null } });
    expect(await loadsNumbered("RC-3001")).toEqual([]);
    expect(await loadsNumbered("RC-4001")).toEqual([]);
    expect(
      await countIn(A.tenantId, "SELECT count(*) AS n FROM proposals WHERE tenant_id = current_tenant_id() AND kind = 'load_create'"),
    ).toBe(1);
  });

  it("stores an unreadable answer as its category, takes one try each, and stops at three", async () => {
    const doc = await upload("RC-2001");
    const notJson = model("not json");
    expect(await card(A.session, doc.id, notJson)).toMatchObject({
      ok: true,
      view: { status: "unreadable", category: "schema", proposalId: null, attemptsLeft: 2 },
    });
    expect(await card(A.session, doc.id, failing("bad_request"))).toMatchObject({
      ok: true,
      view: { status: "unreadable", category: "model_error", attemptsLeft: 1 },
    });
    expect(await card(A.session, doc.id, failing("cap"))).toMatchObject({
      ok: true,
      view: { status: "budget", category: "cap", attemptsLeft: 0 },
    });
    const fourth = model();
    expect(await card(A.session, doc.id, fourth)).toEqual({ ok: false, error: "attempt_limit" });
    expect(fourth).not.toHaveBeenCalled();
    const [row] = await readRows(doc.id);
    // Only a category is stored, never the error's text or a reading.
    expect(row).toMatchObject({ status: "budget", category: "cap", attempts: 3, reading: null, input_id: null, proposal_id: null });
  });

  it("leaves a read whose outcome is not known pending, then takes it again after two minutes", async () => {
    const doc = await upload("RC-2501");
    expect(await card(A.session, doc.id, failing("timeout"))).toMatchObject({
      ok: true,
      view: { status: "pending", category: null, attemptsLeft: 2 },
    });
    const early = model();
    expect(await card(A.session, doc.id, early, () => new Date(RATECON_NOW + MINUTE))).toEqual({
      ok: false,
      error: "in_progress",
    });
    expect(early).not.toHaveBeenCalled();
    const later = model(rateConText({ loadNumber: "RC-2501" }));
    const out = await card(A.session, doc.id, later, () => new Date(RATECON_NOW + 3 * MINUTE));
    expect(out).toMatchObject({ ok: true, view: { status: "proposed", attemptsLeft: 1 } });
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("refuses a document stored before the start date with no read, no tries left and none of the day's count", async () => {
    // Three days before RATECON_NOW: October 31 in the carrier's zone, before flags.ratecon.startDate.
    const doc = await upload("RC-2601", ++files, () => new Date(RATECON_NOW - 3 * 24 * 60 * MINUTE));
    const counted = () => app.withTenant(A.tenantId, (q) => countRecentRateCons(q, clock().toISOString()));
    const before = await counted();
    const complete = model(rateConText({ loadNumber: "RC-2601" }));
    expect(await card(A.session, doc.id, complete)).toEqual({
      ok: true,
      view: { documentId: doc.id, status: "refused", category: "before_start", proposalId: null, attemptsLeft: 0 },
    });
    expect(await card(A.session, doc.id, complete, () => new Date(RATECON_NOW + 3 * MINUTE))).toEqual({
      ok: false,
      error: "attempt_limit",
    });
    expect(complete).not.toHaveBeenCalled();
    const [row] = await readRows(doc.id);
    expect(row).toMatchObject({
      status: "refused",
      category: "before_start",
      attempts: 3,
      reading: null,
      input_id: null,
      read_call_id: null,
      proposal_id: null,
    });
    expect(await counted()).toBe(before);
  });

  it("keeps a carrier's readings to itself: another carrier finds nothing and can write nothing", async () => {
    const complete = model();
    expect(await card(B.session, first.documentId, complete)).toEqual({ ok: false, error: "not_found" });
    expect(complete).not.toHaveBeenCalled();
    const seen = await app.withTenant(B.tenantId, (q) =>
      q.query<{ n: number }>("SELECT count(*)::int AS n FROM ratecon_reads"),
    );
    expect(seen[0].n).toBe(0);
    const forged = app.withTenant(B.tenantId, (q) =>
      q.execute(
        `INSERT INTO ratecon_reads (id, tenant_id, document_id, load_id) VALUES (CAST($1 AS uuid), CAST($2 AS uuid),
           CAST($3 AS uuid), CAST($4 AS uuid))`,
        [randomUUID(), A.tenantId, first.documentId, randomUUID()],
      ),
    );
    expect(await sqlStateOf(forged)).toBe("42501");
    // The app login can never delete a reading, nor move its load id.
    const del = app.withTenant(A.tenantId, (q) =>
      q.execute("DELETE FROM ratecon_reads WHERE tenant_id = current_tenant_id() AND document_id = CAST($1 AS uuid)", [
        first.documentId,
      ]),
    );
    expect(await sqlStateOf(del)).toBe("42501");
    const move = app.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE ratecon_reads SET load_id = CAST($2 AS uuid) WHERE tenant_id = current_tenant_id() AND document_id = CAST($1 AS uuid)",
        [first.documentId, randomUUID()],
      ),
    );
    expect(await sqlStateOf(move)).toBe("42501");
  });

  it("refuses a demo visitor before any read, and before any approval", async () => {
    const complete = model();
    const err = await card(judge, first.documentId, complete).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).reason).toBe("judge");
    expect(complete).not.toHaveBeenCalled();
    const refused = await approve(judge, first.proposalId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((await proposal(first.proposalId)).status).toBe("proposed");
    expect(await loadsNumbered("RC-1001")).toEqual([]);
  });

  it("does nothing while the switch is off: no read, no approval, no executor", async () => {
    flags.ratecon = { ...flags.ratecon, enabled: false };
    const complete = model();
    expect(await card(A.session, first.documentId, complete)).toEqual({ ok: false, error: "disabled" });
    expect(complete).not.toHaveBeenCalled();
    expect(EXECUTORS.load_create).toBeUndefined();
    expect(await approve(A.session, first.proposalId)).toMatchObject({ ok: false, category: "not_executable" });
    // Called directly, the executor and its precheck refuse before reading anything.
    const row = { id: first.proposalId, kind: "load_create" } as ProposalRow;
    expect(await loadCreateExecutor(app, A.session, row, { confirmed: true }, { clock })).toMatchObject({
      ok: false,
      category: "not_executable",
    });
    const stop = await app.withTenant(A.tenantId, (q) =>
      loadCreateExecutor.precheck!(q, row, clock(), { session: A.session, opts: { confirmed: true } }),
    );
    expect(stop).toMatchObject({ ok: false, category: "not_executable" });
    expect((await proposal(first.proposalId)).status).toBe("proposed");
    expect(await loadsNumbered("RC-1001")).toEqual([]);
  });

  it("gives the auditor the engine's own numbers for the card, and they match it", async () => {
    const out = await callTool(
      auditorCtx(),
      { id: "c", name: "get_proposal", argumentsJson: JSON.stringify({ proposalId: first.proposalId }) },
      { db: app, clock: () => RATECON_NOW },
    );
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const engine = (out.result as { engine: Record<string, unknown> }).engine;
    expect(engine).toEqual({
      ok: true,
      check: "load_create",
      holds: true,
      totalCents: RATECON_TOTAL_CENTS,
      linehaulCents: 135_000,
      fuelSurchargeCents: 12_000,
      accessorialCents: 12_500,
    });
    const checked = await app.withTenant(A.tenantId, (q) => engineCheck(q, auditorCtx(), first.proposalId));
    expect(checked).toEqual({ check: "matched", engineCents: RATECON_TOTAL_CENTS });
  });

  it("writes exactly one planned load with its charge lines on approval, and the engine's checks run on it", async () => {
    const done = await approve(A.session, first.proposalId);
    expect(done).toEqual({ ok: true, proposalId: first.proposalId, status: "done", moneyActionId: null });
    const loads = await loadsNumbered("RC-1001");
    expect(loads).toEqual([
      {
        id: first.loadId,
        load_number: "RC-1001",
        customer_id: A.customerId,
        driver_id: null,
        status: "planned",
        origin_city: "Dallas",
        origin_state: "TX",
        dest_city: "Memphis",
        dest_state: "TN",
        pickup_on: "2026-11-05",
        delivered_on: null,
        loaded_miles: 450,
        empty_miles: 0,
        linehaul_cents: 135_000,
        fuel_surcharge_cents: 12_000,
      },
    ]);
    // The lines carry a fixed phrase for their kind, never the document's own words.
    expect(await linesOfLoad(first.loadId)).toEqual([
      { kind: "lumper", seq: 1, amount_cents: 5_000, paid_by_driver: false, description: "Lumper, from the rate confirmation", proposal_id: null },
      { kind: "stop", seq: 1, amount_cents: 7_500, paid_by_driver: false, description: "Extra stop, from the rate confirmation", proposal_id: null },
    ]);
    expect((await readRows(first.documentId))[0].status).toBe("created");
    expect((await proposal(first.proposalId)).status).toBe("done");
    // No state miles are known, and the engine's checks take the planned load without them.
    expect(
      await countIn(A.tenantId, "SELECT count(*) AS n FROM load_state_miles WHERE tenant_id = current_tenant_id() AND load_id = CAST($1 AS uuid)", [
        first.loadId,
      ]),
    ).toBe(0);
    const input = await app.withTenant(A.tenantId, readCheckInput);
    expect(input.loads.some((l) => l.id === first.loadId)).toBe(true);
    const findings = runAllChecks(input);
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.filter((f) => JSON.stringify(f).includes(first.loadId))).toEqual([]);
  });

  it("never writes the load twice: approving again, or the executor run again, leaves one load", async () => {
    expect(await approve(A.session, first.proposalId)).toMatchObject({ ok: false, category: "already_decided" });
    const row = { id: first.proposalId, kind: "load_create" } as ProposalRow;
    expect(await loadCreateExecutor(app, A.session, row, { confirmed: true }, { clock })).toMatchObject({
      ok: true,
      status: "done",
    });
    expect(await loadsNumbered("RC-1001")).toHaveLength(1);
    expect(await linesOfLoad(first.loadId)).toHaveLength(2);
    // The second file, tried again, now finds the load and makes no card.
    expect(await card(A.session, second, model())).toMatchObject({
      ok: true,
      view: { status: "refused", category: "load_exists", proposalId: null, attemptsLeft: 1 },
    });
  });

  it("finishes an approval that stopped before the load was written, once", async () => {
    const doc = await upload("RC-5001");
    const made = await card(A.session, doc.id, model(rateConText({ loadNumber: "RC-5001" })));
    if (!made.ok || !made.view.proposalId) throw new Error("no card");
    const id = made.view.proposalId;
    // The approval is recorded, then the run stops before writing anything.
    const crash: Executor = Object.assign(
      async () => {
        throw new Error("stopped");
      },
      { precheck: loadCreateExecutor.precheck },
    );
    await expect(approve(A.session, id, { executors: { load_create: crash } })).rejects.toThrow("stopped");
    expect((await proposal(id)).status).toBe("approved");
    expect(await loadsNumbered("RC-5001")).toEqual([]);
    // The next approval resumes it.
    expect(await approve(A.session, id)).toMatchObject({ ok: true, status: "done" });
    expect(await approve(A.session, id)).toMatchObject({ ok: false, category: "already_decided" });
    const loads = await loadsNumbered("RC-5001");
    expect(loads).toHaveLength(1);
    expect(await linesOfLoad(String(loads[0].id))).toHaveLength(2);
  });

  it("refuses an approval once a load holds the number, writes nothing, and the engine no longer matches", async () => {
    const doc = await upload("RC-6001");
    const made = await card(A.session, doc.id, model(rateConText({ loadNumber: "RC-6001" })));
    if (!made.ok || !made.view.proposalId) throw new Error("no card");
    const id = made.view.proposalId;
    const [row] = await readRows(doc.id);
    // Someone keys the load in by hand before the card is approved.
    const byHand = randomUUID();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO loads (id, tenant_id, load_number, customer_id, status, origin_city, origin_state, dest_city,
           dest_state, pickup_on, loaded_miles)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'RC-6001', CAST($2 AS uuid), 'planned', 'Dallas', 'TX',
           'Memphis', 'TN', CAST('2026-11-05' AS date), 450)`,
        [byHand, A.customerId],
      ),
    );
    expect(await approve(A.session, id)).toEqual({ ok: false, category: "load_exists", retryable: false });
    // The card stays waiting, nothing is written under its id.
    expect((await proposal(id)).status).toBe("proposed");
    expect(
      await countIn(A.tenantId, "SELECT count(*) AS n FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
        row.load_id,
      ]),
    ).toBe(0);
    expect((await readRows(doc.id))[0].status).toBe("proposed");
    const checked = await app.withTenant(A.tenantId, (q) => engineCheck(q, auditorCtx(), id));
    expect(checked).toEqual({ check: "mismatch", engineCents: RATECON_TOTAL_CENTS });
  });
});
