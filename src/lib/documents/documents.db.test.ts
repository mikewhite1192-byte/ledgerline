import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiResult } from "../ai";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal } from "../proposals/execute";
import type { ReadComplete } from "./read";
import { getDocument, listDocuments, readDocumentFile, uploadDocument, type UploadFile } from "./service";
import { CONFIDENCE_FIELDS } from "./types";

// Documents against the real database, as the app's role, with a fake model call (no network, no
// model). A document stays inside its carrier, bytes included; the same file twice is one row read
// once; the app login can neither delete a document nor change its file; a capped read keeps the
// file viewable; and approving a rate fill writes the load's rate once. Only this file's two
// tenants are made, and they are removed after, whichever way the tests end.

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);
const saved = { enabled: flags.documentsEnabled, crop: flags.documentCrop, auditor: flags.auditorRequired };

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
      }) satisfies AiResult,
  );
}

const loadRate = async () =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ linehaul_cents: string | number | null; fuel_surcharge_cents: string | number }>(
        "SELECT linehaul_cents, fuel_surcharge_cents FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
        [loadId],
      ),
    )
  )[0];

// A waiting load_rate_fill proposal with the conversation, turn and gateway decision a real one
// hangs from, written by the admin login so created_at and the auditor's pass can be set (only a
// pass goes through without the second confirm).
async function addRateProposal(linehaulCents: number): Promise<string> {
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - HOUR).toISOString();
  const args = { loadId, linehaulCents, fuelSurchargeCents: FUEL, ratePerMileCents: 245 };
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
        loadId,
        JSON.stringify(args),
        decision,
        `load_rate_fill:${loadId}:${String(linehaulCents).padStart(64, "0")}`,
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
    loadId = randomUUID();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
           dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles, linehaul_cents,
           fuel_surcharge_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'delivered',
           'Springfield', 'IL', 'Fairview', 'OH', CAST('2026-10-28' AS date), CAST('2026-10-29' AS date),
           CAST('2026-10-29T18:00:00Z' AS timestamptz), $5, NULL, $6)`,
        [loadId, LOAD_NUMBER, A.customerId, A.driverId, MILES, FUEL],
      ),
    );
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
    expect(transcription).toEqual([{ kind: "document", source: "upload", body_text: `SAMPLE RATE CONFIRMATION\nLOAD ${LOAD_NUMBER}` }]);

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
});
