import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param, TenantDb } from "../db/types";
import { findSubjects, SUBJECT_FINDERS } from "../desk/discover";
import { deskHandlers } from "../desk/handlers";
import { addAdvance, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { executeProposal, type Executor, type ExecutorRegistry, type ProposalKind } from "../proposals/execute";
import { serviceSub } from "../sweep/service-session";
import { runAutopilot } from "./run";
import { autopilotSession, autopilotSub } from "./session";
import { setPaused } from "./state";

// The autopilot against the real database, as the app's role: both new tables hold each carrier
// to its own rows; the database refuses a decision written out of turn and a rule changed without
// its version; the approval gate refuses the autopilot login without opts.autopilot, the sweep's
// login, and opts.autopilot from a person; the pause stops it in the run and in the gate; inside
// every limit it approves once (two runs at once still give one execution); over a limit it stores
// an ask and the proposal waits for a person; a proposal made before the start date is never
// found or written to; a run that loses a race reports the winner's outcome. A fixed clock; two
// tenants made here and removed after.

const saved = structuredClone(flags.autopilot);
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const clock = () => new Date(NOW);
const CHECKED_AT = new Date(NOW - HOUR / 2).toISOString();

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let pilot: Session;
let ruleId: string;

type Opts = {
  kind?: ProposalKind;
  amountCents?: number;
  ageMs?: number;
  verdict?: "pass" | "concerns" | "block" | null;
  engine?: "matched" | "mismatch" | "unavailable" | null;
  f?: Fixture;
};

// A waiting proposal with the conversation, turn and gateway decision a real one hangs from,
// passed by the auditor and matched by the engine unless told otherwise. Written by the admin
// login so created_at and the checks can be set.
async function addProposal(o: Opts = {}): Promise<string> {
  const f = o.f ?? A;
  const amountCents = o.amountCents ?? 120_000;
  const subject = await addAdvance(admin, f, amountCents);
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const created = new Date(NOW - (o.ageMs ?? HOUR)).toISOString();
  const kind = o.kind ?? "invoice_post";
  const verdict = o.verdict === undefined ? "pass" : o.verdict;
  const engine = o.engine === undefined ? "matched" : o.engine;
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)`,
      [conversation, f.session.sub],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Post it?', 'done', $3,
         CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
      [turn, conversation, trace, created],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark', 'propose_advance',
         'propose', 'allowed', 'ok', 1)`,
      [decision, turn, trace],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, args, operator_verdict, gateway_decision_id,
         dedupe_key, trace_id, created_at, updated_at, auditor_verdict, auditor_agrees, auditor_concerns,
         auditor_checked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, 'advances',
         CAST($5 AS uuid), $6, 'in', 'Post invoice', CAST($7 AS jsonb), 'eligible',
         CAST($8 AS uuid), $9, $10, CAST($11 AS timestamptz), CAST($11 AS timestamptz), $12, $13,
         CAST('[]' AS jsonb), CAST($14 AS timestamptz))`,
      [
        id,
        conversation,
        turn,
        kind,
        subject,
        amountCents,
        JSON.stringify({ amountCents }),
        decision,
        `${kind}:${subject}:${"0".repeat(64)}`,
        trace,
        created,
        verdict,
        verdict === null ? null : verdict === "pass",
        verdict === null ? null : CHECKED_AT,
      ],
    );
    if (engine !== null) {
      await q.execute(
        `UPDATE proposals SET engine_check = $2, engine_cents = $3, engine_checked_at = CAST($4 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id, engine, amountCents, CHECKED_AT],
      );
    }
  });
  return id;
}

type Row = { status: string; decided_by: string | null; decision: Record<string, unknown> | null };
const rowOf = async (id: string, f: Fixture = A): Promise<Row> =>
  (
    await admin.withTenant(f.tenantId, (q) =>
      q.query<Row>(
        `SELECT status, decided_by, autopilot_decision AS decision FROM proposals
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0];

// An executor that only counts its runs: no ledger, no status move past approved.
const ran: string[] = [];
const recorder: Executor = async (_db, _session, p) => {
  ran.push(p.id);
  return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
};
const REGISTRY: ExecutorRegistry = { invoice_post: recorder, card_match: recorder, payment_reapply: recorder };
const run = (id: string, executors: ExecutorRegistry = REGISTRY) =>
  runAutopilot(A.tenantId, id, { db: app, clock, executors });

// The desk's own handler for one proposal of A, as the loop calls it.
const deskRun = (id: string, db: TenantDb = app) =>
  deskHandlers({ db }).autopilot.run(
    A.session,
    {
      eventKey: `autopilot:${id}`,
      source: "autopilot",
      subjectId: id,
      state: "claimed",
      attempts: 1,
      carries: 0,
      threw: 0,
      runId: null,
      found: null,
      firstAt: new Date(NOW).toISOString(),
    },
    { deadlineMs: NOW + 60_000, clock },
  );

// A database on which another run of the autopilot approves the proposal and its executor
// finishes it, right after this run's first look (its second transaction: the session read, then
// the look), so this run's gate finds it already decided.
function racing(id: string): TenantDb {
  let calls = 0;
  return {
    async withTenant(tenantId, fn) {
      const out = await app.withTenant(tenantId, fn);
      calls += 1;
      if (calls === 2) {
        expect(await run(id)).toMatchObject({ ok: true, result: { outcome: "approved" } });
        await app.withTenant(A.tenantId, async (q) => {
          await q.execute(
            "UPDATE proposals SET status = 'executing' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
            [id],
          );
          await q.execute(
            "UPDATE proposals SET status = 'done' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
            [id],
          );
        });
      }
      return out;
    },
  };
}

// A write as the app login; the guard's refusal carries its error code.
const asApp = async (f: Fixture, sql: string, params: Param[]) => {
  const err = await app.withTenant(f.tenantId, (q) => q.execute(sql, params)).then(
    () => undefined,
    (e: unknown) => e as { sqlState?: string; constraint?: string },
  );
  return err === undefined ? "no error" : (err.constraint ?? err.sqlState);
};

const setRule = (mode: string, maxCents: number, dayMaxCents: number, dayMaxCount: number) =>
  admin.withTenant(A.tenantId, (q) =>
    q.execute(
      `UPDATE autopilot_rules SET mode = $2, max_cents = $3, day_max_cents = $4, day_max_count = $5,
              version = version + 1
        WHERE tenant_id = current_tenant_id() AND kind = $1`,
      ["invoice_post", mode, maxCents, dayMaxCents, dayMaxCount],
    ),
  );
const ruleVersion = async () =>
  (
    await admin.withTenant(A.tenantId, (q) =>
      q.query<{ version: number }>(
        "SELECT version FROM autopilot_rules WHERE tenant_id = current_tenant_id() AND kind = 'invoice_post'",
      ),
    )
  )[0].version;

const clearPause = () =>
  admin.withTenant(A.tenantId, (q) => q.execute("DELETE FROM autopilot_state WHERE tenant_id = current_tenant_id()"));

async function addLogins(f: Fixture, slug: string) {
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES
         (current_tenant_id(), $1, $2, 'staff'), (current_tenant_id(), $3, $4, 'staff'),
         (current_tenant_id(), $5, $6, 'admin')`,
      [
        autopilotSub(f.tenantId),
        `autopilot@${slug}.invalid`,
        serviceSub(f.tenantId),
        `sweep@${slug}.invalid`,
        `owner-${f.tenantId}`,
        `owner@${slug}.example`,
      ],
    );
    await q.execute(
      `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, updated_by)
       VALUES (current_tenant_id(), 'invoice_post', 'auto', 150000, 500000, 3, 'setup'),
              (current_tenant_id(), 'card_match', 'auto', 50000, 300000, 40, 'setup')`,
    );
  });
}

describe("the autopilot", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `pilot-a-${tag}`);
    B = await makeTenant(admin, `pilot-b-${tag}`);
    await addLogins(A, `pilot-a-${tag}`);
    await addLogins(B, `pilot-b-${tag}`);
    const s = await autopilotSession(app, A.tenantId);
    if (!s) throw new Error("no autopilot session");
    pilot = s;
    const [r] = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ id: string }>(
        "SELECT CAST(id AS text) AS id FROM autopilot_rules WHERE tenant_id = current_tenant_id() AND kind = 'invoice_post'",
      ),
    );
    ruleId = r.id;
  });

  beforeEach(async () => {
    Object.assign(flags.autopilot, structuredClone(saved), { enabled: true, armed: true });
    ran.length = 0;
    await clearPause();
  });

  afterEach(() => {
    Object.assign(flags.autopilot, structuredClone(saved));
  });

  afterAll(async () => {
    Object.assign(flags.autopilot, structuredClone(saved));
    await dropTenant(admin, A);
    await dropTenant(admin, B);
    await app?.close();
    await admin?.close();
  });

  describe("row-level security", () => {
    it("shows each carrier only its own rules and pause, and refuses a row for another carrier", async () => {
      await setPaused({ sub: `owner-${B.tenantId}`, email: "", tenantId: B.tenantId }, true, { db: app, clock });
      const seen = await app.withTenant(A.tenantId, async (q) => ({
        rules: await q.query<{ tenant_id: string }>("SELECT CAST(tenant_id AS text) AS tenant_id FROM autopilot_rules"),
        state: await q.query("SELECT tenant_id FROM autopilot_state"),
      }));
      expect(seen.rules.length).toBe(2);
      expect(seen.rules.every((r) => r.tenant_id === A.tenantId)).toBe(true);
      expect(seen.state).toEqual([]);
      expect(
        await asApp(
          A,
          `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, updated_by)
           VALUES (CAST($1 AS uuid), 'payment_reapply', 'auto', 1, 1, 1, 'x')`,
          [B.tenantId],
        ),
      ).toBe("42501");
      expect(
        await asApp(A, "INSERT INTO autopilot_state (tenant_id, paused_at, paused_by) VALUES (CAST($1 AS uuid), now(), 'x')", [
          B.tenantId,
        ]),
      ).toBe("42501");
      // A's update of B's pause reaches no row.
      const moved = await app.withTenant(A.tenantId, (q) =>
        q.execute("UPDATE autopilot_state SET paused_at = NULL, paused_by = NULL WHERE tenant_id = CAST($1 AS uuid)", [B.tenantId]),
      );
      expect(moved).toBe(0);
      expect(await asApp(A, "DELETE FROM autopilot_rules WHERE tenant_id = current_tenant_id()", [])).toBe("42501");
    });
  });

  describe("the database's guards", () => {
    it("moves a rule's version by exactly one on a change, and starts it at one", async () => {
      const where = "WHERE tenant_id = current_tenant_id() AND kind = 'card_match'";
      expect(await asApp(A, `UPDATE autopilot_rules SET max_cents = 40000 ${where}`, [])).toBe("23514");
      expect(await asApp(A, `UPDATE autopilot_rules SET max_cents = 40000, version = version + 2 ${where}`, [])).toBe("23514");
      expect(await asApp(A, `UPDATE autopilot_rules SET version = version + 1 ${where}`, [])).toBe("23514");
      expect(await asApp(A, `UPDATE autopilot_rules SET max_cents = 40000, version = version + 1 ${where}`, [])).toBe("no error");
      expect(
        await asApp(
          A,
          `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, version, updated_by)
           VALUES (current_tenant_id(), 'payment_reapply', 'auto', 1, 1, 1, 2, 'x')`,
          [],
        ),
      ).toBe("23514");
      // A limit over a day's limit is refused by the table.
      expect(await asApp(A, `UPDATE autopilot_rules SET max_cents = 900000, version = version + 1 ${where}`, [])).toBe(
        "autopilot_rules_check",
      );
    });

    it("holds a rule's driver's day between one item and the carrier's day, and requires it on a kind that pays a driver", async () => {
      const where = "WHERE tenant_id = current_tenant_id() AND kind = 'card_match'";
      // A change to the driver's day is a change: its version moves by exactly one.
      expect(await asApp(A, `UPDATE autopilot_rules SET driver_day_max_cents = 100000 ${where}`, [])).toBe("23514");
      expect(
        await asApp(A, `UPDATE autopilot_rules SET driver_day_max_cents = 100000, version = version + 1 ${where}`, []),
      ).toBe("no error");
      expect(await asApp(A, `UPDATE autopilot_rules SET driver_day_max_cents = NULL, version = version + 1 ${where}`, [])).toBe(
        "no error",
      );
      // Under one item, over the carrier's day, or negative: refused by the table.
      for (const bad of [1, 300_001, -1]) {
        expect(
          await asApp(A, `UPDATE autopilot_rules SET driver_day_max_cents = $1, version = version + 1 ${where}`, [bad]),
          String(bad),
        ).toBe("autopilot_rules_driver_day_check");
      }
      const insert = (kind: string, driverDay: number | null) =>
        asApp(
          A,
          `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, driver_day_max_cents, updated_by)
           VALUES (current_tenant_id(), $1, 'auto', 100, 1000, 1, $2, 'x')`,
          [kind, driverDay],
        );
      expect(await insert("advance_payout", null)).toBe("autopilot_rules_driver_day_required");
      expect(await insert("money_code", null)).toBe("autopilot_rules_driver_day_required");
      const [shape] = await admin.withoutTenant((q) =>
        q.query<{ type: string; nullable: string; validated: boolean }>(
          `SELECT c.data_type AS type, c.is_nullable AS nullable,
                  (SELECT k.convalidated FROM pg_constraint k
                    WHERE k.conname = 'autopilot_rules_driver_day_required') AS validated
             FROM information_schema.columns c
            WHERE c.table_name = 'autopilot_rules' AND c.column_name = 'driver_day_max_cents'`,
        ),
      );
      expect(shape).toEqual({ type: "bigint", nullable: "YES", validated: true });
    });

    it("refuses a decision written out of turn and an approval by the autopilot login without one", async () => {
      const id = await addProposal();
      const where = "WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)";
      const auto = JSON.stringify({ mode: "auto", reason: "within_limits" });
      // Auto only in the statement that approves as the autopilot login.
      expect(await asApp(A, `UPDATE proposals SET autopilot_decision = CAST($2 AS jsonb) ${where}`, [id, auto])).toBe("23514");
      expect(
        await asApp(
          A,
          `UPDATE proposals SET status = 'approved', decided_by = $3, decided_at = now(), autopilot_decision = CAST($2 AS jsonb) ${where}`,
          [id, auto, A.session.sub],
        ),
      ).toBe("23514");
      // The autopilot login approves nothing without an auto decision.
      expect(
        await asApp(A, `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = now() ${where}`, [
          id,
          autopilotSub(A.tenantId),
        ]),
      ).toBe("23514");
      // An auto decision with nobody, or a person, as the approver; and a decision with no mode.
      expect(
        await asApp(A, `UPDATE proposals SET status = 'approved', decided_at = now(), autopilot_decision = CAST($2 AS jsonb) ${where}`, [
          id,
          auto,
        ]),
      ).toBe("23514");
      expect(
        await asApp(A, `UPDATE proposals SET autopilot_decision = CAST($2 AS jsonb) ${where}`, [id, JSON.stringify({ reason: "x" })]),
      ).toBe("proposals_autopilot_decision_check");
      // Ask is stored once while the proposal waits, and never changes after.
      const ask = JSON.stringify({ mode: "ask", reason: "over_item_limit" });
      expect(await asApp(A, `UPDATE proposals SET autopilot_decision = CAST($2 AS jsonb) ${where}`, [id, ask])).toBe("no error");
      expect(
        await asApp(A, `UPDATE proposals SET autopilot_decision = CAST($2 AS jsonb) ${where}`, [
          id,
          JSON.stringify({ mode: "off", reason: "mode_off" }),
        ]),
      ).toBe("23514");
      expect(await asApp(A, `UPDATE proposals SET autopilot_decision = NULL ${where}`, [id])).toBe("23514");
      // A person still approves an asked proposal; its decision stays.
      expect(
        await asApp(A, `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = now() ${where}`, [id, A.session.sub]),
      ).toBe("no error");
      expect((await rowOf(id)).decision).toEqual({ mode: "ask", reason: "over_item_limit" });
      // A decision never comes with a new row.
      expect(
        await asApp(
          A,
          `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id, amount_cents,
             direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id, autopilot_decision)
           SELECT CAST($2 AS uuid), tenant_id, conversation_id, turn_id, kind, subject_table, subject_id, amount_cents,
             direction, title, args, operator_verdict, gateway_decision_id, dedupe_key || 'x', trace_id, CAST($3 AS jsonb)
             FROM proposals ${where}`,
          [id, randomUUID(), ask],
        ),
      ).toBe("23514");
    });
  });

  describe("the approval gate", () => {
    const opts = () => ({ confirmed: false, autopilot: { ruleId, version: 0 } });

    it("refuses the autopilot login without opts.autopilot, the sweep's login, and opts.autopilot from a person", async () => {
      const id = await addProposal();
      const version = await ruleVersion();
      const deps = { db: app, clock, executors: REGISTRY };
      expect(await executeProposal(pilot, id, { confirmed: false }, deps)).toMatchObject({ ok: false, category: "autopilot_only" });
      expect(await executeProposal(pilot, id, { confirmed: true }, deps)).toMatchObject({ ok: false, category: "autopilot_only" });
      const sweep: Session = { sub: serviceSub(A.tenantId), email: "", tenantId: A.tenantId };
      expect(await executeProposal(sweep, id, { confirmed: false }, deps)).toMatchObject({ ok: false, category: "service_login" });
      expect(
        await executeProposal(sweep, id, { confirmed: false, autopilot: { ruleId, version } }, deps),
      ).toMatchObject({ ok: false, category: "service_login" });
      expect(
        await executeProposal(A.session, id, { confirmed: false, autopilot: { ruleId, version } }, deps),
      ).toMatchObject({ ok: false, category: "autopilot_only" });
      // Nothing a person sends rides with the autopilot's approval.
      for (const extra of [
        { confirmed: true },
        { overrideReason: "The rate sheet changed this week" },
        { auditedAt: CHECKED_AT },
        { edits: {} },
      ]) {
        expect(
          await executeProposal(pilot, id, { confirmed: false, autopilot: { ruleId, version }, ...extra }, deps),
        ).toMatchObject({ ok: false, category: "autopilot_override" });
      }
      // A rule that is not the one read now.
      expect(await executeProposal(pilot, id, opts(), deps)).toMatchObject({ ok: false, category: "autopilot_rule" });
      expect(
        await executeProposal(pilot, id, { confirmed: false, autopilot: { ruleId, version: version + 1 } }, deps),
      ).toMatchObject({ ok: false, category: "autopilot_rule" });
      expect(
        await executeProposal(pilot, id, { confirmed: false, autopilot: { ruleId: randomUUID(), version } }, deps),
      ).toMatchObject({ ok: false, category: "autopilot_rule" });
      expect(ran).toEqual([]);
      expect(await rowOf(id)).toEqual({ status: "proposed", decided_by: null, decision: null });
    });

    it("decides the policy again under the lock: paused, unarmed, a block or a mismatch are refused", async () => {
      const id = await addProposal();
      const version = await ruleVersion();
      const deps = { db: app, clock, executors: REGISTRY };
      const go = (pid = id) => executeProposal(pilot, pid, { confirmed: false, autopilot: { ruleId, version } }, deps);
      await setPaused({ sub: `owner-${A.tenantId}`, email: "", tenantId: A.tenantId }, true, { db: app, clock });
      expect(await go()).toMatchObject({ ok: false, category: "paused" });
      await clearPause();
      flags.autopilot.armed = false;
      expect(await go()).toMatchObject({ ok: false, category: "unarmed" });
      flags.autopilot.armed = true;
      const blocked = await addProposal({ verdict: "block" });
      expect(await go(blocked)).toMatchObject({ ok: false, category: "override_required" });
      const mismatched = await addProposal({ engine: "mismatch" });
      expect(await go(mismatched)).toMatchObject({ ok: false, category: "engine_override_required" });
      expect(ran).toEqual([]);
      for (const p of [id, blocked, mismatched]) expect((await rowOf(p)).status).toBe("proposed");
    });
  });

  describe("a run", () => {
    it("approves inside the limits once, as the autopilot login, with the rule it was decided on", async () => {
      const id = await addProposal();
      const version = await ruleVersion();
      expect(await run(id)).toEqual({ ok: true, result: { outcome: "approved", status: "done", moneyActionId: null } });
      expect(ran).toEqual([id]);
      const row = await rowOf(id);
      expect(row.status).toBe("approved");
      expect(row.decided_by).toBe(autopilotSub(A.tenantId));
      expect(row.decision).toMatchObject({ mode: "auto", reason: "within_limits", ruleId, ruleVersion: version, maxCents: 150_000 });
      // The same proposal again: decided before, never approved twice.
      expect(await run(id)).toEqual({ ok: true, result: { outcome: "earlier", status: "approved", mine: true, asked: true } });
      expect(ran).toEqual([id]);
    });

    it("gives one execution when two runs reach the same proposal at once", async () => {
      const id = await addProposal({ amountCents: 1_000 });
      const both = await Promise.all([run(id), run(id)]);
      expect(ran).toEqual([id]);
      const outcomes = both.map((r) => (r.ok ? r.result.outcome : r.category)).sort();
      expect(outcomes).toEqual(["approved", "earlier"]);
    });

    it("reports a run that lost the race as the winner's outcome, and the desk writes no failure", async () => {
      const id = await addProposal({ kind: "card_match", amountCents: 1_000 });
      expect(await runAutopilot(A.tenantId, id, { db: racing(id), clock, executors: REGISTRY })).toEqual({
        ok: true,
        result: { outcome: "earlier", status: "done", mine: true, asked: true },
      });
      expect(ran).toEqual([id]);
      const other = await addProposal({ kind: "card_match", amountCents: 1_000 });
      expect(await deskRun(other, racing(other))).toEqual({ outcome: "done", detail: { found: 0, category: "executed" } });
      expect(ran).toEqual([id, other]);
    });

    it("leaves a proposal made before the start date untouched, whatever its rule says", async () => {
      flags.autopilot.startDate = "2026-11-03";
      const within = await addProposal({ kind: "card_match", amountCents: 1_000 });
      const over = await addProposal({ kind: "card_match", amountCents: 50_001 });
      const noRule = await addProposal({ kind: "payment_reapply", amountCents: 1_000 });
      for (const id of [within, over, noRule]) {
        expect(await run(id)).toEqual({ ok: true, result: { outcome: "held", reason: "before_start" } });
        expect(await rowOf(id)).toEqual({ status: "proposed", decided_by: null, decision: null });
      }
      expect(await deskRun(within)).toEqual({ outcome: "skipped", detail: { category: "before_start" } });
      expect(await rowOf(within)).toEqual({ status: "proposed", decided_by: null, decision: null });
      expect(ran).toEqual([]);
    });

    it("skips a proposal the gate expired as too old, and the desk writes no failure", async () => {
      flags.autopilot.startDate = "2026-10-01";
      const id = await addProposal({ kind: "card_match", amountCents: 1_000, ageMs: 8 * 24 * HOUR });
      expect(await deskRun(id)).toEqual({ outcome: "skipped", detail: { category: "expired" } });
      expect(await rowOf(id)).toEqual({ status: "expired", decided_by: autopilotSub(A.tenantId), decision: null });
      expect(ran).toEqual([]);
    });

    it("stores an ask over a limit, and the proposal waits for a person", async () => {
      const id = await addProposal({ amountCents: 150_001 });
      expect(await run(id)).toEqual({ ok: true, result: { outcome: "decided", mode: "ask", reason: "over_item_limit" } });
      expect(await rowOf(id)).toMatchObject({ status: "proposed", decided_by: null, decision: { mode: "ask", reason: "over_item_limit" } });
      expect(ran).toEqual([]);
      // Looked at once: a second run writes nothing new.
      expect(await run(id)).toEqual({ ok: true, result: { outcome: "earlier", status: "proposed", mine: false, asked: true } });
    });

    it("counts today's approvals against the day's count", async () => {
      await setRule("auto", 150_000, 500_000, 1);
      try {
        // The day so far: whatever this file approved today already counts, so the limit is
        // reached by the first one at the latest.
        const first = await addProposal({ amountCents: 1_000 });
        const second = await addProposal({ amountCents: 1_000 });
        await run(first);
        const r = await run(second);
        expect(r).toEqual({ ok: true, result: { outcome: "decided", mode: "ask", reason: "over_day_count" } });
      } finally {
        await setRule("auto", 150_000, 500_000, 3);
      }
    });

    it("leaves a kind set to Off, an unverified amount and a concern for a person", async () => {
      const unverified = await addProposal({ kind: "card_match", amountCents: 1_000, engine: "unavailable" });
      expect(await run(unverified)).toMatchObject({ ok: true, result: { outcome: "decided", mode: "ask", reason: "engine_unverified" } });
      const concern = await addProposal({ kind: "card_match", amountCents: 1_000, verdict: "concerns" });
      expect(await run(concern)).toMatchObject({ ok: true, result: { reason: "audit_not_pass" } });
      const noRule = await addProposal({ kind: "payment_reapply", amountCents: 1_000 });
      expect(await run(noRule)).toMatchObject({ ok: true, result: { mode: "ask", reason: "no_rule" } });
      await setRule("off", 150_000, 500_000, 3);
      try {
        const off = await addProposal({ amountCents: 1_000 });
        expect(await run(off)).toMatchObject({ ok: true, result: { outcome: "decided", mode: "off", reason: "mode_off" } });
        expect((await rowOf(off)).decision).toMatchObject({ mode: "off" });
      } finally {
        await setRule("auto", 150_000, 500_000, 3);
      }
      expect(ran).toEqual([]);
    });

    it("holds while paused or unarmed and writes nothing, naming the demo reset's own pause", async () => {
      const id = await addProposal({ amountCents: 1_000 });
      await setPaused({ sub: A.session.sub, email: "", tenantId: A.tenantId }, true, { db: app, clock });
      expect(await run(id)).toEqual({ ok: true, result: { outcome: "held", reason: "paused" } });
      await admin.withTenant(A.tenantId, (q) =>
        q.execute(
          `UPDATE autopilot_state SET paused_by = 'demo_reset', paused_until = CAST($1 AS timestamptz)
            WHERE tenant_id = current_tenant_id()`,
          [new Date(NOW + 30 * 60_000).toISOString()],
        ),
      );
      expect(await run(id)).toEqual({ ok: true, result: { outcome: "held", reason: "reset_pause" } });
      await clearPause();
      flags.autopilot.armed = false;
      expect(await run(id)).toEqual({ ok: true, result: { outcome: "held", reason: "unarmed" } });
      flags.autopilot.enabled = false;
      expect(await run(id)).toEqual({ ok: true, result: { outcome: "held", reason: "switched_off" } });
      expect(await rowOf(id)).toEqual({ status: "proposed", decided_by: null, decision: null });
      expect(ran).toEqual([]);
    });

    it("stores a gate refusal as an ask, and leaves a refusal that may pass later untouched", async () => {
      const stopped: Executor = Object.assign(recorder.bind(null), {
        precheck: async () => ({ ok: false as const, category: "subject_changed", retryable: false }),
      });
      const id = await addProposal({ amountCents: 1_000 });
      expect(await run(id, { invoice_post: stopped })).toEqual({
        ok: true,
        result: { outcome: "decided", mode: "ask", reason: "subject_changed" },
      });
      expect((await rowOf(id)).decision).toMatchObject({ mode: "ask", reason: "gate_refused", gate: "subject_changed" });
      const later: Executor = Object.assign(recorder.bind(null), {
        precheck: async () => ({ ok: false as const, category: "eligibility_unavailable", retryable: true }),
      });
      const other = await addProposal({ amountCents: 1_000 });
      expect(await run(other, { invoice_post: later })).toEqual({
        ok: true,
        result: { outcome: "retry", category: "eligibility_unavailable" },
      });
      expect(await rowOf(other)).toEqual({ status: "proposed", decided_by: null, decision: null });
      expect(ran).toEqual([]);
    });
  });

  describe("the pause switch", () => {
    it("lets staff pause, only an admin resume, and a service login neither", async () => {
      const staff = A.session;
      const owner: Session = { sub: `owner-${A.tenantId}`, email: "", tenantId: A.tenantId };
      expect(await setPaused(staff, true, { db: app, clock })).toEqual({ ok: true, paused: true });
      expect(await setPaused(staff, false, { db: app, clock })).toEqual({ ok: false, category: "role" });
      expect(await setPaused(pilot, false, { db: app, clock })).toEqual({ ok: false, category: "forbidden" });
      const [state] = await admin.withTenant(A.tenantId, (q) =>
        q.query<{ paused_by: string; until: string | null }>(
          "SELECT paused_by, paused_until AS until FROM autopilot_state WHERE tenant_id = current_tenant_id()",
        ),
      );
      expect(state).toEqual({ paused_by: staff.sub, until: null });
      expect(await setPaused(owner, false, { db: app, clock })).toEqual({ ok: true, paused: false });
    });
  });

  describe("the desk's finder", () => {
    const finder = SUBJECT_FINDERS.find((f) => f.source === "autopilot");
    const find = () =>
      app.withTenant(B.tenantId, (q) => {
        if (!finder) throw new Error("no autopilot finder");
        return findSubjects(
          q,
          {
            wakeId: randomUUID(),
            by: "button",
            startInstant: new Date(NOW - 24 * HOUR).toISOString(),
            nowIso: new Date(NOW).toISOString(),
            nowLocal: { date: "2026-11-02", hour: 10 },
            startDate: "2026-11-01",
            watermarks: { card_transactions: "", customer_payments: "", documents: "", load_events: "" },
            budget: 10,
            newId: randomUUID,
          },
          finder,
        );
      });

    it("finds only a passed, matched proposal of a kind on Auto, and nothing until it is armed", async () => {
      const ready = await addProposal({ f: B, amountCents: 1_000 });
      await addProposal({ f: B, amountCents: 1_000, verdict: null });
      await addProposal({ f: B, amountCents: 1_000, engine: "unavailable" });
      await addProposal({ f: B, kind: "payment_reapply", amountCents: 1_000 });
      flags.autopilot.armed = false;
      expect(await find()).toEqual({ seen: 0 });
      flags.autopilot.armed = true;
      expect(await find()).toEqual({ seen: 1 });
      const lines = await admin.withTenant(B.tenantId, (q) =>
        q.query<{ event_key: string; subject_table: string }>(
          "SELECT event_key, subject_table FROM desk_log WHERE tenant_id = current_tenant_id() AND source = 'autopilot'",
        ),
      );
      expect(lines).toEqual([{ event_key: `autopilot:${ready}`, subject_table: "proposals" }]);
      // Found once, ever.
      expect(await find()).toEqual({ seen: 0 });
    });

    it("never finds a kind on Auto whose own ceiling is not armed, so arming it still finds the card", async () => {
      await admin.withTenant(B.tenantId, (q) =>
        q.execute(
          `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, driver_day_max_cents, updated_by)
           VALUES (current_tenant_id(), 'advance_payout', 'auto', 30000, 150000, 10, 30000, 'setup')`,
        ),
      );
      const advance = await addProposal({ f: B, kind: "advance_payout", amountCents: 1_000 });
      expect(flags.autopilot.kinds.advance_payout?.armed).toBe(false);
      expect(await find()).toEqual({ seen: 0 });
      const none = await admin.withTenant(B.tenantId, (q) =>
        q.query("SELECT 1 FROM desk_log WHERE tenant_id = current_tenant_id() AND event_key = $1", [`autopilot:${advance}`]),
      );
      expect(none).toEqual([]);
      const ceiling = flags.autopilot.kinds.advance_payout;
      if (!ceiling) throw new Error("no advance ceiling");
      ceiling.armed = true;
      expect(await find()).toEqual({ seen: 1 });
    });

    it("never finds a proposal made before the autopilot's start date", async () => {
      // The carrier's midnight on Nov 2 is 06:00 UTC; the loop's own floor is a day before now.
      flags.autopilot.startDate = "2026-11-02";
      const early = await addProposal({ f: B, amountCents: 1_000, ageMs: 20 * HOUR });
      const late = await addProposal({ f: B, amountCents: 1_000 });
      expect(await find()).toEqual({ seen: 1 });
      const keys = await admin.withTenant(B.tenantId, (q) =>
        q.query<{ event_key: string }>(
          "SELECT event_key FROM desk_log WHERE tenant_id = current_tenant_id() AND event_key IN ($1, $2)",
          [`autopilot:${early}`, `autopilot:${late}`],
        ),
      );
      expect(keys).toEqual([{ event_key: `autopilot:${late}` }]);
    });
  });

  describe("never alone", () => {
    const insertRule = (kind: string, mode: string) =>
      sqlStateOf(
        app.withTenant(B.tenantId, (q) =>
          q.execute(
            `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, updated_by)
             VALUES (current_tenant_id(), $1, $2, 1000, 1000, 1, 'owner')`,
            [kind, mode],
          ),
        ),
      );

    it("refuses an Auto rule on a never-alone kind as a check violation, and takes Ask me", async () => {
      expect(await insertRule("escrow_release", "auto")).toBe("23514");
      expect(await insertRule("settlement_approve", "auto")).toBe("23514");
      expect(await insertRule("escrow_release", "ask")).toBe("no error");
      // A change to Auto later is refused too, version and all.
      expect(
        await asApp(
          B,
          `UPDATE autopilot_rules SET mode = 'auto', version = version + 1
            WHERE tenant_id = current_tenant_id() AND kind = 'escrow_release'`,
          [],
        ),
      ).toBe("autopilot_rules_auto_allowlist");
      // Off stays the owner's to set.
      expect(
        await asApp(
          B,
          `UPDATE autopilot_rules SET mode = 'off', version = version + 1
            WHERE tenant_id = current_tenant_id() AND kind = 'escrow_release'`,
          [],
        ),
      ).toBe("no error");
      // An allowed kind still takes Auto.
      expect(await insertRule("payment_reapply", "auto")).toBe("no error");
    });

    it("refuses the autopilot login on a never-alone kind at the gate, even when the switch lists it", async () => {
      const id = await addProposal({ kind: "settlement_approve", amountCents: 1_000 });
      const kinds = flags.autopilot.kinds as Record<string, unknown>;
      kinds.settlement_approve = { maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25, armed: true };
      const version = await ruleVersion();
      const deps = { db: app, clock, executors: { ...REGISTRY, settlement_approve: recorder } };
      expect(
        await executeProposal(pilot, id, { confirmed: false, autopilot: { ruleId, version } }, deps),
      ).toEqual({ ok: false, category: "kind_never_alone", retryable: false });
      expect(ran).toEqual([]);
      expect(await rowOf(id)).toEqual({ status: "proposed", decided_by: null, decision: null });
      // The run looks, stores an ask with the reason, and the proposal waits for a person.
      expect(await run(id, deps.executors)).toMatchObject({
        ok: true,
        result: { outcome: "decided", mode: "ask", reason: "kind_never_alone" },
      });
      expect(ran).toEqual([]);
      // A person's approval is unchanged.
      expect(await executeProposal(A.session, id, { confirmed: false }, deps)).toMatchObject({ ok: true });
      expect(ran).toEqual([id]);
      expect((await rowOf(id)).decided_by).toBe(A.session.sub);
    });
  });
});
