import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import type { Param, Queryable } from "../db";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { clearTenantAgent } from "../seed/run";
import { approveNote, rejectNote } from "./decide";
import { deliverNoteEmail, type EmailMessage } from "./deliver";
import { draftDriverNotes, type CompleteFn } from "./draft";
import { listNotePeriods, readDriverView, readPeriodNotes } from "./view";

// Driver notes against the real database, as the app's role, with a fake model. Each settled
// settlement gets at most one note however many passes run; a note that fails the check keeps no
// text and is never approvable; approval delivers to the driver view and never edits the text;
// a note whose paystub changed after drafting is neither approved, shown nor emailed; a note can
// only be inserted as a bare reservation and only names a model call of its own carrier; email
// stays refused (and logged as "would send") until its switch, the allowlist and a sender all
// agree, sends at most once, and never goes for a period that ended before its start date; the
// period's cap stops drafting with no call; a call turned down before any request leaves the note
// waiting, never refused; and another carrier sees none of it. Only this file's tenants are made, and they are removed after.

const saved = { ...flags, driverNoteLimits: { ...flags.driverNoteLimits }, driverNotesEmailAllowlist: [...flags.driverNotesEmailAllowlist] };
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const clock = () => new Date(NOW);
const deadline = () => new Date(NOW + 20_000);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let slugA: string;
const periodId = randomUUID();
const previousPeriodId = randomUUID();
const settlement1 = randomUUID();
const settlement2 = randomUUID();

// What the fake model saw, and how it answers: the note copies the net pay from the pack it was
// given, so a good answer passes the check on its own numbers.
let seen: AiRequest[] = [];
function netOf(request: AiRequest): string {
  const user = request.messages.find((m) => m.role === "user")?.content ?? "";
  const m = /Net pay: (\$[\d,]+\.\d{2})/.exec(user);
  if (!m) throw new Error("the pack has no net pay");
  return m[1];
}
// The call's row in the model ledger, as complete() writes it before it returns the call's id: a
// note names the call that wrote it, so the id must be a real call of the same carrier. It costs
// nothing, so the period's cap counts only what a test charges on purpose.
async function ledgerRow(q: Queryable, id: string, purpose: string, traceId: string | null) {
  await q.execute(
    `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, trace_id, status,
       reserved_nanocents, cost_nanocents)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'spark', 'meta', 'test-model', 'text', $2,
       CAST($3 AS uuid), 'ok', 0, 0)`,
    [id, purpose, traceId],
  );
}
async function result(
  request: AiRequest,
  session: Session,
  text: string,
  status: AiResult["status"] = "ok",
): Promise<AiResult> {
  const callId = randomUUID();
  await admin.withTenant(session.tenantId, (q) => ledgerRow(q, callId, request.purpose, request.traceId ?? null));
  return {
    callId,
    status,
    text,
    toolCalls: [],
    usage: { input: 0, cached: 0, output: 0, reasoning: 0 },
    costNanocents: 0,
    upstreamId: null,
    replay: [],
  };
}
const goodModel: CompleteFn = async (_target, request, session) => {
  seen.push(request);
  const spanish = request.messages.some((m) => m.content.includes("Language: Spanish"));
  const net = netOf(request);
  const body = spanish ? `Hola, su pago neto es ${net} [línea 1].` : `Hi, your net pay is ${net} [line 1].`;
  return result(request, session, JSON.stringify({ language: spanish ? "Spanish" : "English", body, cited_seqs: [1] }));
};

const draft = (complete: CompleteFn = goodModel, at = deadline()) =>
  draftDriverNotes(A.session, periodId, at, { db: app, complete, clock });

async function notesOf(f: Fixture) {
  return admin.withTenant(f.tenantId, (q) =>
    q.query<{
      id: string;
      settlement_id: string;
      status: string;
      language: string;
      body: string | null;
      refusal_category: string | null;
      channel: string | null;
      delivered_at: string | null;
      decided_by: string | null;
    }>(
      `SELECT CAST(n.id AS text) AS id, CAST(n.settlement_id AS text) AS settlement_id, n.status, n.language,
              n.body, n.refusal_category, n.channel, CAST(n.delivered_at AS text) AS delivered_at, n.decided_by
         FROM driver_notes n JOIN drivers d ON d.tenant_id = n.tenant_id AND d.id = n.driver_id
        WHERE n.tenant_id = current_tenant_id() ORDER BY d.code`,
    ),
  );
}

// Corrects both settlements after their notes were drafted: fuel and net pay on the first, the
// load amount on the second. setPay(15000, 110000, 90000) puts the seeded paystubs back.
const setPay = (fuelCents: number, net1Cents: number, load2Cents: number) =>
  admin.withTenant(A.tenantId, async (q) => {
    await q.execute(
      `UPDATE settlements SET deductions_cents = $2, net_cents = $3
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [settlement1, fuelCents, net1Cents],
    );
    await q.execute(
      `UPDATE settlement_lines SET amount_cents = $2
        WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid) AND seq = 2`,
      [settlement1, -fuelCents],
    );
    await q.execute(
      `UPDATE settlements SET gross_cents = $2, net_cents = $2
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [settlement2, load2Cents],
    );
    await q.execute(
      `UPDATE settlement_lines SET amount_cents = $2
        WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid) AND seq = 1`,
      [settlement2, load2Cents],
    );
  });

async function seedPay(f: Fixture) {
  const payConfig = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 0, 0, 0, 0)`,
      [payConfig],
    );
    await q.execute(
      `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status) VALUES
         (CAST($1 AS uuid), current_tenant_id(), CAST('2026-10-26' AS date), CAST('2026-11-01' AS date), 'approved'),
         (CAST($2 AS uuid), current_tenant_id(), CAST('2026-10-19' AS date), CAST('2026-10-25' AS date), 'paid')`,
      [periodId, previousPeriodId],
    );
    const settlements: [string, string, string, string, number, number, number][] = [
      // id, period, driver, status, gross, deductions, net
      [settlement1, periodId, f.driverId, "approved", 125000, 15000, 110000],
      [settlement2, periodId, f.otherDriverId, "approved", 90000, 0, 90000],
      [randomUUID(), previousPeriodId, f.driverId, "paid", 100000, 0, 100000],
    ];
    for (const [id, period, driver, status, gross, deductions, net] of settlements) {
      await q.execute(
        `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
           deductions_cents, net_cents, paid_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5,
           $6, $7, $8, CASE WHEN $5 = 'paid' THEN CAST('2026-10-31T15:00:00Z' AS timestamptz) END)`,
        [id, period, driver, payConfig, status, gross, deductions, net],
      );
      await q.execute(
        `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources, meta)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'load_pay', 'Load L-1042', $3,
           CAST('[{"table":"loads","id":"L-1042"}]' AS jsonb), CAST('{"loadedMiles":900}' AS jsonb))`,
        [randomUUID(), id, gross],
      );
      if (deductions > 0) {
        await q.execute(
          `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources, meta)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 2, 'fuel', 'Fuel, Oct 28', $3,
             CAST('[]' AS jsonb), NULL)`,
          [randomUUID(), id, -deductions],
        );
      }
    }
    await q.execute(
      "UPDATE drivers SET preferred_language = 'es' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [f.otherDriverId],
    );
  });
}

describe("driver notes", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    slugA = `notes-${randomUUID().slice(0, 8)}`;
    A = await makeTenant(admin, slugA);
    B = await makeTenant(admin, `notes-${randomUUID().slice(0, 8)}`);
    await seedPay(A);
  });

  beforeEach(async () => {
    Object.assign(flags, saved, {
      driverNoteLimits: { ...saved.driverNoteLimits },
      driverNotesEmailAllowlist: [],
      driverNotesEnabled: true,
      aiEnabled: true,
    });
    seen = [];
    await admin.withTenant(A.tenantId, async (q) => {
      await q.execute("DELETE FROM driver_notes WHERE tenant_id = current_tenant_id()");
      await q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id()");
    });
  });

  afterEach(() => {
    Object.assign(flags, saved, {
      driverNoteLimits: { ...saved.driverNoteLimits },
      driverNotesEmailAllowlist: [...saved.driverNotesEmailAllowlist],
    });
  });

  afterAll(async () => {
    Object.assign(flags, saved);
    if (A) {
      // Notes first: each names its model call.
      await clearTenantAgent(admin, A.tenantId);
      await admin.withTenant(A.tenantId, (q) =>
        q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id()"),
      );
    }
    await dropTenant(admin, A);
    await dropTenant(admin, B);
    await app?.close();
    await admin?.close();
  });

  it("drafts each settled settlement once, in the driver's language, however many passes run", async () => {
    const first = await draft();
    expect(first).toMatchObject({ ok: true, total: 2, drafted: 2, written: 2, missing: 0, stoppedBy: null, more: false });
    const second = await draft();
    expect(second).toMatchObject({ ok: true, total: 2, drafted: 2, written: 0 });
    expect(seen).toHaveLength(2);
    const notes = await notesOf(A);
    expect(notes.map((n) => [n.status, n.language])).toEqual([
      ["drafted", "en"],
      ["drafted", "es"],
    ]);
    expect(notes[0].body).toBe("Hi, your net pay is $1,100.00 [line 1].");
    expect(notes[1].body).toBe("Hola, su pago neto es $900.00 [línea 1].");
    // The model saw the first name and last period's pay, never an id or an email.
    const pack = seen[0].messages.map((m) => m.content).join("\n");
    expect(pack).toContain("Driver first name: Test");
    expect(pack).toContain("Last period's net pay: $1,000.00");
    expect(pack).toContain("Change from last period: up $100.00");
    expect(pack).not.toContain(settlement1);
    expect(pack).not.toContain("@");
  });

  it("stores a note that fails the check as refused, with no text, and never approvable", async () => {
    const wrong: CompleteFn = async (_target, request, session) =>
      result(request, session, JSON.stringify({ language: "English", body: "Hi, your net pay is $9,999.99.", cited_seqs: [] }));
    expect(await draft(wrong)).toMatchObject({ ok: true, refused: 2, drafted: 0 });
    const notes = await notesOf(A);
    expect(notes[0]).toMatchObject({ status: "refused", refusal_category: "number_mismatch", body: null });
    // The Spanish driver's note failed on language before numbers.
    expect(notes[1]).toMatchObject({ status: "refused", refusal_category: "language", body: null });
    expect(await approveNote(A.session, notes[0].id, { db: app, clock })).toEqual({
      ok: false,
      category: "not_approvable",
    });
    // The driver sees the short pay line instead, in their language.
    const view = await app.withTenant(A.tenantId, (q) => readDriverView(q, settlement2));
    expect(view?.message).toEqual({
      kind: "fallback",
      language: "es",
      body: "Su pago del 26 de octubre al 1 de noviembre de 2026 es $900.00. Su recibo de pago muestra cada línea.",
    });
  });

  it("stops at the first model failure, keeping only its category", async () => {
    const failing: CompleteFn = async () => {
      throw new AiError("unavailable", 503);
    };
    expect(await draft(failing)).toMatchObject({ ok: true, refused: 1, missing: 1, stoppedBy: "model", written: 1 });
    const notes = await notesOf(A);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ status: "refused", refusal_category: "unavailable", body: null });
    // The next pass drafts the one left.
    expect(await draft()).toMatchObject({ ok: true, drafted: 1, refused: 1, missing: 0 });
  });

  it.each(["disabled", "not_configured", "too_expensive", "cap"] as const)(
    "puts the note back to wait when its call is turned down before any request goes out (%s)",
    async (category) => {
      let calls = 0;
      const turnedDown: CompleteFn = async () => {
        calls += 1;
        throw new AiError(category);
      };
      expect(await draft(turnedDown)).toMatchObject({
        ok: true,
        overCap: 1,
        refused: 0,
        missing: 1,
        written: 0,
        stoppedBy: "model",
      });
      expect(calls).toBe(1);
      const notes = await notesOf(A);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ status: "over_cap", refusal_category: null, body: null });
      // The next pass drafts it with the one never started.
      expect(await draft()).toMatchObject({ ok: true, drafted: 2, overCap: 0, refused: 0 });
    },
  );

  it.each([
    "rate_limited",
    "unavailable",
    "bad_request",
    "auth",
    "billing",
    "too_long",
    "network",
    "timeout",
    "unknown",
  ] as const)("keeps the note refused when its call failed after the request went out (%s)", async (category) => {
    const failing: CompleteFn = async () => {
      throw new AiError(category);
    };
    expect(await draft(failing)).toMatchObject({ ok: true, refused: 1, overCap: 0, written: 1, stoppedBy: "model" });
    expect((await notesOf(A))[0]).toMatchObject({ status: "refused", refusal_category: category, body: null });
    // Final: the next pass drafts only the one never started.
    expect(await draft()).toMatchObject({ ok: true, drafted: 1, refused: 1, overCap: 0 });
  });

  it("lets a drafting note go back to waiting only while it names no model call", async () => {
    const noteId = randomUUID();
    const callA = randomUUID();
    await admin.withTenant(A.tenantId, (q) => ledgerRow(q, callA, "driver_note", null));
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO driver_notes (id, tenant_id, settlement_id, driver_id, period_id, language, status, trace_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), 'en',
           'drafting', CAST($5 AS uuid))`,
        [noteId, settlement1, A.driverId, periodId, randomUUID()],
      ),
    );
    const set = (assignments: string, params: Param[] = []) =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `UPDATE driver_notes SET ${assignments} WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [noteId, ...params],
        ),
      );
    // Naming a call on the way back is refused; the bare step back is allowed.
    expect(await sqlStateOf(set("status = 'over_cap', model_call_id = CAST($2 AS uuid)", [callA]))).toBe("23514");
    expect(await sqlStateOf(set("status = 'over_cap'"))).toBe("no error");
    expect(await sqlStateOf(set("status = 'drafting'"))).toBe("no error");
    // Once refused with its call, the note never waits again.
    expect(
      await sqlStateOf(set("status = 'refused', refusal_category = 'incomplete', model_call_id = CAST($2 AS uuid)", [callA])),
    ).toBe("no error");
    expect(await sqlStateOf(set("status = 'over_cap', refusal_category = NULL, model_call_id = NULL"))).toBe("23514");
    expect((await notesOf(A))[0]).toMatchObject({ status: "refused", refusal_category: "incomplete" });
  });

  it("stores an answer cut off by the output budget as incomplete, with no check record", async () => {
    const cut: CompleteFn = async (_target, request, session) =>
      result(request, session, '{"language": "English", "body": "Hi, your', "incomplete");
    expect(await draft(cut)).toMatchObject({ ok: true, refused: 2, drafted: 0 });
    const rows = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ status: string; refusal_category: string | null; body: string | null; verification: unknown }>(
        "SELECT status, refusal_category, body, verification FROM driver_notes WHERE tenant_id = current_tenant_id()",
      ),
    );
    expect(rows).toEqual([
      { status: "refused", refusal_category: "incomplete", body: null, verification: null },
      { status: "refused", refusal_category: "incomplete", body: null, verification: null },
    ]);
  });

  it("starts no note that cannot finish before the slice ends", async () => {
    expect(await draft(goodModel, new Date(NOW + 5_000))).toMatchObject({
      ok: true,
      written: 0,
      missing: 2,
      stoppedBy: "deadline",
      more: true,
    });
    expect(seen).toHaveLength(0);
  });

  it("marks the rest over the cap with no call, and drafts them once the cap allows", async () => {
    // Each call settles 3 cents in the ledger; a 5-cent period cap fits one note.
    flags.driverNoteLimits = { ...flags.driverNoteLimits, maxNoteCents: 3, maxBatchCents: 5 };
    const charging: CompleteFn = async (target, request, session) => {
      await admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, trace_id, status,
             reserved_nanocents, cost_nanocents)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'spark', 'meta', 'test-model', 'text', $2,
             CAST($3 AS uuid), 'ok', 3000000000, 3000000000)`,
          [randomUUID(), request.purpose, request.traceId ?? null],
        ),
      );
      return goodModel(target, request, session);
    };
    expect(await draft(charging)).toMatchObject({ ok: true, drafted: 1, overCap: 1, stoppedBy: "cap" });
    expect(seen).toHaveLength(1);
    expect((await notesOf(A)).map((n) => n.status)).toEqual(["drafted", "over_cap"]);

    // A cap with no room at all makes no call.
    seen = [];
    flags.driverNoteLimits = { ...flags.driverNoteLimits, maxBatchCents: 2 };
    expect(await draft(charging)).toMatchObject({ ok: true, overCap: 1, stoppedBy: "cap", written: 0 });
    expect(seen).toHaveLength(0);

    // Raised: the over-cap note is drafted on the next pass.
    flags.driverNoteLimits = { ...flags.driverNoteLimits, maxBatchCents: 60 };
    expect(await draft(charging)).toMatchObject({ ok: true, drafted: 2, overCap: 0 });
    expect((await notesOf(A)).map((n) => n.status)).toEqual(["drafted", "drafted"]);
  });

  it("marks a note left drafting past its lease as interrupted, never approvable", async () => {
    const stale = new Date(NOW - 120_000).toISOString();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO driver_notes (id, tenant_id, settlement_id, driver_id, period_id, language, status, trace_id,
           created_at, updated_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), 'en',
           'drafting', CAST($5 AS uuid), CAST($6 AS timestamptz), CAST($6 AS timestamptz))`,
        [randomUUID(), settlement1, A.driverId, periodId, randomUUID(), stale],
      ),
    );
    expect(await draft()).toMatchObject({ ok: true, refused: 1, drafted: 1 });
    expect((await notesOf(A))[0]).toMatchObject({ status: "refused", refusal_category: "interrupted" });
  });

  it("approves a drafted note into the driver view once, and rejects another", async () => {
    await draft();
    const [n1, n2] = await notesOf(A);
    expect(await approveNote(A.session, n1.id, { db: app, clock })).toEqual({ ok: true });
    expect(await approveNote(A.session, n1.id, { db: app, clock })).toEqual({ ok: false, category: "already_decided" });
    expect(await rejectNote(A.session, n2.id, { db: app, clock })).toEqual({ ok: true });
    expect(await approveNote(A.session, n2.id, { db: app, clock })).toEqual({ ok: false, category: "already_decided" });
    expect(await approveNote(A.session, randomUUID(), { db: app, clock })).toEqual({ ok: false, category: "not_found" });
    const [a1, a2] = await notesOf(A);
    expect(a1).toMatchObject({ status: "approved", channel: "driver_view", decided_by: A.session.sub });
    expect(a1.delivered_at).not.toBeNull();
    expect(a2).toMatchObject({ status: "rejected", channel: null, delivered_at: null });

    const view = await app.withTenant(A.tenantId, (q) => readDriverView(q, settlement1));
    expect(view?.message).toEqual({ kind: "note", body: "Hi, your net pay is $1,100.00 [line 1].", language: "en" });
    const board = await app.withTenant(A.tenantId, (q) => readPeriodNotes(q, periodId));
    expect(board?.cards.map((c) => [c.driverCode, c.note?.status])).toEqual([
      ["DRV-1", "approved"],
      ["DRV-2", "rejected"],
    ]);
    expect(board?.cards[0].citedLines).toEqual([{ seq: 1, label: "Load L-1042" }]);
    const periods = await app.withTenant(A.tenantId, (q) => listNotePeriods(q));
    expect(periods.map((p) => [p.id, p.settled, p.drafted, p.approved, p.waiting])).toEqual([
      [periodId, 2, 2, 1, 0],
      [previousPeriodId, 1, 0, 0, 0],
    ]);
  });

  it("checks a note again on its settlement as it is now, at approval and in the driver view", async () => {
    await draft();
    const [n1, n2] = await notesOf(A);
    expect(await approveNote(A.session, n1.id, { db: app, clock })).toEqual({ ok: true });
    // Both settlements are corrected after their notes were drafted: more fuel on the first, a new
    // load amount on the second. The originals are put back after, for the tests that follow.
    await setPay(20000, 105000, 95000);
    try {
      // The drafted note's $900.00 is no longer on its paystub: not approvable, and nothing changes.
      expect(await approveNote(A.session, n2.id, { db: app, clock })).toEqual({ ok: false, category: "not_approvable" });
      expect((await notesOf(A))[1]).toMatchObject({ status: "drafted", decided_by: null, channel: null });
      // The approved note's $1,100.00 is gone too: the driver sees the short pay line, at the new net.
      const view = await app.withTenant(A.tenantId, (q) => readDriverView(q, settlement1));
      expect(view?.message).toEqual({
        kind: "fallback",
        language: "en",
        body: "Your pay for Oct 26 to Nov 1, 2026 is $1,050.00. Your paystub lists every line.",
      });
    } finally {
      await setPay(15000, 110000, 90000);
    }
    // With the paystubs back as they were, the notes match again.
    expect(await approveNote(A.session, n2.id, { db: app, clock })).toEqual({ ok: true });
    const view = await app.withTenant(A.tenantId, (q) => readDriverView(q, settlement1));
    expect(view?.message).toEqual({ kind: "note", body: "Hi, your net pay is $1,100.00 [line 1].", language: "en" });
  });

  it("keeps email refused and logged as would send until the switch, the allowlist and a sender agree", async () => {
    await draft();
    const [n1, n2] = await notesOf(A);
    await approveNote(A.session, n1.id, { db: app, clock });
    const lines: string[] = [];
    const sent: EmailMessage[] = [];
    const send = async (m: EmailMessage) => {
      sent.push(m);
    };
    const deliver = (id: string, withSender = true) =>
      deliverNoteEmail(A.session, id, { db: app, log: (l) => lines.push(l), clock, send: withSender ? send : undefined });

    expect(await deliver(n1.id)).toEqual({ sent: false, category: "disabled" });
    expect(lines).toEqual([`would send note ${n1.id} (disabled)`]);
    flags.driverNotesEmailEnabled = true;
    expect(await deliver(n1.id)).toEqual({ sent: false, category: "not_allowlisted" });
    flags.driverNotesEmailAllowlist = [`DRV-1@${slugA}.example`];
    expect(await deliver(n1.id, false)).toEqual({ sent: false, category: "no_sender" });
    expect(await deliver(n2.id)).toEqual({ sent: false, category: "not_approved" });
    expect(sent).toHaveLength(0);
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("@");

    expect(await deliver(n1.id)).toEqual({ sent: true });
    expect(await deliver(n1.id)).toEqual({ sent: false, category: "already_sent" });
    expect(sent).toEqual([
      {
        noteId: n1.id,
        to: `drv-1@${slugA}.example`,
        subject: "Your pay for Oct 26 to Nov 1, 2026",
        text: "Hi, your net pay is $1,100.00 [line 1].",
      },
    ]);
    expect((await notesOf(A))[0].channel).toBe("email");
  });

  it("never sends twice after a send that failed", async () => {
    await draft();
    const [n1] = await notesOf(A);
    await approveNote(A.session, n1.id, { db: app, clock });
    flags.driverNotesEmailEnabled = true;
    flags.driverNotesEmailAllowlist = [`drv-1@${slugA}.example`];
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("mail down");
    };
    const deliver = () => deliverNoteEmail(A.session, n1.id, { db: app, log: () => undefined, clock, send: failing });
    // The provider may have taken it before the error: unknown, and the reservation stays.
    expect(await deliver()).toEqual({ sent: false, category: "unknown" });
    expect((await notesOf(A))[0].channel).toBe("email");
    expect(await deliver()).toEqual({ sent: false, category: "already_sent" });
    expect(calls).toBe(1);
  });

  it("emails nothing for an approved note whose paystub changed after approval", async () => {
    await draft();
    const [n1] = await notesOf(A);
    expect(await approveNote(A.session, n1.id, { db: app, clock })).toEqual({ ok: true });
    flags.driverNotesEmailEnabled = true;
    flags.driverNotesEmailAllowlist = [`drv-1@${slugA}.example`];
    const sent: EmailMessage[] = [];
    const deliver = () =>
      deliverNoteEmail(A.session, n1.id, {
        db: app,
        log: () => undefined,
        clock,
        send: async (m) => {
          sent.push(m);
        },
      });
    await setPay(20000, 105000, 95000);
    try {
      // The note's $1,100.00 is no longer the net pay: refused, nothing reserved, nothing sent.
      expect(await deliver()).toEqual({ sent: false, category: "stale" });
      expect(sent).toEqual([]);
      expect((await notesOf(A))[0].channel).toBe("driver_view");
    } finally {
      await setPay(15000, 110000, 90000);
    }
    // With the paystub back as it was, the note matches again and goes out once.
    expect(await deliver()).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
  });

  it("emails only a note whose period ends on or after the start date, leaving older ones on the driver view", async () => {
    flags.driverNotesEmailEnabled = true;
    flags.driverNotesEmailAllowlist = [`drv-1@${slugA}.example`];
    const sent: EmailMessage[] = [];
    const deliver = (id: string) =>
      deliverNoteEmail(A.session, id, {
        db: app,
        log: () => undefined,
        clock,
        send: async (m) => {
          sent.push(m);
        },
      });
    const channelOf = async (id: string) => (await notesOf(A)).find((n) => n.id === id)?.channel;

    // Last week's period ended Oct 25, before the start date (Oct 27): approved and shown, never
    // emailed, and nothing reserved.
    expect(
      await draftDriverNotes(A.session, previousPeriodId, deadline(), { db: app, complete: goodModel, clock }),
    ).toMatchObject({ ok: true, drafted: 1 });
    const old = (await notesOf(A)).find((n) => n.settlement_id !== settlement1 && n.settlement_id !== settlement2);
    if (!old) throw new Error("last week's note was not drafted");
    expect(await approveNote(A.session, old.id, { db: app, clock })).toEqual({ ok: true });
    expect(await deliver(old.id)).toEqual({ sent: false, category: "before_start" });
    expect(await channelOf(old.id)).toBe("driver_view");
    const view = await app.withTenant(A.tenantId, (q) => readDriverView(q, old.settlement_id));
    expect(view?.message).toEqual({ kind: "note", body: "Hi, your net pay is $1,000.00 [line 1].", language: "en" });

    // This week's period ends Nov 1: refused with the start a day after it, sent with the start on it.
    await draft();
    const n1 = (await notesOf(A)).find((n) => n.settlement_id === settlement1);
    if (!n1) throw new Error("this week's note was not drafted");
    expect(await approveNote(A.session, n1.id, { db: app, clock })).toEqual({ ok: true });
    flags.driverNotesEmailFrom = "2026-11-02";
    expect(await deliver(n1.id)).toEqual({ sent: false, category: "before_start" });
    expect(await channelOf(n1.id)).toBe("driver_view");
    expect(sent).toEqual([]);
    flags.driverNotesEmailFrom = "2026-11-01";
    expect(await deliver(n1.id)).toEqual({ sent: true });
    expect(sent.map((m) => m.noteId)).toEqual([n1.id]);
    expect(await channelOf(n1.id)).toBe("email");
  });

  it("ties a note's model call to a call of the same carrier", async () => {
    const noteId = randomUUID();
    const callA = randomUUID();
    const callB = randomUUID();
    await admin.withTenant(A.tenantId, (q) => ledgerRow(q, callA, "driver_note", null));
    await admin.withTenant(B.tenantId, (q) => ledgerRow(q, callB, "driver_note", null));
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO driver_notes (id, tenant_id, settlement_id, driver_id, period_id, language, status, trace_id)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), 'en',
           'drafting', CAST($5 AS uuid))`,
        [noteId, settlement1, A.driverId, periodId, randomUUID()],
      ),
    );
    // Even the admin login, which row security does not hold, cannot point a note at another
    // carrier's call or at no call at all.
    const finish = (callId: string) =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `UPDATE driver_notes SET status = 'refused', refusal_category = 'incomplete',
                  model_call_id = CAST($2 AS uuid)
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [noteId, callId],
        ),
      );
    expect(await sqlStateOf(finish(callB))).toBe("23503");
    expect(await sqlStateOf(finish(randomUUID()))).toBe("23503");
    expect(await sqlStateOf(finish(callA))).toBe("no error");
  });

  it("refuses any change to an approved note's text, even from the admin login", async () => {
    await draft();
    const [n1] = await notesOf(A);
    await approveNote(A.session, n1.id, { db: app, clock });
    const asAdmin = (sql: string) =>
      admin.withTenant(A.tenantId, (q) => q.execute(sql, [n1.id]));
    expect(await sqlStateOf(asAdmin("UPDATE driver_notes SET body = 'Changed.' WHERE id = CAST($1 AS uuid)"))).toBe("23514");
    expect(await sqlStateOf(asAdmin("UPDATE driver_notes SET status = 'drafted' WHERE id = CAST($1 AS uuid)"))).toBe("23514");
    expect(await sqlStateOf(asAdmin("UPDATE driver_notes SET decided_by = 'someone' WHERE id = CAST($1 AS uuid)"))).toBe("23514");
    expect(await sqlStateOf(asAdmin("UPDATE driver_notes SET language = 'es' WHERE id = CAST($1 AS uuid)"))).toBe("23514");
    // The app role has no DELETE and no UPDATE on the identity columns.
    const asApp = (sql: string) => app.withTenant(A.tenantId, (q) => q.execute(sql, [n1.id]));
    expect(await sqlStateOf(asApp("DELETE FROM driver_notes WHERE id = CAST($1 AS uuid)"))).toBe("42501");
    expect(await sqlStateOf(asApp("UPDATE driver_notes SET language = 'es' WHERE id = CAST($1 AS uuid)"))).toBe("42501");
    expect((await notesOf(A))[0].body).toBe("Hi, your net pay is $1,100.00 [line 1].");
  });

  it("refuses a note inserted past its reservation, from the app role or the admin login", async () => {
    // Each row passes every column check, so only the guard can refuse it.
    const decided = new Date(NOW).toISOString();
    const insert = (db: Db, status: "approved" | "drafted") =>
      db.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO driver_notes (id, tenant_id, settlement_id, driver_id, period_id, language, status, body,
             trace_id, decided_by, decided_at, delivered_at, channel)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), 'en',
             $5, 'Hi, your net pay is $9,999.99.', CAST($6 AS uuid), $7, CAST($8 AS timestamptz),
             CAST($9 AS timestamptz), $10)`,
          status === "approved"
            ? [randomUUID(), settlement1, A.driverId, periodId, status, randomUUID(), "someone", decided, decided, "driver_view"]
            : [randomUUID(), settlement1, A.driverId, periodId, status, randomUUID(), null, null, null, null],
        ),
      );
    for (const db of [app, admin]) {
      expect(await sqlStateOf(insert(db, "approved"))).toBe("23514");
      expect(await sqlStateOf(insert(db, "drafted"))).toBe("23514");
    }
    expect(await notesOf(A)).toEqual([]);
  });

  it("shows another carrier none of it", async () => {
    await draft();
    const [n1] = await notesOf(A);
    expect(await app.withTenant(B.tenantId, (q) => readPeriodNotes(q, periodId))).toBeNull();
    expect(await app.withTenant(B.tenantId, (q) => readDriverView(q, settlement1))).toBeNull();
    expect(await app.withTenant(B.tenantId, (q) => listNotePeriods(q))).toEqual([]);
    expect(
      await app.withTenant(B.tenantId, (q) => q.query("SELECT id FROM driver_notes")),
    ).toEqual([]);
    expect(await approveNote(B.session, n1.id, { db: app, clock })).toEqual({ ok: false, category: "not_found" });
    expect(await draftDriverNotes(B.session, periodId, deadline(), { db: app, complete: goodModel, clock })).toEqual({
      ok: false,
      category: "not_found",
    });
    expect(await deliverNoteEmail(B.session, n1.id, { db: app, log: () => undefined })).toEqual({
      sent: false,
      category: "not_found",
    });
  });

  it("is cleared with the tenant's agent records before a reseed", async () => {
    await draft();
    expect(await notesOf(A)).toHaveLength(2);
    expect(await clearTenantAgent(admin, A.tenantId)).toBe(2);
    expect(await notesOf(A)).toHaveLength(0);
  });
});
