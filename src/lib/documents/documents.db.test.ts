import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiMessage, type AiResult, type SegmentResult } from "../ai";
import { LOAD_NUMBERS_FIRST, LOAD_NUMBERS_NEXT } from "../data/read";
import type { Param, Queryable } from "../db";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { callTool } from "../agent/gateway";
import type { GatewayContext } from "../agent/gateway/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal } from "../proposals/execute";
import { loadCandidates } from "./candidates";
import type { CropDeps } from "./crop";
import { READ_TIMEOUT_MS, type ReadComplete } from "./read";
import {
  getDocument,
  listDocuments,
  readAgain,
  readCropFile,
  readDocumentFile,
  uploadDocument,
  type UploadFile,
} from "./service";
import { claimCrop, finishCrop, listDocumentRows, reclaimStalledCrop } from "./store";
import { CONFIDENCE_FIELDS, READ_ATTEMPTS_MAX, type DocumentRead } from "./types";

// Documents against the real database, as the app's role, with a fake model call (no network, no
// model). A document stays inside its carrier, bytes included; the same file twice is one row read
// once; the app login can neither delete a document nor change its file; a capped read keeps the
// file viewable; approving a rate fill writes the load's rate once; and a photo cropped to the
// paper is read as the crop, kept once, and never replaces the file. Only this file's four
// tenants are made, and they are removed after, whichever way the tests end.

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);
const saved = { enabled: flags.documentsEnabled, crop: flags.documentCrop, auditor: flags.auditorRequired };

// The segmenter's input limit, lowered by one test to stand in for a photo too large to send
// (no upload under the 700,000 byte cap normalizes to a frame near the real 5 MiB).
const frameLimit = vi.hoisted(() => ({ bytes: null as number | null }));
vi.mock("../ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ai")>();
  return {
    ...real,
    get MAX_IMAGE_BYTES() {
      return frameLimit.bytes ?? real.MAX_IMAGE_BYTES;
    },
  };
});

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let loadId: string;
const LOAD_NUMBER = "DOC-L1";
const MILES = 245;
const FUEL = 13_000;

// A small PNG whose bytes differ per call, so each upload is its own file.
let files = 0;
function png(name = "rate-con.png"): UploadFile {
  files += 1;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, files, files >> 8, 7, 7]);
  return { name, type: "image/png", bytes };
}

function rateReading(linehaulCents = 245 * MILES): string {
  return JSON.stringify({
    document_kind: "rate_confirmation",
    sample_word: true,
    vendor: null,
    date_mmddyyyy: null,
    total_cents: null,
    load_number: LOAD_NUMBER,
    truck_unit: null,
    gallons_milli: null,
    price_cents: null,
    loaded_miles: MILES,
    rate_per_mile_cents: 245,
    linehaul_cents: linehaulCents,
    fuel_surcharge_cents: FUEL,
    customer_name: "Test Shipper",
    stops: [],
    text_lines: ["SAMPLE RATE CONFIRMATION", `LOAD ${LOAD_NUMBER}`],
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])),
  });
}

function fakeModel(text: string) {
  return vi.fn<ReadComplete>(
    async () =>
      ({
        callId: randomUUID(),
        status: "ok",
        text,
        toolCalls: [],
        usage: { input: 900, cached: 0, output: 300, reasoning: 0 },
        costNanocents: 1_500_000,
        upstreamId: null,
        replay: [],
        toolSearches: 0,
      }) satisfies AiResult,
  );
}

const loadRate = async (id = loadId) =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ linehaul_cents: string | number | null; fuel_surcharge_cents: string | number }>(
        "SELECT linehaul_cents, fuel_surcharge_cents FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [id],
      ),
    )
  )[0];

// A delivered load of MILES with no rate yet, carrying the given surcharge, in carrier A.
async function addLoad(loadNumber: string, fuelSurchargeCents: number): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(A.tenantId, (q) =>
    q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles, linehaul_cents,
         fuel_surcharge_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'delivered',
         'Springfield', 'IL', 'Fairview', 'OH', CAST('2026-10-28' AS date), CAST('2026-10-29' AS date),
         CAST('2026-10-29T18:00:00Z' AS timestamptz), $5, NULL, $6)`,
      [id, loadNumber, A.customerId, A.driverId, MILES, fuelSurchargeCents],
    ),
  );
  return id;
}

// A waiting load_rate_fill proposal with the conversation, turn and gateway decision a real one
// hangs from, written by the admin login so created_at and the auditor's pass can be set (only a
// pass goes through without the second confirm).
async function addRateProposal(
  linehaulCents: number,
  extra: Record<string, unknown> = {},
  load = loadId,
): Promise<string> {
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - HOUR).toISOString();
  const args = { loadId: load, linehaulCents, fuelSurchargeCents: FUEL, ratePerMileCents: 245, ...extra };
  await admin.withTenant(A.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)`,
      [conversation, A.session.sub],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Fill the rate?', 'done', $3,
         CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
      [turn, conversation, trace, created],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark', 'propose_load_rate',
         'propose', 'allowed', 'ok', 1)`,
      [decision, turn, trace],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
         created_at, updated_at, auditor_verdict, auditor_agrees, auditor_checked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'load_rate_fill', 'loads',
         CAST($4 AS uuid), 0, 'none', 'Fill missing rate', CAST($5 AS jsonb), 'eligible', CAST($6 AS uuid), $7, $8,
         CAST($9 AS timestamptz), CAST($9 AS timestamptz), 'pass', true, CAST($9 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        load,
        JSON.stringify(args),
        decision,
        // Unique per call: two tests may propose the same cents for this load.
        `load_rate_fill:${load}:${randomUUID().replace(/-/g, "").padStart(64, "0")}`,
        trace,
        created,
      ],
    );
  });
  return id;
}

const proposalStatus = async (id: string) =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ status: string; decision_note: string | null }>(
        "SELECT status, decision_note FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [id],
      ),
    )
  )[0];

describe("documents in the database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `docs-a-${randomUUID().slice(0, 8)}`);
    B = await makeTenant(admin, `docs-b-${randomUUID().slice(0, 8)}`);
    loadId = await addLoad(LOAD_NUMBER, FUEL);
  });

  beforeEach(() => {
    flags.documentsEnabled = true;
    flags.documentCrop = false;
    flags.auditorRequired = false;
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    flags.documentsEnabled = saved.enabled;
    flags.documentCrop = saved.crop;
    flags.auditorRequired = saved.auditor;
    vi.restoreAllMocks();
    if (admin) {
      await dropTenant(admin, A);
      await dropTenant(admin, B);
    }
    await app?.close();
    await admin?.close();
  });

  it("reads an upload, matches it to the load, and keeps it and its bytes inside its carrier", async () => {
    const complete = fakeModel(rateReading());
    const file = png();
    const out = await uploadDocument(A.session, file, { db: app, now: clock, read: { complete } });
    if (!out.ok) throw new Error(`upload refused: ${out.error}`);
    expect(out.duplicate).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    const view = out.view;
    expect(view).toMatchObject({ readStatus: "read", kind: "rate_confirmation", createdAt: new Date(NOW).toISOString() });
    expect(view.match).toMatchObject({ found: true, table: "loads", id: loadId, supports: "load_rate_fill" });
    expect(view.inputId).not.toBeNull();

    const transcription = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ kind: string; source: string; body_text: string }>(
        "SELECT kind, source, body_text FROM untrusted_inputs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [view.inputId],
      ),
    );
    // The printed lines, then every string the reading claims, so the screen reads each one.
    const body = [
      "SAMPLE RATE CONFIRMATION",
      `LOAD ${LOAD_NUMBER}`,
      "(values read from this document)",
      `load number: ${LOAD_NUMBER}`,
      "customer name: Test Shipper",
    ].join("\n");
    expect(transcription).toEqual([{ kind: "document", source: "upload", body_text: body }]);

    const back = await readDocumentFile(A.session, view.id, { db: app });
    expect(back?.mime).toBe("image/png");
    expect(Array.from(back?.bytes ?? [])).toEqual(Array.from(file.bytes));

    // The other carrier sees nothing: not the row, not the list, not the bytes.
    expect(await getDocument(B.session, view.id, { db: app, now: clock })).toBeNull();
    expect(await listDocuments(B.session, { db: app, now: clock })).toEqual([]);
    expect(await readDocumentFile(B.session, view.id, { db: app })).toBeNull();
    const seen = await app.withTenant(B.tenantId, (q) =>
      q.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE id = CAST($1 AS uuid)", [view.id]),
    );
    expect(seen[0].n).toBe(0);
    // Writing a row for another carrier is refused by the policy's check.
    const forged = app.withTenant(B.tenantId, (q) =>
      q.execute(
        `INSERT INTO documents (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash, trace_id)
         VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'x', 'x.png', 'image/png', 1, decode('00', 'hex'), $3, CAST($4 AS uuid))`,
        [randomUUID(), A.tenantId, "a".repeat(64), randomUUID()],
      ),
    );
    expect(await sqlStateOf(forged)).toBe("42501");
  });

  it("takes the same file twice as one row, read once", async () => {
    const complete = fakeModel(rateReading());
    const file = png("again.png");
    const first = await uploadDocument(A.session, file, { db: app, now: clock, read: { complete } });
    const second = await uploadDocument(A.session, { ...file, name: "again copy.png" }, { db: app, now: clock, read: { complete } });
    if (!first.ok || !second.ok) throw new Error("upload refused");
    expect(second.duplicate).toBe(true);
    expect(second.view.id).toBe(first.view.id);
    expect(second.view.filename).toBe("again.png");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("never lets the app login delete a document or change its file", async () => {
    const out = await uploadDocument(A.session, png(), { db: app, now: clock, read: { complete: fakeModel(rateReading()) } });
    if (!out.ok) throw new Error("upload refused");
    const id = out.view.id;
    const del = app.withTenant(A.tenantId, (q) =>
      q.execute("DELETE FROM documents WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]),
    );
    expect(await sqlStateOf(del)).toBe("42501");
    const change = app.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE documents SET bytes = decode('00', 'hex'), byte_length = 1 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [id],
      ),
    );
    expect(await sqlStateOf(change)).toBe("42501");
    expect((await readDocumentFile(A.session, id, { db: app }))?.bytes.byteLength).toBe(16);
  });

  it("stores a document whose read hit the demo cap as not read, and still shows the file", async () => {
    const complete = vi.fn<ReadComplete>(async () => {
      throw new AiError("cap");
    });
    const file = png("capped.png");
    const out = await uploadDocument(A.session, file, { db: app, now: clock, read: { complete } });
    if (!out.ok) throw new Error("upload refused");
    expect(out.view).toMatchObject({ readStatus: "budget", kind: null, read: null, inputId: null });
    const back = await readDocumentFile(A.session, out.view.id, { db: app });
    expect(Array.from(back?.bytes ?? [])).toEqual(Array.from(file.bytes));
  });

  it("leaves a read whose outcome is not known pending, and Read again finishes it after two minutes", async () => {
    const timeout = vi.fn<ReadComplete>(async () => {
      throw new AiError("timeout");
    });
    const file = png("slow.png");
    const out = await uploadDocument(A.session, file, { db: app, now: clock, read: { complete: timeout } });
    if (!out.ok) throw new Error("upload refused");
    expect(out.view).toMatchObject({ readStatus: "pending", readAttempts: 1, stalled: false, read: null, inputId: null });
    const id = out.view.id;
    // The same file again is the same pending row, with no second read.
    const dup = await uploadDocument(A.session, file, { db: app, now: clock, read: { complete: timeout } });
    expect(dup).toMatchObject({ ok: true, duplicate: true, view: { id, readStatus: "pending" } });
    expect(timeout).toHaveBeenCalledTimes(1);
    // Too soon after the last try: refused, nothing read.
    const soon = () => new Date(NOW + 60_000);
    expect(await readAgain(A.session, id, { db: app, now: soon, read: { complete: timeout } })).toEqual({
      ok: false,
      error: "in_progress",
    });
    expect(timeout).toHaveBeenCalledTimes(1);
    const good = fakeModel(rateReading());
    const later = () => new Date(NOW + 3 * 60_000);
    const again = await readAgain(A.session, id, { db: app, now: later, read: { complete: good } });
    expect(again).toMatchObject({ ok: true, view: { readStatus: "read", readAttempts: 2, kind: "rate_confirmation" } });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("stops Read again after three reads in all, and the database holds the cap", async () => {
    const timeout = vi.fn<ReadComplete>(async () => {
      throw new AiError("unavailable", 503);
    });
    const at = (minutes: number) => () => new Date(NOW + minutes * 60_000);
    const out = await uploadDocument(A.session, png("never.png"), { db: app, now: clock, read: { complete: timeout } });
    if (!out.ok) throw new Error("upload refused");
    const id = out.view.id;
    expect(await readAgain(A.session, id, { db: app, now: at(3), read: { complete: timeout } })).toMatchObject({
      ok: true,
      view: { readStatus: "pending", readAttempts: 2 },
    });
    expect(await readAgain(A.session, id, { db: app, now: at(6), read: { complete: timeout } })).toMatchObject({
      ok: true,
      view: { readStatus: "pending", readAttempts: READ_ATTEMPTS_MAX },
    });
    expect(await readAgain(A.session, id, { db: app, now: at(9), read: { complete: timeout } })).toEqual({
      ok: false,
      error: "attempt_limit",
    });
    expect(timeout).toHaveBeenCalledTimes(READ_ATTEMPTS_MAX);
    expect(await getDocument(A.session, id, { db: app, now: at(9) })).toMatchObject({
      readStatus: "pending",
      stalled: true,
      readAttempts: READ_ATTEMPTS_MAX,
    });
    const past = app.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE documents SET read_attempts = 4 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]),
    );
    expect(await sqlStateOf(past)).toBe("23514");
  });

  it("lists documents without their transcription, while one document keeps it", async () => {
    const raw = await app.withTenant(A.tenantId, (q) => listDocumentRows(q, 50));
    const read = raw.filter((r) => r.reading !== null);
    expect(read.length).toBeGreaterThan(0);
    for (const r of read) expect((JSON.parse(r.reading!) as { text_lines: unknown }).text_lines).toEqual([]);
    const views = await listDocuments(A.session, { db: app, now: clock });
    const shown = views.filter((v) => v.read !== null);
    expect(shown.length).toBe(read.length);
    for (const v of shown) expect(v.read!.textLines).toEqual([]);
    const one = await getDocument(A.session, shown[0].id, { db: app, now: clock });
    expect(one?.read?.textLines).toEqual(["SAMPLE RATE CONFIRMATION", `LOAD ${LOAD_NUMBER}`]);
  });

  it("gives the auditor the load's number and the gateway's rate check for a rate fill", async () => {
    const up = await uploadDocument(A.session, png("audit.png"), { db: app, now: clock, read: { complete: fakeModel(rateReading()) } });
    if (!up.ok || !up.view.inputId) throw new Error("upload not read");
    const inputId = up.view.inputId;
    const check = async (linehaulCents: number) => {
      const id = await addRateProposal(linehaulCents, { requestRef: inputId });
      const [{ turn_id: turnId }] = await admin.withTenant(A.tenantId, (q) =>
        q.query<{ turn_id: string }>(
          "SELECT turn_id FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
          [id],
        ),
      );
      const ctx: GatewayContext = {
        session: A.session,
        role: "auditor",
        model: "wonder",
        turnId,
        traceId: randomUUID(),
        now: new Date(NOW),
        deadlineAt: NOW + 60_000,
        timeZone: "America/New_York",
      };
      const out = await callTool(
        ctx,
        { id: "c", name: "get_proposal", argumentsJson: JSON.stringify({ proposalId: id }) },
        { db: app, clock: () => NOW },
      );
      // One live proposal per load: this one steps aside for the next.
      await admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `UPDATE proposals SET status = 'expired', decided_by = 'test', decided_at = CAST($2 AS timestamptz)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [id, new Date(NOW).toISOString()],
        ),
      );
      if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
      return out.result as { proposal: { subject: unknown }; engine: Record<string, unknown> };
    };
    const good = await check(245 * MILES);
    expect(good.proposal.subject).toEqual({ table: "loads", id: loadId, label: LOAD_NUMBER });
    expect(good.engine).toMatchObject({ ok: true, check: "load_rate_fill", supported: true });
    const off = await check(245 * MILES + 1);
    expect(off.engine).toMatchObject({ ok: true, check: "load_rate_fill", supported: false, refusal: "engine_refused" });
  });

  it("fills the load's rate once on approval; a later fill with other values fails and changes nothing", async () => {
    expect((await loadRate()).linehaul_cents).toBeNull();
    const id = await addRateProposal(245 * MILES);
    const done = await executeProposal(A.session, id, { confirmed: false }, { db: app, clock });
    expect(done).toMatchObject({ ok: true });
    expect(await proposalStatus(id)).toMatchObject({ status: "done" });
    const after = await loadRate();
    expect(Number(after.linehaul_cents)).toBe(245 * MILES);
    expect(Number(after.fuel_surcharge_cents)).toBe(FUEL);

    expect(await executeProposal(A.session, id, { confirmed: false }, { db: app, clock })).toMatchObject({
      ok: false,
      category: "already_decided",
    });

    const other = await addRateProposal(245 * MILES + 100);
    expect(await executeProposal(A.session, other, { confirmed: false }, { db: app, clock })).toMatchObject({
      ok: false,
      category: "changed_since",
    });
    expect(await proposalStatus(other)).toMatchObject({ status: "failed", decision_note: "changed_since" });
    expect(Number((await loadRate()).linehaul_cents)).toBe(245 * MILES);
  });

  it("fills a rate over the default 0 surcharge, and fails a fill whose load was given another surcharge since", async () => {
    const fresh = await addLoad("DOC-L2", 0);
    const id = await addRateProposal(245 * MILES, {}, fresh);
    expect(await executeProposal(A.session, id, { confirmed: false }, { db: app, clock })).toMatchObject({ ok: true });
    const filled = await loadRate(fresh);
    expect(Number(filled.linehaul_cents)).toBe(245 * MILES);
    expect(Number(filled.fuel_surcharge_cents)).toBe(FUEL);

    const moved = await addLoad("DOC-L3", 0);
    const stale = await addRateProposal(245 * MILES, {}, moved);
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE loads SET fuel_surcharge_cents = 9000 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [moved],
      ),
    );
    expect(await executeProposal(A.session, stale, { confirmed: false }, { db: app, clock })).toMatchObject({
      ok: false,
      category: "changed_since",
    });
    expect(await proposalStatus(stale)).toMatchObject({ status: "failed", decision_note: "changed_since" });
    const unchanged = await loadRate(moved);
    expect(unchanged.linehaul_cents).toBeNull();
    expect(Number(unchanged.fuel_surcharge_cents)).toBe(9_000);
  });

  it("finds its own carrier's load by number in pages of one, as the app, never another carrier's", async () => {
    const own = await addLoad("DOC-P1", 0);
    const theirs = randomUUID();
    for (const [id, number] of [
      [theirs, "DOC-P1"],
      [randomUUID(), "DOC-P2"],
    ]) {
      await admin.withTenant(B.tenantId, (q) =>
        q.execute(
          `INSERT INTO loads (id, tenant_id, load_number, customer_id, status, origin_city, origin_state, dest_city,
             dest_state, pickup_on, loaded_miles)
           VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), 'planned', 'Dallas', 'TX',
             'Memphis', 'TN', CAST('2026-11-05' AS date), 450)`,
          [id, number, B.customerId],
        ),
      );
    }
    const readingOf = (loadNumber: string): DocumentRead => ({
      kind: "rate_confirmation",
      fields: {
        sampleWord: true,
        vendor: null,
        date: null,
        totalCents: null,
        loadNumber,
        truckUnit: null,
        gallonsMilli: null,
        priceCents: null,
        loadedMiles: MILES,
        ratePerMileCents: 245,
        linehaulCents: 245 * MILES,
        fuelSurchargeCents: FUEL,
        customerName: "Test Shipper",
        stops: [],
      },
      textLines: [],
      confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((f) => [f, "high"])) as DocumentRead["confidence"],
    });
    // Counts the number pages each read sends, so the test sees it page through every load.
    let pages = 0;
    const counted = (q: Queryable): Queryable => ({
      query: <T>(sql: string, params?: Param[]) => {
        if (sql.startsWith(`${LOAD_NUMBERS_FIRST} LIMIT`) || sql.startsWith(`${LOAD_NUMBERS_NEXT} LIMIT`)) pages += 1;
        return q.query<T>(sql, params);
      },
      execute: (sql: string, params?: Param[]) => q.execute(sql, params),
    });
    const ofOne = { pageSize: 1, maxPages: 10_000 };
    const loadsOf = async (tenantId: string) =>
      (
        await admin.withTenant(tenantId, (q) =>
          q.query<{ n: number }>("SELECT count(*)::int AS n FROM loads WHERE tenant_id = current_tenant_id()"),
        )
      )[0].n;

    const a = await app.withTenant(A.tenantId, (q) => loadCandidates(counted(q), readingOf(" doc-p1"), ofOne));
    expect(a.loadMatches).toBe(1);
    expect(a.load).toMatchObject({ id: own, load_number: "DOC-P1", customer_id: A.customerId });
    expect(a.customer?.id).toBe(A.customerId);
    // Pages of one end with one empty page, so every load of the carrier was read once.
    expect(pages).toBe((await loadsOf(A.tenantId)) + 1);

    pages = 0;
    const b = await app.withTenant(B.tenantId, (q) => loadCandidates(counted(q), readingOf("DOC-P1"), ofOne));
    expect(b.loadMatches).toBe(1);
    expect(b.load).toMatchObject({ id: theirs, customer_id: B.customerId });
    expect(pages).toBe((await loadsOf(B.tenantId)) + 1);

    // A number only the other carrier holds is no match here.
    const none = await app.withTenant(A.tenantId, (q) => loadCandidates(q, readingOf("DOC-P2"), ofOne));
    expect(none.loadMatches).toBe(0);
    expect(none.load).toBeNull();
  });
});

// --- The crop before a read (migration 0067), with a fake segment call ---

const SAMPLES = path.join(process.cwd(), "public", "samples", "docs");
const LUMPER = readFileSync(path.join(SAMPLES, "br-l10327-lumper.webp"));
// The receipt in the 1,008 x 1,344 sample, a little loose, and a mask the box's size with every
// bit set, at 0, 0 as the documented example places it: 528 x 504 bits are 33,264 bytes, whole
// base85 groups, and four 0xff bytes are "|NsC0".
const PAPER = { x1: 240, y1: 352, x2: 768, y2: 856 };
const PAPER_MASK = {
  x: 0,
  y: 0,
  width: 528,
  height: 504,
  encoding: "one_bit" as const,
  payload: "|NsC0".repeat((528 * 504) / 32),
};

// The sample with a numbered description in its metadata, so each upload is its own file while
// its pixels stay the same (two nearby qualities can encode to the same bytes).
let photos = 0;
async function photo(name = "lumper.webp"): Promise<UploadFile> {
  photos += 1;
  const bytes = await sharp(LUMPER)
    .webp({ quality: 80 })
    .withExif({ IFD0: { ImageDescription: `synthetic sample ${photos}` } })
    .toBuffer();
  return { name, type: "image/webp", bytes: new Uint8Array(bytes) };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const paperAnswer = (): SegmentResult => ({
  callId: randomUUID(),
  imageWidth: 1008,
  imageHeight: 1344,
  matches: [{ box: PAPER, confidence: 0.92, mask: PAPER_MASK }],
  costNanocents: 250_000_000,
});

const paperSegment = () => vi.fn<NonNullable<CropDeps["segment"]>>(async () => paperAnswer());

const slowSegment = () =>
  vi.fn<NonNullable<CropDeps["segment"]>>(async () => {
    throw new AiError("timeout");
  });

const slowRead = () =>
  vi.fn<ReadComplete>(async () => {
    throw new AiError("timeout");
  });

// A request clock that moves only when a fake call says so.
function steadyClock() {
  let ms = 0;
  return {
    steady: () => ms,
    pass: (by: number) => {
      ms += by;
    },
  };
}

// The image the read was sent on its n-th call.
function sentImage(read: Mock<ReadComplete>, n = 0): { mime: string; bytes: Uint8Array } {
  const user = read.mock.calls[n][1].messages.find((m): m is Extract<AiMessage, { role: "user" }> => m.role === "user");
  const image = user?.attachments?.[0];
  if (!image || image.kind !== "image") throw new Error("no image sent");
  return image;
}

describe("a photo cropped to the paper before its read", () => {
  let C: Fixture;
  let D: Fixture;
  const at = (minutes: number) => () => new Date(NOW + minutes * 60_000);
  const cropRow = async (id: string) =>
    (
      await admin.withTenant(C.tenantId, (q) =>
        q.query<{
          crop_status: string;
          crop_attempts: number;
          crop_category: string | null;
          crop_hash: string | null;
          crop_length: number | null;
        }>(
          `SELECT crop_status, crop_attempts, crop_category, crop_hash, crop_length FROM documents
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [id],
        ),
      )
    )[0];

  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    C = await makeTenant(admin, `crop-c-${randomUUID().slice(0, 8)}`);
    D = await makeTenant(admin, `crop-d-${randomUUID().slice(0, 8)}`);
  });

  beforeEach(() => {
    flags.documentsEnabled = true;
    flags.documentCrop = true;
    flags.auditorRequired = false;
    frameLimit.bytes = null;
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    flags.documentsEnabled = saved.enabled;
    flags.documentCrop = saved.crop;
    flags.auditorRequired = saved.auditor;
    frameLimit.bytes = null;
    vi.restoreAllMocks();
    if (admin) {
      await dropTenant(admin, C);
      await dropTenant(admin, D);
    }
    await app?.close();
    await admin?.close();
  });

  it("reads the crop, keeps it once inside its carrier, and leaves the file as uploaded", async () => {
    const segment = paperSegment();
    const read = fakeModel(rateReading());
    const file = await photo();
    const deps = { db: app, now: clock, read: { complete: read }, crop: { segment } };
    const out = await uploadDocument(C.session, file, deps);
    if (!out.ok) throw new Error(`upload refused: ${out.error}`);
    expect(segment).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(out.view.readStatus).toBe("read");
    expect(out.view.crop).toEqual({
      status: "cropped",
      method: "quad",
      category: null,
      confidence: 920,
      quad: [
        { x: 240, y: 352 },
        { x: 768, y: 352 },
        { x: 768, y: 856 },
        { x: 240, y: 856 },
      ],
      box: { ...PAPER, width: 1008, height: 1344 },
      at: new Date(NOW).toISOString(),
    });

    // The read saw the crop: a JPEG of the paper, not the upload.
    const sent = sentImage(read);
    expect(sent.mime).toBe("image/jpeg");
    expect(sha256(sent.bytes)).not.toBe(sha256(file.bytes));
    const size = await sharp(sent.bytes).metadata();
    expect({ width: size.width, height: size.height }).toEqual({ width: 528, height: 504 });
    expect(await cropRow(out.view.id)).toEqual({
      crop_status: "cropped",
      crop_attempts: 1,
      crop_category: null,
      crop_hash: sha256(sent.bytes),
      crop_length: sent.bytes.byteLength,
    });
    const kept = await readCropFile(C.session, out.view.id, { db: app });
    expect(kept?.mime).toBe("image/jpeg");
    expect(sha256(kept?.bytes ?? new Uint8Array(0))).toBe(sha256(sent.bytes));
    // The file and its hash are as uploaded.
    const back = await readDocumentFile(C.session, out.view.id, { db: app });
    expect(back?.mime).toBe("image/webp");
    expect(sha256(back?.bytes ?? new Uint8Array(0))).toBe(sha256(file.bytes));

    // The other carrier sees no crop, through the service or in plain SQL.
    expect(await readCropFile(D.session, out.view.id, { db: app })).toBeNull();
    const seen = await app.withTenant(D.tenantId, (q) =>
      q.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM documents WHERE id = CAST($1 AS uuid) AND crop_bytes IS NOT NULL",
        [out.view.id],
      ),
    );
    expect(seen[0].n).toBe(0);

    // The same file again is the same row: no second crop, no second read.
    const dup = await uploadDocument(C.session, { ...file, name: "lumper copy.webp" }, deps);
    expect(dup).toMatchObject({ ok: true, duplicate: true, view: { id: out.view.id, crop: { status: "cropped" } } });
    expect(segment).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads the kept crop on Read again, with no second segment call", async () => {
    const segment = paperSegment();
    const slow = slowRead();
    const out = await uploadDocument(C.session, await photo(), {
      db: app,
      now: clock,
      read: { complete: slow },
      crop: { segment },
    });
    if (!out.ok) throw new Error("upload refused");
    expect(out.view).toMatchObject({ readStatus: "pending", crop: { status: "cropped" } });
    const first = sentImage(slow);
    const good = fakeModel(rateReading());
    const again = await readAgain(C.session, out.view.id, { db: app, now: at(3), read: { complete: good }, crop: { segment } });
    expect(again).toMatchObject({ ok: true, view: { readStatus: "read", crop: { status: "cropped" } } });
    expect(segment).toHaveBeenCalledTimes(1);
    expect(sentImage(good).mime).toBe("image/jpeg");
    expect(sha256(sentImage(good).bytes)).toBe(sha256(first.bytes));
  });

  it("reads the photo as uploaded when the crop has no answer, tries once more, then stops; the database holds the cap", async () => {
    const segment = slowSegment();
    const slow = slowRead();
    const file = await photo();
    const deps = (minutes: number) => ({ db: app, now: at(minutes), read: { complete: slow }, crop: { segment } });
    const out = await uploadDocument(C.session, file, deps(0));
    if (!out.ok) throw new Error("upload refused");
    const id = out.view.id;
    expect(out.view.crop).toMatchObject({ status: "unavailable", category: "timeout", method: null, quad: null });
    // A timeout may have reached the provider, so it spends the try.
    expect(await cropRow(id)).toMatchObject({ crop_status: "unavailable", crop_category: "timeout", crop_attempts: 1 });
    expect(await readAgain(C.session, id, deps(3))).toMatchObject({
      ok: true,
      view: { readStatus: "pending", crop: { status: "unavailable", category: "timeout" } },
    });
    expect(segment).toHaveBeenCalledTimes(2);
    // No tries left: the raw photo, and no call.
    expect(await readAgain(C.session, id, deps(6))).toMatchObject({
      ok: true,
      view: { readStatus: "pending", crop: { status: "unavailable", category: "timeout" } },
    });
    expect(segment).toHaveBeenCalledTimes(2);
    expect(slow).toHaveBeenCalledTimes(READ_ATTEMPTS_MAX);
    for (let n = 0; n < READ_ATTEMPTS_MAX; n++) {
      expect(sentImage(slow, n).mime).toBe("image/webp");
      expect(sha256(sentImage(slow, n).bytes)).toBe(sha256(file.bytes));
    }
    expect(await cropRow(id)).toMatchObject({ crop_status: "unavailable", crop_attempts: 2, crop_hash: null });
    expect(await readCropFile(C.session, id, { db: app })).toBeNull();
    const past = app.withTenant(C.tenantId, (q) =>
      q.execute("UPDATE documents SET crop_attempts = 3 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]),
    );
    expect(await sqlStateOf(past)).toBe("23514");
  });

  it("gives the try back when the spend cap refuses the call before it is sent, so the photo is cropped once the cap clears", async () => {
    const capped = vi.fn<NonNullable<CropDeps["segment"]>>(async () => {
      throw new AiError("cap");
    });
    const slow = slowRead();
    const out = await uploadDocument(C.session, await photo(), {
      db: app,
      now: at(0),
      read: { complete: slow },
      crop: { segment: capped },
    });
    if (!out.ok) throw new Error("upload refused");
    const id = out.view.id;
    // Still capped at the upload and at Read again: the row says why, and no try is used.
    expect(out.view.crop).toMatchObject({ status: "unavailable", category: "budget" });
    expect(await cropRow(id)).toMatchObject({ crop_status: "unavailable", crop_category: "budget", crop_attempts: 0 });
    expect(
      await readAgain(C.session, id, { db: app, now: at(3), read: { complete: slow }, crop: { segment: capped } }),
    ).toMatchObject({ ok: true, view: { readStatus: "pending", crop: { status: "unavailable", category: "budget" } } });
    expect(capped).toHaveBeenCalledTimes(2);
    expect(await cropRow(id)).toMatchObject({ crop_status: "unavailable", crop_category: "budget", crop_attempts: 0 });

    // The cap clears: the next Read again crops the photo and reads the crop.
    const segment = paperSegment();
    const good = fakeModel(rateReading());
    const again = await readAgain(C.session, id, { db: app, now: at(6), read: { complete: good }, crop: { segment } });
    expect(again).toMatchObject({ ok: true, view: { readStatus: "read", crop: { status: "cropped", method: "quad" } } });
    expect(segment).toHaveBeenCalledTimes(1);
    expect(sentImage(good).mime).toBe("image/jpeg");
    expect(await cropRow(id)).toMatchObject({ crop_status: "cropped", crop_category: null, crop_attempts: 1 });
  });

  it("skips a photo too large for the segmenter with no call, and gives the try back", async () => {
    const segment = slowSegment();
    const out = await uploadDocument(C.session, await photo(), {
      db: app,
      now: at(0),
      read: { complete: slowRead() },
      crop: { segment },
    });
    if (!out.ok) throw new Error("upload refused");
    const id = out.view.id;
    // The upload's try reached the model and timed out: one try spent.
    expect(await cropRow(id)).toMatchObject({ crop_status: "unavailable", crop_category: "timeout", crop_attempts: 1 });

    // Read again's frame is over the limit: no call, a final skip, and the count back at one.
    frameLimit.bytes = 1_000;
    const paper = paperSegment();
    const good = fakeModel(rateReading());
    const again = await readAgain(C.session, id, { db: app, now: at(3), read: { complete: good }, crop: { segment: paper } });
    expect(again).toMatchObject({
      ok: true,
      view: { readStatus: "read", crop: { status: "skipped", category: "too_large", box: null, confidence: null } },
    });
    expect(paper).not.toHaveBeenCalled();
    expect(segment).toHaveBeenCalledTimes(1);
    expect(await cropRow(id)).toMatchObject({
      crop_status: "skipped",
      crop_category: "too_large",
      crop_attempts: 1,
      crop_hash: null,
      crop_length: null,
    });
    expect(sentImage(good).mime).toBe("image/webp");
  });

  it("gives the read its full 25 seconds while the crop is off", async () => {
    flags.documentCrop = false;
    const read = fakeModel(rateReading());
    const out = await uploadDocument(C.session, await photo(), {
      db: app,
      now: clock,
      read: { complete: read },
      steady: steadyClock().steady,
    });
    expect(out).toMatchObject({ ok: true, view: { readStatus: "read" } });
    expect(read.mock.calls[0][1].timeoutMs).toBe(READ_TIMEOUT_MS);
    expect(READ_TIMEOUT_MS).toBe(25_000);
  });

  it("gives the read only what a 9 second crop leaves of the request", async () => {
    const { steady, pass } = steadyClock();
    const segment = vi.fn<NonNullable<CropDeps["segment"]>>(async () => {
      pass(9_000);
      return paperAnswer();
    });
    const read = fakeModel(rateReading());
    const out = await uploadDocument(C.session, await photo(), {
      db: app,
      now: clock,
      read: { complete: read },
      crop: { segment },
      steady,
    });
    expect(out).toMatchObject({ ok: true, view: { readStatus: "read", crop: { status: "cropped" } } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][1].timeoutMs).toBe(16_000);
    expect(sentImage(read).mime).toBe("image/jpeg");
  });

  it("starts no read when the crop leaves under 10 seconds, and Read again reads the kept crop in full time", async () => {
    const { steady, pass } = steadyClock();
    const segment = vi.fn<NonNullable<CropDeps["segment"]>>(async () => {
      pass(15_001);
      return paperAnswer();
    });
    const read = fakeModel(rateReading());
    const out = await uploadDocument(C.session, await photo(), {
      db: app,
      now: clock,
      read: { complete: read },
      crop: { segment },
      steady,
    });
    if (!out.ok) throw new Error("upload refused");
    const id = out.view.id;
    // No read call: the row stays pending with its crop kept, and the log names a fixed category.
    expect(read).not.toHaveBeenCalled();
    expect(out.view).toMatchObject({ readStatus: "pending", crop: { status: "cropped" } });
    expect(await cropRow(id)).toMatchObject({ crop_status: "cropped", crop_attempts: 1 });
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(`documents: read ${id} not started category=deadline elapsed=15001`);

    const again = await readAgain(C.session, id, {
      db: app,
      now: at(3),
      read: { complete: read },
      crop: { segment },
      steady: steadyClock().steady,
    });
    expect(again).toMatchObject({ ok: true, view: { readStatus: "read", crop: { status: "cropped" } } });
    expect(segment).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][1].timeoutMs).toBe(READ_TIMEOUT_MS);
    expect(sentImage(read).mime).toBe("image/jpeg");
  });

  it("gives a try back only under that try's own lease, never a newer one", async () => {
    flags.documentCrop = false;
    const out = await uploadDocument(C.session, await photo(), { db: app, now: clock, read: { complete: slowRead() } });
    if (!out.ok) throw new Error("upload refused");
    const id = out.view.id;
    const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
    const inTenant = <T>(fn: (q: Queryable) => Promise<T>) => app.withTenant(C.tenantId, fn);
    const claim = async (minutes: number) => ({ attempt: (await inTenant((q) => claimCrop(q, id, iso(minutes)))) ?? 0, atIso: iso(minutes) });
    const budget = { status: "unavailable", category: "budget", refund: true } as const;

    // Worker A's try at minute 1 is refused before its call and given back; B's try at minute 2
    // takes the same count, so only the time tells them apart, and A's lease no longer names it.
    const a = await claim(1);
    expect(a.attempt).toBe(1);
    expect(await inTenant((q) => finishCrop(q, id, a, budget))).toBe(1);
    expect(await cropRow(id)).toMatchObject({ crop_status: "unavailable", crop_category: "budget", crop_attempts: 0 });
    const b = await claim(2);
    expect(b.attempt).toBe(1);
    expect(await inTenant((q) => finishCrop(q, id, a, budget))).toBe(0);
    expect(await cropRow(id)).toMatchObject({ crop_status: "cropping", crop_attempts: 1 });

    // B stalls and C claims the last try: B, back late with a refusal, gives nothing back.
    expect(await inTenant((q) => reclaimStalledCrop(q, id, iso(5)))).toBe(1);
    const c = await claim(6);
    expect(c.attempt).toBe(2);
    expect(await inTenant((q) => finishCrop(q, id, b, budget))).toBe(0);
    expect(await cropRow(id)).toMatchObject({ crop_status: "cropping", crop_attempts: 2 });
    // C's timeout ends its try and keeps it spent: no try is left.
    const timeout = { status: "unavailable", category: "timeout", refund: false } as const;
    expect(await inTenant((q) => finishCrop(q, id, c, timeout))).toBe(1);
    expect(await cropRow(id)).toMatchObject({ crop_status: "unavailable", crop_category: "timeout", crop_attempts: 2 });
    expect(await inTenant((q) => claimCrop(q, id, iso(9)))).toBeNull();
  });

  it("leaves a running crop alone until it is stalled, then ends it stalled with no call", async () => {
    flags.documentCrop = false;
    const slow = slowRead();
    const out = await uploadDocument(C.session, await photo(), { db: app, now: clock, read: { complete: slow } });
    if (!out.ok) throw new Error("upload refused");
    const id = out.view.id;
    expect(out.view.crop.status).toBe("none");
    // The last try, started at minute 2 and never ended (its server stopped mid-call).
    await admin.withTenant(C.tenantId, (q) =>
      q.execute(
        `UPDATE documents SET crop_status = 'cropping', crop_attempts = 2, crop_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id, new Date(NOW + 2 * 60_000).toISOString()],
      ),
    );
    flags.documentCrop = true;
    const segment = paperSegment();
    const deps = (minutes: number) => ({ db: app, now: at(minutes), read: { complete: slow }, crop: { segment } });
    // A minute old at minute 3: still running, so the read takes the photo as uploaded.
    expect(await readAgain(C.session, id, deps(3))).toMatchObject({ ok: true, view: { crop: { status: "cropping" } } });
    expect(await cropRow(id)).toMatchObject({ crop_status: "cropping", crop_attempts: 2 });
    // Four minutes old at minute 6: stalled, and no try is left.
    expect(await readAgain(C.session, id, deps(6))).toMatchObject({
      ok: true,
      view: { crop: { status: "unavailable", category: "stalled" } },
    });
    expect(segment).not.toHaveBeenCalled();
    expect(slow).toHaveBeenCalledTimes(READ_ATTEMPTS_MAX);
    for (let n = 0; n < READ_ATTEMPTS_MAX; n++) expect(sentImage(slow, n).mime).toBe("image/webp");
  });

  it("makes no segment call and reads the photo as uploaded while the switch is off", async () => {
    flags.documentCrop = false;
    const segment = paperSegment();
    const read = fakeModel(rateReading());
    const file = await photo();
    const out = await uploadDocument(C.session, file, { db: app, now: clock, read: { complete: read }, crop: { segment } });
    if (!out.ok) throw new Error("upload refused");
    expect(segment).not.toHaveBeenCalled();
    expect(out.view.crop).toEqual({
      status: "none",
      method: null,
      category: null,
      confidence: null,
      quad: null,
      box: null,
      at: null,
    });
    expect(sentImage(read).mime).toBe("image/webp");
    expect(sha256(sentImage(read).bytes)).toBe(sha256(file.bytes));
    expect(await readCropFile(C.session, out.view.id, { db: app })).toBeNull();
  });
});
