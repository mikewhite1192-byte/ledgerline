import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { codeRef, createMoneyCodeIssuer } from "../adapters/payment/fuel-card-sim";
import type { MoneyCodeIssuer } from "../adapters/types";
import { readMoneyCodeInput, readSettlementInput } from "../data/read";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable, TenantDb } from "../db/types";
import { CONFIDENCE_FIELDS } from "../documents/types";
import { readBySubject } from "../money/read";
import { clearLedger, dropTenant, makeTenant, setArmed, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal, type ExecutorRegistry } from "../proposals/execute";
import { checkMoneyCode } from "../rules-engine/money-codes";
import { settleDriver } from "../rules-engine/settlement";
import {
  chargeItemRef,
  checkPendingCode,
  executeMoneyCodeProposal,
  finishIssuedCode,
  precheckMoneyCode,
  revealMoneyCode,
  reimbursementItemRef,
  type MoneyCodeDeps,
} from "./execute";
import { readMoneyCode } from "./read";
import { readRequestChoices, requestMoneyCode } from "./request";

// The money-code flow against a real database, as the app's own role, with the registered
// executor and the simulated issuer. A person's request from the form makes one waiting proposal;
// approving it (once or twice, in turn or at the same time) issues one code and writes one
// billable lumper line on the load and two paystub lines that net to zero; an amount ending 99 is
// declined with nothing written; one ending 98 is unknown until Check pending reads it back, and
// then the lines are written once, even while a second approval resumes it; one receipt or voice
// note backs one live code; an amount above the admin threshold is refused for a staff member;
// the code is shown only while it is good; another carrier sees nothing. Every tenant made here is
// removed after each test.

const saved = structuredClone(flags);
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let issuer: MoneyCodeIssuer;
let issuerLog: string[];

function openSwitches() {
  flags.payoutsEnabled = true;
  flags.accountingEnabled = false;
  flags.auditorRequired = false;
  flags.moneyCodes = { enabled: true, armed: true, capCents: 50_000, perDriverPerDay: 2, startDate: "2026-10-28" };
}

// A pay rule set (60 cents a mile for the fixture's company drivers) and one load on the road for
// the fixture's first driver, the one the codes are asked for.
async function addLoadOnTheRoad(f: Fixture): Promise<string> {
  const loadId = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'ui', 1, 'linehaul',
         0, 10000, 'owner_operator', 0, 0, 0, 0, NULL, 500, 150000, 5000, 5000)`,
      [randomUUID()],
    );
    await q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
         origin_state, dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'L-ROAD', CAST($2 AS uuid), CAST($3 AS uuid),
         'in_transit', 'Springfield', 'IL', 'Dallas', 'TX', CAST('2026-11-01' AS date), 2000, 400000)`,
      [loadId, f.customerId, f.driverId],
    );
  });
  return loadId;
}

const deps = (over: Partial<MoneyCodeDeps> = {}): MoneyCodeDeps => ({
  db: app,
  clock,
  issuer,
  money: { timeoutMs: 2_000, waitMs: 2_000, pollMs: 10, log: () => {} },
  ...over,
});

async function ask(f: Fixture, loadId: string, amountCents: number, purpose: "lumper" | "repair" = "lumper") {
  const r = await requestMoneyCode(f.session, { loadId, amountCents, purpose, documentId: null }, { db: app, clock });
  if (!r.ok) throw new Error(`request refused: ${r.category}`);
  expect(r.outcome).toBe("created");
  return r.proposalId;
}

const approve = (id: string, session = A.session, d: MoneyCodeDeps = deps()) =>
  executeProposal(session, id, { confirmed: true }, d);

// A request from the form at a given instant, its refusal returned rather than thrown.
const askAt = (at: number, body: { loadId: string; amountCents: number; purpose: "lumper" | "repair" | "other"; documentId: string | null }) =>
  requestMoneyCode(A.session, body, { db: app, clock: () => new Date(at) });

// A receipt read for sure (every field high): its kind, its total and the load number printed on it.
async function addReceipt(f: Fixture, kind: "lumper_receipt" | "other", totalCents: number, loadNumber: string): Promise<string> {
  const id = randomUUID();
  const bytes = Buffer.from(`receipt ${id}`);
  const reading = {
    document_kind: kind,
    sample_word: false,
    vendor: "Dock Services",
    date_mmddyyyy: "11/02/2026",
    total_cents: totalCents,
    load_number: loadNumber,
    truck_unit: null,
    gallons_milli: null,
    price_cents: null,
    loaded_miles: null,
    rate_per_mile_cents: null,
    linehaul_cents: null,
    fuel_surcharge_cents: null,
    customer_name: null,
    stops: [],
    text_lines: [],
    confidence: Object.fromEntries(CONFIDENCE_FIELDS.map((c) => [c, "high"])),
  };
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO documents (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash,
         read_status, document_kind, reading, trace_id, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'money-code-test', 'receipt.webp', 'image/webp', $2,
         decode($3, 'base64'), $4, 'read', $5, CAST($6 AS jsonb), CAST($7 AS uuid), CAST($8 AS timestamptz))`,
      [
        id,
        bytes.byteLength,
        bytes.toString("base64"),
        createHash("sha256").update(bytes).digest("hex"),
        kind,
        JSON.stringify(reading),
        randomUUID(),
        new Date(NOW).toISOString(),
      ],
    ),
  );
  return id;
}

// A code row written straight in (no proposal), citing a document or a voice note.
const insertCode = (
  f: Fixture,
  loadId: string,
  evidence: { documentId: string } | { voiceNoteId: string },
  createdAt: number = NOW,
) =>
  admin.withTenant(f.tenantId, async (q) => {
    const id = randomUUID();
    const documentId = "documentId" in evidence ? evidence.documentId : null;
    const voiceNoteId = "voiceNoteId" in evidence ? evidence.voiceNoteId : null;
    await q.execute(
      `INSERT INTO money_codes (id, tenant_id, driver_id, load_id, purpose, amount_cents, source_kind, document_id,
                                voice_note_id, membership_id, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'repair', 5000, $4,
               CAST($5 AS uuid), CAST($6 AS uuid), CAST($7 AS uuid), CAST($8 AS timestamptz), CAST($8 AS timestamptz))`,
      [id, f.driverId, loadId, documentId ? "document" : "voice_note", documentId, voiceNoteId, f.memberId, new Date(createdAt).toISOString()],
    );
    return id;
  });

type CodeRow = {
  id: string;
  status: string;
  code_last4: string | null;
  accessorial_id: string | null;
  charge_item_id: string | null;
  reimbursement_item_id: string | null;
  issued_at: string | null;
  expires_at: string | null;
};

const codeRows = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<CodeRow>(
      `SELECT CAST(id AS text) AS id, status, code_last4, CAST(accessorial_id AS text) AS accessorial_id,
              CAST(charge_item_id AS text) AS charge_item_id,
              CAST(reimbursement_item_id AS text) AS reimbursement_item_id,
              to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
              to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
         FROM money_codes WHERE tenant_id = current_tenant_id() ORDER BY created_at`,
    ),
  );

const payItems = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ id: string; kind: string; subkind: string | null; amount_cents: string; item_ref: string; item_date: string }>(
      `SELECT CAST(id AS text) AS id, kind, subkind, CAST(amount_cents AS text) AS amount_cents, item_ref,
              to_char(item_date, 'YYYY-MM-DD') AS item_date
         FROM pay_items WHERE tenant_id = current_tenant_id() ORDER BY kind`,
    ),
  );

const lumpers = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ id: string; amount_cents: string; paid_by_driver: boolean; seq: number }>(
      `SELECT CAST(id AS text) AS id, CAST(amount_cents AS text) AS amount_cents, paid_by_driver, seq
         FROM load_accessorials WHERE tenant_id = current_tenant_id() AND kind = 'lumper'`,
    ),
  );

const ledger = (f: Fixture = A) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ state: string; attempt: number; failure_category: string | null }>(
      `SELECT state, attempt, failure_category FROM money_actions
        WHERE tenant_id = current_tenant_id() AND kind = 'money_code_issue' ORDER BY attempt`,
    ),
  );

const proposalStatus = async (id: string, f: Fixture = A) =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<{ status: string }>("SELECT status FROM proposals WHERE id = CAST($1 AS uuid)", [id]),
    )
  )[0]?.status;

// The proposal's last change, as the executor stamped it.
const proposalStamp = async (id: string, f: Fixture = A) =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<{ at: string }>(
        `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
           FROM proposals WHERE id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0]?.at;

describe("money codes against the database", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
  });

  beforeEach(async () => {
    Object.assign(flags, structuredClone(saved));
    openSwitches();
    issuerLog = [];
    issuer = createMoneyCodeIssuer({ log: (line) => issuerLog.push(line) });
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `mc-a-${tag}`);
    B = await makeTenant(admin, `mc-b-${tag}`);
  });

  afterEach(async () => {
    Object.assign(flags, structuredClone(saved));
    for (const f of [A, B]) {
      if (f) await clearLedger(admin, f);
      await dropTenant(admin, f);
    }
  });

  afterAll(async () => {
    Object.assign(flags, structuredClone(saved));
    await admin?.close();
    await app?.close();
  });

  it("approved twice issues one code, one lumper line and two paystub lines", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 15_000);
    expect(await proposalStatus(proposalId)).toBe("proposed");

    const first = await approve(proposalId);
    expect(first).toMatchObject({ ok: true, status: "done" });
    const second = await approve(proposalId);
    expect(second).toMatchObject({ ok: false, category: "already_decided" });

    const codes = await codeRows();
    expect(codes).toHaveLength(1);
    const [code] = codes;
    expect(code.status).toBe("issued");
    expect(code.code_last4).toMatch(/^[0-9]{4}$/);
    expect(Date.parse(code.expires_at ?? "") - Date.parse(code.issued_at ?? "")).toBe(24 * HOUR);

    const items = await payItems();
    expect(items.map((i) => [i.kind, i.subkind, i.amount_cents, i.item_ref])).toEqual([
      ["other_deduction", "money_code", "15000", chargeItemRef(code.id)],
      ["reimbursement", "lumper", "15000", reimbursementItemRef(code.id)],
    ]);
    expect(code.charge_item_id).toBe(items[0].id);
    expect(code.reimbursement_item_id).toBe(items[1].id);

    const lines = await lumpers();
    expect(lines).toEqual([{ id: code.accessorial_id, amount_cents: "15000", paid_by_driver: true, seq: 1 }]);
    expect(await ledger()).toEqual([{ state: "confirmed", attempt: 1, failure_category: null }]);
    expect(await proposalStatus(proposalId)).toBe("done");

    // The code itself never reaches a log line; the row keeps only its last four digits.
    const shown = await revealMoneyCode(A.session, code.id, deps({ clock: () => new Date(Date.parse(code.issued_at ?? "") + HOUR) }));
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.code).toMatch(/^[0-9]{10}$/);
      expect(shown.code.slice(-4)).toBe(code.code_last4);
      expect(issuerLog.length).toBeGreaterThan(0);
      for (const line of issuerLog) expect(line).not.toContain(shown.code);
    }
  });

  it("two approvals at once still issue one code", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 12_000, "repair");
    const results = await Promise.all([approve(proposalId), approve(proposalId)]);
    expect(results.some((r) => r.ok)).toBe(true);
    const codes = await codeRows();
    expect(codes).toHaveLength(1);
    expect(codes[0].status).toBe("issued");
    // A repair has no billable line on the load.
    expect(codes[0].accessorial_id).toBeNull();
    expect(await lumpers()).toEqual([]);
    expect((await payItems()).map((i) => [i.kind, i.subkind, i.amount_cents])).toEqual([
      ["other_deduction", "money_code", "12000"],
      ["reimbursement", "repair", "12000"],
    ]);
    expect(await ledger()).toHaveLength(1);
  });

  it("a declined code writes no lines and ends the proposal", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 4_099);
    const r = await approve(proposalId);
    expect(r).toMatchObject({ ok: false, category: "code_declined" });
    const codes = await codeRows();
    expect(codes.map((c) => c.status)).toEqual(["failed"]);
    expect(codes[0].code_last4).toBeNull();
    expect(await payItems()).toEqual([]);
    expect(await lumpers()).toEqual([]);
    expect(await ledger()).toEqual([{ state: "failed", attempt: 1, failure_category: "declined" }]);
    expect(await proposalStatus(proposalId)).toBe("failed");
    // The failure is stamped with the injected clock, not the machine's.
    expect(await proposalStamp(proposalId)).toBe(new Date(NOW).toISOString());
    const shown = await revealMoneyCode(A.session, codes[0].id, deps());
    expect(shown).toMatchObject({ ok: false, category: "not_issued" });
  });

  it("an unknown code stays unknown until Check pending reads it back, then writes the lines once", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 9_998);
    const r = await approve(proposalId);
    expect(r).toMatchObject({ ok: true, status: "executing" });
    let codes = await codeRows();
    expect(codes.map((c) => c.status)).toEqual(["unknown"]);
    expect(await payItems()).toEqual([]);
    expect(await lumpers()).toEqual([]);
    expect((await ledger()).map((a) => a.state)).toEqual(["unknown"]);
    expect(await revealMoneyCode(A.session, codes[0].id, deps())).toMatchObject({ ok: false, category: "not_issued" });

    const settled = { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 };
    const checked = await checkPendingCode(A.session, codes[0].id, deps());
    expect(checked).toEqual({ ok: true, summary: { ...settled, checked: 1, confirmed: 1 }, tooNew: 0, stillWaiting: 0 });
    // Asked again, nothing is open: nothing read back, nothing written.
    const again = await checkPendingCode(A.session, codes[0].id, deps());
    expect(again).toEqual({ ok: true, summary: settled, tooNew: 0, stillWaiting: 0 });

    codes = await codeRows();
    expect(codes.map((c) => c.status)).toEqual(["issued"]);
    expect((await ledger()).map((a) => a.state)).toEqual(["confirmed"]);
    expect((await payItems()).map((i) => [i.kind, i.amount_cents])).toEqual([
      ["other_deduction", "9998"],
      ["reimbursement", "9998"],
    ]);
    expect(await lumpers()).toHaveLength(1);
    expect(await proposalStatus(proposalId)).toBe("done");
    // Never a second issue: one ledger row, attempt 1.
    expect((await ledger()).map((a) => a.attempt)).toEqual([1]);
  });

  it("a confirm with no settle time takes the injected clock as the issue time", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 9_998);
    expect(await approve(proposalId)).toMatchObject({ ok: true, status: "executing" });
    const [code] = await codeRows();
    expect(code.status).toBe("unknown");
    // The post-confirm step on its own, as Check pending runs it, for a confirmed row whose settle
    // time is missing: the code's times and the paystub day come from the clock it is handed.
    const at = "2026-11-02T16:30:00.000Z";
    await app.withTenant(A.tenantId, async (q) => {
      const [action] = (await readBySubject(q, "money_codes", code.id)).filter((a) => a.kind === "money_code_issue");
      await finishIssuedCode(
        q,
        { ...action, state: "confirmed", settledAt: null, outsideId: codeRef(action.requestId) },
        issuer,
        at,
      );
    });
    const [after] = await codeRows();
    expect(after.status).toBe("issued");
    expect(after.issued_at).toBe(at);
    expect(after.expires_at).toBe("2026-11-03T16:30:00.000Z");
    expect((await payItems()).map((i) => [i.kind, i.item_date])).toEqual([
      ["other_deduction", "2026-11-02"],
      ["reimbursement", "2026-11-02"],
    ]);
  });

  it("Check pending settling a code while a second approval resumes it: one code, both finish, no deadlock", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 9_998);
    expect(await approve(proposalId)).toMatchObject({ ok: true, status: "executing" });
    const [code] = await codeRows();
    expect(code.status).toBe("unknown");

    // Another connection holds the load, so the steps happen in a fixed order: Check pending's
    // settle locks the code and waits on the load; then the second approval resumes and must wait
    // behind that settle, never on a lock the settle takes next (the driver, the proposal).
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderPid = 0;
    let holder: Promise<void> = Promise.resolve();
    const held = new Promise<void>((resolve, reject) => {
      holder = admin.withTenant(A.tenantId, async (q) => {
        await q.query("SELECT id FROM loads WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE", [
          loadId,
        ]);
        holderPid = (await q.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0].pid;
        resolve();
        await released;
      });
      holder.catch(reject);
    });
    // Polls the database until the condition holds (or the step it waits on already finished),
    // bounded by a count, never by a timer.
    const until = async (sql: string, finished: () => boolean, what: string) => {
      for (let i = 0; i < 20_000; i += 1) {
        if (finished()) return;
        const [row] = await admin.withoutTenant((q) => q.query<{ n: string }>(sql, [holderPid]));
        if (Number(row.n) > 0) return;
      }
      throw new Error(`never saw ${what}`);
    };
    const lines: string[] = [];
    const money = { timeoutMs: 2_000, waitMs: 2_000, pollMs: 10, log: (line: string) => lines.push(line) };
    const pending: Promise<unknown>[] = [];
    try {
      await held;
      let checkDone = false;
      const checking = checkPendingCode(A.session, code.id, deps({ money })).finally(() => {
        checkDone = true;
      });
      pending.push(checking);
      await until(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE CAST($1 AS int) = ANY(pg_blocking_pids(pid))",
        () => checkDone,
        "the settle to wait on the load",
      );
      expect(checkDone).toBe(false);

      let resumeDone = false;
      const resuming = approve(proposalId, A.session, deps({ money })).finally(() => {
        resumeDone = true;
      });
      pending.push(resuming);
      await until(
        `SELECT count(*) AS n FROM pg_stat_activity w
          WHERE EXISTS (SELECT 1 FROM pg_stat_activity d
                         WHERE CAST($1 AS int) = ANY(pg_blocking_pids(d.pid))
                           AND d.pid = ANY(pg_blocking_pids(w.pid)))`,
        () => resumeDone,
        "the resumed approval to wait behind the settle",
      );

      release();
      const results = await Promise.allSettled([checking, resuming]);
      // Neither one is aborted (a deadlock is 40P01), and the settle commits.
      expect(
        results.map((r) => (r.status === "fulfilled" ? "fulfilled" : ((r.reason as { sqlState?: string }).sqlState ?? "rejected"))),
      ).toEqual(["fulfilled", "fulfilled"]);
      expect(lines.filter((l) => l.includes("did not commit"))).toEqual([]);
      const settled = { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 };
      expect(await checking).toEqual({ ok: true, summary: { ...settled, checked: 1, confirmed: 1 }, tooNew: 0, stillWaiting: 0 });
      expect(await resuming).toMatchObject({ ok: true, status: "done" });

      expect((await codeRows()).map((c) => c.status)).toEqual(["issued"]);
      expect(await ledger()).toEqual([{ state: "confirmed", attempt: 1, failure_category: null }]);
      expect((await payItems()).map((i) => [i.kind, i.amount_cents])).toEqual([
        ["other_deduction", "9998"],
        ["reimbursement", "9998"],
      ]);
      expect(await lumpers()).toHaveLength(1);
      expect(await proposalStatus(proposalId)).toBe("done");
    } finally {
      release();
      await Promise.allSettled([holder, ...pending]);
    }
  }, 60_000);

  it("refuses a receipt that already backs a live code, for another purpose, after 24 hours and after the look-back", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const receipt = await addReceipt(A, "other", 12_000, "L-ROAD");
    // Upper-case ids from the form are written lower case.
    const first = await askAt(NOW, {
      loadId: loadId.toUpperCase(),
      amountCents: 12_000,
      purpose: "repair",
      documentId: receipt.toUpperCase(),
    });
    if (!first.ok) throw new Error(`request refused: ${first.category}`);
    expect(first.outcome).toBe("created");
    const stored = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ subject_id: string; document_id: string }>(
        `SELECT CAST(subject_id AS text) AS subject_id, args->>'documentId' AS document_id
           FROM proposals WHERE id = CAST($1 AS uuid)`,
        [first.proposalId],
      ),
    );
    expect(stored).toEqual([{ subject_id: loadId, document_id: receipt }]);
    expect(await approve(first.proposalId)).toMatchObject({ ok: true, status: "done" });
    expect((await codeRows()).map((c) => c.status)).toEqual(["issued"]);

    const refused = { ok: false, category: "evidence_reused" };
    // Another purpose the same receipt also fits, the same hour.
    expect(await askAt(NOW, { loadId, amountCents: 12_000, purpose: "other", documentId: receipt })).toMatchObject(refused);
    // The same purpose once the 24-hour duplicate window has passed.
    expect(await askAt(NOW + 25 * HOUR, { loadId, amountCents: 12_000, purpose: "repair", documentId: receipt })).toMatchObject(
      refused,
    );
    // Past the three days a code is read back by driver and load: found by the receipt itself.
    expect(
      await askAt(NOW + 4 * 24 * HOUR, { loadId, amountCents: 12_000, purpose: "repair", documentId: receipt }),
    ).toMatchObject(refused);
    expect(await codeRows()).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
  });

  it("lets a failed code's receipt back a new request and a new code", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const receipt = await addReceipt(A, "other", 4_099, "L-ROAD");
    const first = await askAt(NOW, { loadId, amountCents: 4_099, purpose: "repair", documentId: receipt });
    if (!first.ok) throw new Error(`request refused: ${first.category}`);
    expect(await approve(first.proposalId)).toMatchObject({ ok: false, category: "code_declined" });
    expect((await codeRows()).map((c) => c.status)).toEqual(["failed"]);

    const again = await askAt(NOW, { loadId, amountCents: 4_099, purpose: "repair", documentId: receipt });
    if (!again.ok) throw new Error(`request refused: ${again.category}`);
    expect(again.outcome).toBe("created");
    // The second code cites the same receipt next to the failed one (the issuer declines it too).
    expect(await approve(again.proposalId)).toMatchObject({ ok: false, category: "code_declined" });
    expect((await codeRows()).map((c) => c.status)).toEqual(["failed", "failed"]);
  });

  it("reads a live code citing the same voice note however old, and the engine refuses the note again", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const note = randomUUID();
    await insertCode(A, loadId, { voiceNoteId: note }, NOW - 7 * 24 * HOUR);
    const input = await app.withTenant(A.tenantId, (q) =>
      readMoneyCodeInput(
        q,
        {
          driverId: A.driverId,
          loadId,
          purpose: "repair",
          amountCents: 5_000,
          source: "voice_note",
          voiceNoteId: note.toUpperCase(),
          capCents: 50_000,
          perDriverPerDay: 2,
        },
        new Date(NOW).toISOString(),
      ),
    );
    expect(input.voiceNoteId).toBe(note);
    expect(input.codes.map((c) => [c.voiceNoteId, c.status])).toEqual([[note, "issuing"]]);
    const decision = checkMoneyCode(input);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusals).toContain("evidence_reused");
  });

  it("holds one live code per receipt and per voice note in the database too", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const doc = randomUUID();
    const note = randomUUID();
    const firstDoc = await insertCode(A, loadId, { documentId: doc });
    const firstNote = await insertCode(A, loadId, { voiceNoteId: note });
    expect(await sqlStateOf(insertCode(A, loadId, { documentId: doc }))).toBe("23505");
    expect(await sqlStateOf(insertCode(A, loadId, { voiceNoteId: note }))).toBe("23505");
    // Once those codes fail, the same evidence may back a new one.
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `UPDATE money_codes SET status = 'failed'
          WHERE tenant_id = current_tenant_id() AND id IN (CAST($1 AS uuid), CAST($2 AS uuid))`,
        [firstDoc, firstNote],
      ),
    );
    expect(await sqlStateOf(insertCode(A, loadId, { documentId: doc }))).toBe("no error");
    expect(await sqlStateOf(insertCode(A, loadId, { voiceNoteId: note }))).toBe("no error");
    // Another carrier's code on the same id is its own.
    const otherLoad = await addLoadOnTheRoad(B);
    expect(await sqlStateOf(insertCode(B, otherLoad, { documentId: doc }))).toBe("no error");
  });

  it("an approval whose receipt gets a live code past the rules is refused as reused evidence, with no second row", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const receipt = await addReceipt(A, "other", 6_000, "L-ROAD");
    const asked = await askAt(NOW, { loadId, amountCents: 6_000, purpose: "repair", documentId: receipt });
    if (!asked.ok) throw new Error(`request refused: ${asked.category}`);
    // Another live code citing the receipt lands after the rules engine read the codes and right
    // before the approval writes its own, in the same transaction, so only the index stops it.
    let planted = false;
    const racing: TenantDb = {
      withTenant: (tenantId, fn) =>
        app.withTenant(tenantId, (q) => {
          const wrapped: Queryable = {
            query: q.query.bind(q),
            execute: async (sql, params) => {
              if (!planted && sql.includes("INSERT INTO money_codes (")) {
                planted = true;
                await q.execute(
                  `INSERT INTO money_codes (id, tenant_id, driver_id, load_id, purpose, amount_cents, source_kind,
                                            document_id, membership_id, created_at, updated_at)
                   VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'other', 6000,
                           'document', CAST($4 AS uuid), CAST($5 AS uuid), CAST($6 AS timestamptz),
                           CAST($6 AS timestamptz))`,
                  [randomUUID(), A.driverId, loadId, receipt, A.memberId, new Date(NOW).toISOString()],
                );
              }
              return q.execute(sql, params);
            },
          };
          return fn(wrapped);
        }),
    };
    expect(await approve(asked.proposalId, A.session, deps({ db: racing }))).toMatchObject({
      ok: false,
      category: "evidence_reused",
    });
    expect(planted).toBe(true);
    // The transaction rolled back: no code row was kept and no ledger row was reserved.
    expect(await codeRows()).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  it("offers an invoiced load delivered in the last three days, and takes a repair code on it but not a lumper code", async () => {
    await addLoadOnTheRoad(A);
    // Delivered two days ago (Chicago), invoiced since.
    const billedId = randomUUID();
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
           origin_state, dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles, linehaul_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'L-BILLED', CAST($2 AS uuid), CAST($3 AS uuid),
           'invoiced', 'Dallas', 'TX', 'Tulsa', 'OK', CAST('2026-10-30' AS date), CAST('2026-10-31' AS date),
           CAST('2026-10-31T18:00:00Z' AS timestamptz), 2000, 400000)`,
        [billedId, A.customerId, A.driverId],
      ),
    );
    const choices = await app.withTenant(A.tenantId, (q) => readRequestChoices(q, clock()));
    expect(choices.loads.filter((l) => l.id === billedId).map((l) => [l.loadNumber, l.status])).toEqual([
      ["L-BILLED", "delivered"],
    ]);

    const lumper = await requestMoneyCode(
      A.session,
      { loadId: billedId, amountCents: 15_000, purpose: "lumper", documentId: null },
      { db: app, clock },
    );
    expect(lumper).toMatchObject({ ok: false, category: "load_invoiced" });
    expect(await codeRows()).toEqual([]);

    const proposalId = await ask(A, billedId, 12_000, "repair");
    expect(await approve(proposalId)).toMatchObject({ ok: true, status: "done" });
    const [code] = await codeRows();
    expect(code.status).toBe("issued");
    expect(code.accessorial_id).toBeNull();
    expect(await lumpers()).toEqual([]);
    expect((await payItems()).map((i) => [i.kind, i.subkind, i.amount_cents])).toEqual([
      ["other_deduction", "money_code", "12000"],
      ["reimbursement", "repair", "12000"],
    ]);
  });

  it("the paystub nets to zero after a code", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 15_000);
    expect(await approve(proposalId)).toMatchObject({ ok: true, status: "done" });
    const items = await payItems();
    const day = items[0].item_date;
    // The pay week holding the code's lines (weeks start Monday here), with one delivered load in
    // it so the week has earnings of its own.
    const periodId = randomUUID();
    await admin.withTenant(A.tenantId, async (q) => {
      await q.execute(
        `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
         SELECT CAST($1 AS uuid), current_tenant_id(), d.start, d.start + 6, 'open'
           FROM (SELECT CAST($2 AS date) - (CAST(EXTRACT(ISODOW FROM CAST($2 AS date)) AS int) - 1) AS start) d`,
        [periodId, day],
      );
      await q.execute(
        `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
           origin_state, dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles, linehaul_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), 'L-DONE', CAST($2 AS uuid), CAST($3 AS uuid),
           'delivered', 'Dallas', 'TX', 'Tulsa', 'OK', CAST($4 AS date), CAST($4 AS date),
           CAST($4 AS date) + interval '18 hours', 2000, 400000)`,
        [randomUUID(), A.customerId, A.driverId, day],
      );
      for (const [state, miles] of [["TX", 1200], ["OK", 800]] as const) {
        await q.execute(
          `INSERT INTO load_state_miles (id, tenant_id, load_id, state, miles)
           SELECT gen_random_uuid(), current_tenant_id(), id, $1, $2 FROM loads
            WHERE tenant_id = current_tenant_id() AND load_number = 'L-DONE'`,
          [state, miles],
        );
      }
    });
    const input = await app.withTenant(A.tenantId, (q) => readSettlementInput(q, A.driverId, periodId));
    const codeRefs = new Set(items.map((i) => i.id));
    const withCode = settleDriver(input);
    const withoutCode = settleDriver({ ...input, items: input.items.filter((i) => !codeRefs.has(i.id)) });
    expect(withCode.grossCents).toBe(withoutCode.grossCents + 15_000);
    expect(withCode.deductionsCents).toBe(withoutCode.deductionsCents + 15_000);
    expect(withCode.netCents).toBe(withoutCode.netCents);
    expect(withCode.netCents).toBeGreaterThan(0);
  });

  it("a staff member cannot approve a code above the admin threshold; an admin can", async () => {
    flags.moneyCodes = { ...flags.moneyCodes, capCents: 500_000 };
    flags.approverRole = { ...flags.approverRole, adminAboveCents: 200_000 };
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 250_000, "repair");
    expect(await approve(proposalId)).toMatchObject({ ok: false, category: "role" });
    expect(await proposalStatus(proposalId)).toBe("proposed");
    expect(await codeRows()).toEqual([]);
    expect(await ledger()).toEqual([]);

    await admin.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id() AND cognito_sub = $1", [
        A.session.sub,
      ]),
    );
    expect(await approve(proposalId)).toMatchObject({ ok: true, status: "done" });
    expect((await codeRows()).map((c) => c.status)).toEqual(["issued"]);
  });

  it("a closed switch refuses before the approval and writes nothing", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 15_000);
    flags.moneyCodes = { ...flags.moneyCodes, armed: false };
    expect(await approve(proposalId)).toMatchObject({ ok: false, category: "codes_not_armed" });
    flags.moneyCodes = { ...flags.moneyCodes, armed: true };
    await setArmed(admin, A, A.driverId, false);
    expect(await approve(proposalId)).toMatchObject({ ok: false, category: "driver_not_armed" });
    expect(await proposalStatus(proposalId)).toBe("proposed");
    expect(await codeRows()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await payItems()).toEqual([]);
  });

  it("refuses a driver past their last day, still armed, at the request, at the approval and at the executor", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 15_000);
    const setLastDay = (day: string | null) =>
      admin.withTenant(A.tenantId, (q) =>
        q.execute("UPDATE drivers SET active_to = CAST($2 AS date) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
          A.driverId,
          day,
        ]),
      );
    // NOW is Nov 2 in the carrier's zone: a last day of Nov 1 has passed.
    await setLastDay("2026-11-01");
    expect(await approve(proposalId)).toEqual({ ok: false, category: "driver_inactive", retryable: false });
    expect(await proposalStatus(proposalId)).toBe("proposed");
    // A new request from the form: the engine reads the departed driver as not armed.
    const input = await app.withTenant(A.tenantId, (q) =>
      readMoneyCodeInput(
        q,
        {
          driverId: A.driverId,
          loadId,
          purpose: "lumper",
          amountCents: 12_000,
          source: "form",
          documentId: null,
          voiceNoteId: null,
          capCents: flags.moneyCodes.capCents,
          perDriverPerDay: flags.moneyCodes.perDriverPerDay,
        },
        new Date(NOW).toISOString(),
      ),
    );
    expect(input.driverArmed).toBe(false);
    // Left after the precheck: the executor asks again under the driver lock.
    await setLastDay(null);
    const racing: ExecutorRegistry = {
      money_code: Object.assign((...args: Parameters<typeof executeMoneyCodeProposal>) => executeMoneyCodeProposal(...args), {
        precheck: async (...args: Parameters<typeof precheckMoneyCode>) => {
          const answer = await precheckMoneyCode(...args);
          await setLastDay("2026-11-01");
          return answer;
        },
      }),
    };
    expect(await approve(proposalId, A.session, deps({ executors: racing }))).toEqual({
      ok: false,
      category: "driver_inactive",
      retryable: false,
    });
    expect(await codeRows()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await payItems()).toEqual([]);
  });

  it("the code is shown only while it is good", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 15_000);
    expect(await approve(proposalId)).toMatchObject({ ok: true, status: "done" });
    const [code] = await codeRows();
    const expires = Date.parse(code.expires_at ?? "");
    const before = await revealMoneyCode(A.session, code.id, deps({ clock: () => new Date(expires - 1) }));
    expect(before.ok).toBe(true);
    const after = await revealMoneyCode(A.session, code.id, deps({ clock: () => new Date(expires) }));
    expect(after).toMatchObject({ ok: false, category: "code_expired" });
    flags.moneyCodes = { ...flags.moneyCodes, enabled: false };
    const off = await revealMoneyCode(A.session, code.id, deps({ clock: () => new Date(expires - 1) }));
    expect(off).toMatchObject({ ok: false, category: "codes_off" });
  });

  it("another carrier sees nothing and cannot write a code for this one", async () => {
    const loadId = await addLoadOnTheRoad(A);
    const proposalId = await ask(A, loadId, 15_000);
    expect(await approve(proposalId)).toMatchObject({ ok: true, status: "done" });
    const [code] = await codeRows();

    expect(await approve(proposalId, B.session)).toMatchObject({ ok: false, category: "not_found" });
    expect(await revealMoneyCode(B.session, code.id, deps())).toMatchObject({ ok: false, category: "not_found" });
    expect(await checkPendingCode(B.session, code.id, deps())).toMatchObject({ ok: false, category: "not_found" });
    expect(await app.withTenant(B.tenantId, (q) => readMoneyCode(q, code.id))).toBeNull();
    const seen = await app.withTenant(B.tenantId, (q) =>
      q.query<{ n: string }>("SELECT CAST(count(*) AS text) AS n FROM money_codes"),
    );
    expect(seen[0].n).toBe("0");
    // A request for A's load from B finds no load.
    const crossed = await requestMoneyCode(
      B.session,
      { loadId, amountCents: 15_000, purpose: "lumper", documentId: null },
      { db: app, clock },
    );
    expect(crossed).toMatchObject({ ok: false, category: "not_found" });
    // Row security refuses a row written into A from B's session.
    const state = await sqlStateOf(
      app.withTenant(B.tenantId, (q) =>
        q.execute(
          `INSERT INTO money_codes (id, tenant_id, driver_id, load_id, purpose, amount_cents, source_kind, membership_id)
           VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), 'lumper', 100, 'form',
                   CAST($5 AS uuid))`,
          [randomUUID(), A.tenantId, A.driverId, loadId, A.memberId],
        ),
      ),
    );
    expect(state).toBe("42501");
    expect(await codeRows()).toHaveLength(1);
  });
});
