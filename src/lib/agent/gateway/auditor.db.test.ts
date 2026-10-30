import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../../config/flags";
import { AiError, type AiResult } from "../../ai";
import type { Session } from "../../auth/claims";
import { createPgDb } from "../../db/pg";
import { adminUrl, appUrl } from "../../db/test-urls";
import type { Db, Param } from "../../db/types";
import { runAudit, runEngineCheck } from "../auditor/run";
import { CLEAN_SQL } from "../proposals/clean";
import { callTool } from "./index";
import { dbAuditStore } from "./store";
import { writeEngineCheck } from "./store/audit";
import type { CompleteFn, GatewayContext, ToolCall } from "./types";

// The auditor's columns (0014) against a real database: the verdict words and their agreement,
// an override only on a block and only 10 to 240 characters with who and when, the guard that
// keeps a verdict and an override from ever changing, the 90-second lease and its attempt count,
// one verdict write, the app role's grants, each carrier's proposals walled off from the other, and Approve all clean's
// filter. Only this file's two tenants are made, and they are removed after.

const A = randomUUID();
const B = randomUUID();
const tag = A.slice(0, 8);
const DRIVER = { [A]: randomUUID(), [B]: randomUUID() };
const T0 = Date.UTC(2026, 10, 2, 15, 0, 0);
const CALL_ID = "c0ffee00-0000-4000-8000-0000000000a1";
const REASON = "Driver showed the fuel receipt in person";

let admin: Db;
let app: Db;
const turnOf: Record<string, { conversation: string; turn: string; decision: string }> = {};

const session = (tenantId: string, sub = `sub-${tenantId}`): Session => ({ sub, email: "", tenantId });

async function seed(tenantId: string, slug: string) {
  const ids = { conversation: randomUUID(), turn: randomUUID(), decision: randomUUID() };
  turnOf[tenantId] = ids;
  await admin.withTenant(tenantId, async (q) => {
    await q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
      [slug, `Carrier ${slug}`],
    );
    await q.execute(
      "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
      [`sub-${tenantId}`, `ops@${slug}.example`],
    );
    await q.execute(
      `INSERT INTO drivers (id, tenant_id, code, first_name, last_name, email, worker_type, pay_basis,
         per_mile_cents, active_from)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'AU-1', 'Sam', 'Rivera', $2, 'company', 'per_mile', 60,
         CAST('2026-01-05' AS date))`,
      [DRIVER[tenantId], `sam@${slug}.example`],
    );
    await q.execute(
      "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
      [ids.conversation, `sub-${tenantId}`],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Can AU-1 get an advance?', 'done',
         'trace-audit', CAST($3 AS timestamptz), CAST($3 AS timestamptz))`,
      [ids.turn, ids.conversation, new Date(T0 - 3_600_000).toISOString()],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'trace-audit', 'operator', 'spark',
         'propose_advance', 'propose', 'allowed', 'ok', 1)`,
      [ids.decision, ids.turn],
    );
  });
}

type Audit = { verdict: string; agrees: boolean | null; concerns?: readonly string[]; checkedAt?: string };

// A waiting proposal, written by the admin login so created_at and a verdict can be set. The
// subject is the tenant's driver when asked, else a fresh id, so each proposal waits on its own.
async function addProposal(tenantId: string, o: { audit?: Audit; onDriver?: boolean; createdAt?: string } = {}) {
  const id = randomUUID();
  const subject = o.onDriver ? DRIVER[tenantId] : randomUUID();
  const t = turnOf[tenantId];
  const created = o.createdAt ?? new Date(T0 - 3_600_000).toISOString();
  await admin.withTenant(tenantId, (q) =>
    q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, args, sources, operator_verdict, gateway_decision_id, dedupe_key,
         trace_id, auditor_verdict, auditor_agrees, auditor_concerns, auditor_checked_at, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'advance_payout',
         'drivers', CAST($4 AS uuid), 20000, 'out', 'Pay advance', CAST($5 AS jsonb), CAST($6 AS jsonb),
         'eligible', CAST($7 AS uuid), $8, 'trace-audit', $9, $10, CAST($11 AS jsonb),
         CAST($12 AS timestamptz), CAST($13 AS timestamptz), CAST($13 AS timestamptz))`,
      [
        id,
        t.conversation,
        t.turn,
        subject,
        JSON.stringify({ driverId: subject, amountCents: 20_000, reasonCategories: ["driver_asked"] }),
        JSON.stringify([{ table: "drivers", id: subject }]),
        t.decision,
        `advance_payout:${subject}:${"0".repeat(64)}`,
        o.audit?.verdict ?? null,
        o.audit ? o.audit.agrees : null,
        JSON.stringify(o.audit?.concerns ?? []),
        o.audit ? (o.audit.checkedAt ?? new Date(T0 - 1_800_000).toISOString()) : null,
        created,
      ],
    ),
  );
  return id;
}

async function sqlStateOf(work: Promise<unknown>): Promise<string | undefined> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return (err as { sqlState?: string }).sqlState;
}

const asAdmin = (sql: string, params: Param[]) => admin.withTenant(A, (q) => q.execute(sql, params));

type AuditRow = {
  auditor_verdict: string | null;
  auditor_agrees: boolean | null;
  auditor_call_id: string | null;
  concerns: string;
  started_at: string | null;
  attempts: number;
  checked_at: string | null;
  trace_id: string | null;
};

const auditRow = async (tenantId: string, id: string) =>
  (
    await admin.withTenant(tenantId, (q) =>
      q.query<AuditRow>(
        `SELECT auditor_verdict, auditor_agrees, CAST(auditor_call_id AS text) AS auditor_call_id,
                CAST(auditor_concerns AS text) AS concerns,
                to_char(auditor_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
                CAST(auditor_attempts AS integer) AS attempts,
                to_char(auditor_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS checked_at,
                CAST(auditor_trace_id AS text) AS trace_id
           FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id],
      ),
    )
  )[0];

// The gateway's evidence deadline reads this clock, so an audit run never depends on the real date.
const gatewayAt = (at: number) => (ctx: GatewayContext, call: ToolCall) => callTool(ctx, call, { db: app, clock: () => at });

const passModel = (calls: { n: number }): CompleteFn => async () => {
  calls.n += 1;
  return {
    callId: CALL_ID,
    status: "ok",
    text: JSON.stringify({
      verdict: "pass",
      concerns: [],
      checks: ["cause", "sources", "amount", "limit"].map((name) => ({ name, pass: true, note: "holds" })),
    }),
    toolCalls: [],
    usage: { input: 900, cached: 0, output: 300, reasoning: 200 },
    costNanocents: 1,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  } satisfies AiResult;
};

describe("the auditor on a real database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await seed(A, `audit-a-${tag}`);
    await seed(B, `audit-b-${tag}`);
  });

  afterEach(() => {
    flags.auditorEnabled = false;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    flags.auditorEnabled = false;
    for (const id of [A, B]) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("takes the four verdict words with their agreement and refuses the old ones", async () => {
    for (const audit of [
      { verdict: "pass", agrees: true },
      { verdict: "concerns", agrees: false, concerns: ["source_missing"] },
      { verdict: "block", agrees: false, concerns: ["amount_wrong"] },
      { verdict: "unknown", agrees: null, concerns: ["budget"] },
    ]) {
      const id = await addProposal(A, { audit });
      expect((await auditRow(A, id)).auditor_verdict).toBe(audit.verdict);
    }
    const bad: [string, Audit][] = [
      ["agree", { verdict: "agree", agrees: true }],
      ["disagree", { verdict: "disagree", agrees: false }],
      ["pass that disagrees", { verdict: "pass", agrees: false }],
      ["block that agrees", { verdict: "block", agrees: true }],
      ["unknown that agrees", { verdict: "unknown", agrees: true }],
    ];
    for (const [name, audit] of bad) {
      expect(await sqlStateOf(addProposal(A, { audit })), name).toBe("23514");
    }
    // A verdict with no time, and concerns that are not a list.
    const id = await addProposal(A);
    expect(
      await sqlStateOf(asAdmin("UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true WHERE id = CAST($1 AS uuid)", [id])),
    ).toBe("23514");
    expect(
      await sqlStateOf(asAdmin(`UPDATE proposals SET auditor_concerns = CAST('{"a":1}' AS jsonb) WHERE id = CAST($1 AS uuid)`, [id])),
    ).toBe("23514");
    // A new proposal has no attempts, and the count is never below zero.
    expect((await auditRow(A, id)).attempts).toBe(0);
    expect(await sqlStateOf(asAdmin("UPDATE proposals SET auditor_attempts = -1 WHERE id = CAST($1 AS uuid)", [id]))).toBe("23514");
  });

  it("takes an override only on a block, 10 to 240 characters, with who and when", async () => {
    const pass = await addProposal(A, { audit: { verdict: "pass", agrees: true } });
    const block = await addProposal(A, { audit: { verdict: "block", agrees: false, concerns: ["amount_wrong"] } });
    const set = (id: string, reason: string, by: string | null = "sub-x", at: string | null = new Date(T0).toISOString()) =>
      asAdmin(
        `UPDATE proposals SET status = 'approved', decided_by = 'sub-x', decided_at = now(),
                auditor_override_reason = $2, auditor_override_by = $3,
                auditor_override_at = CAST($4 AS timestamptz) WHERE id = CAST($1 AS uuid)`,
        [id, reason, by, at],
      );
    expect(await sqlStateOf(set(pass, REASON)), "on a pass").toBe("23514");
    expect(await sqlStateOf(set(block, "a".repeat(9))), "nine characters").toBe("23514");
    expect(await sqlStateOf(set(block, "a".repeat(241))), "241 characters").toBe("23514");
    expect(await sqlStateOf(set(block, REASON, null, null)), "no who or when").toBe("23514");
    expect(await sqlStateOf(set(block, REASON, "sub-x", null)), "no when").toBe("23514");
    expect(await set(block, "a".repeat(240))).toBe(1);
  });

  it("never changes a verdict or an override once set, and sets an override only with the approval", async () => {
    const id = await addProposal(A, { audit: { verdict: "block", agrees: false, concerns: ["amount_wrong"] } });
    for (const [name, sql] of [
      ["verdict", "UPDATE proposals SET auditor_verdict = 'concerns' WHERE id = CAST($1 AS uuid)"],
      ["concerns", `UPDATE proposals SET auditor_concerns = CAST('["source_missing"]' AS jsonb) WHERE id = CAST($1 AS uuid)`],
      ["checked at", "UPDATE proposals SET auditor_checked_at = now() WHERE id = CAST($1 AS uuid)"],
      ["cleared", "UPDATE proposals SET auditor_verdict = NULL, auditor_agrees = NULL, auditor_checked_at = NULL WHERE id = CAST($1 AS uuid)"],
    ] as const) {
      expect(await sqlStateOf(asAdmin(sql, [id])), name).toBe("23514");
    }
    await asAdmin("UPDATE proposals SET auditor_call_id = CAST($2 AS uuid) WHERE id = CAST($1 AS uuid)", [id, CALL_ID]);
    expect(
      await sqlStateOf(asAdmin("UPDATE proposals SET auditor_call_id = gen_random_uuid() WHERE id = CAST($1 AS uuid)", [id])),
      "call id",
    ).toBe("23514");

    // An override alone, on a proposal that stays where it is, is refused; with the approval it is taken.
    const override = `UPDATE proposals SET auditor_override_reason = $2, auditor_override_by = 'sub-x',
                             auditor_override_at = now() WHERE id = CAST($1 AS uuid)`;
    const withApproval = `UPDATE proposals SET status = 'approved', decided_by = 'sub-x', decided_at = now(),
                                 auditor_override_reason = $2, auditor_override_by = 'sub-x',
                                 auditor_override_at = now() WHERE id = CAST($1 AS uuid)`;
    expect(await sqlStateOf(asAdmin(override, [id, REASON])), "while it waits").toBe("23514");
    expect(await asAdmin(withApproval, [id, REASON])).toBe(1);
    for (const [name, sql] of [
      ["reason", "UPDATE proposals SET auditor_override_reason = 'A different reason here' WHERE id = CAST($1 AS uuid)"],
      ["who", "UPDATE proposals SET auditor_override_by = 'sub-y' WHERE id = CAST($1 AS uuid)"],
      ["when", "UPDATE proposals SET auditor_override_at = now() - interval '1 day' WHERE id = CAST($1 AS uuid)"],
      ["cleared", "UPDATE proposals SET auditor_override_reason = NULL, auditor_override_by = NULL, auditor_override_at = NULL WHERE id = CAST($1 AS uuid)"],
    ] as const) {
      expect(await sqlStateOf(asAdmin(sql, [id])), name).toBe("23514");
    }

    // A decided block takes no override afterwards.
    const decided = await addProposal(A, { audit: { verdict: "block", agrees: false, concerns: ["amount_wrong"] } });
    await asAdmin(
      "UPDATE proposals SET status = 'rejected', decided_by = 'sub-x', decided_at = now() WHERE id = CAST($1 AS uuid)",
      [decided],
    );
    expect(await sqlStateOf(asAdmin(override, [decided, REASON])), "after a decision").toBe("23514");
  });

  it("lets the app role take the lease once per 90 seconds, count each one, give it back, and write the verdict once", async () => {
    const id = await addProposal(A);
    const store = dbAuditStore(session(A), { db: app });
    const t1 = new Date(T0);
    const first = await store.lease(id, t1, 90_000, randomUUID());
    expect(first).toEqual({ traceId: expect.stringMatching(/^[0-9a-f-]{36}$/), attempts: 1 });
    const trace = first?.traceId;
    // A lease refused while it is held counts nothing.
    expect(await store.lease(id, new Date(T0 + 30_000), 90_000, randomUUID())).toBeNull();
    expect(await store.lease(id, new Date(T0 + 89_999), 90_000, randomUUID())).toBeNull();
    expect((await auditRow(A, id)).attempts).toBe(1);

    // Past 90 seconds the lease is free again, and the first trace is kept.
    const t2 = new Date(T0 + 90_000);
    expect(await store.lease(id, t2, 90_000, randomUUID())).toEqual({ traceId: trace, attempts: 2 });
    // Giving back a lease this caller no longer holds changes nothing.
    await store.release(id, t1);
    expect((await auditRow(A, id)).started_at).toBe(t2.toISOString());
    await store.release(id, t2);
    expect((await auditRow(A, id)).started_at).toBeNull();
    const t3 = new Date(T0 + 91_000);
    expect(await store.lease(id, t3, 90_000, randomUUID())).toEqual({ traceId: trace, attempts: 3 });

    const now = new Date(T0 + 95_000);
    expect(await store.write(id, { verdict: "concerns", agrees: false, callId: CALL_ID, concerns: ["source_missing"] }, now, t3)).toBe(true);
    expect(await store.write(id, { verdict: "pass", agrees: true, callId: null, concerns: [] }, now, t3)).toBe(false);
    expect(await auditRow(A, id)).toMatchObject({
      auditor_verdict: "concerns",
      auditor_agrees: false,
      auditor_call_id: CALL_ID,
      concerns: '["source_missing"]',
      checked_at: now.toISOString(),
      trace_id: trace,
      attempts: 3,
    });
    // A checked proposal takes no lease.
    expect(await store.lease(id, new Date(T0 + 500_000), 90_000, randomUUID())).toBeNull();
    expect(await store.read(id)).toMatchObject({ verdict: "concerns", concerns: ["source_missing"], checkedAt: now.toISOString() });
  });

  it("refuses the verdict of a run whose lease lapsed and was taken over, and keeps the newer run's", async () => {
    const id = await addProposal(A);
    const store = dbAuditStore(session(A), { db: app });
    // Runner A leases; its call outlives the 90 seconds, so runner B takes the lease.
    const tA = new Date(T0);
    const lateA = await store.lease(id, tA, 90_000, randomUUID());
    expect(lateA).toMatchObject({ attempts: 1 });
    const tB = new Date(T0 + 90_000);
    expect(await store.lease(id, tB, 90_000, randomUUID())).toEqual({ traceId: lateA?.traceId, attempts: 2 });

    // A answers first, under the lease it no longer holds: nothing changes.
    const aAt = new Date(T0 + 95_000);
    expect(await store.write(id, { verdict: "pass", agrees: true, callId: CALL_ID, concerns: [] }, aAt, tA)).toBe(false);
    expect(await auditRow(A, id)).toMatchObject({
      auditor_verdict: null,
      auditor_agrees: null,
      auditor_call_id: null,
      concerns: "[]",
      checked_at: null,
      started_at: tB.toISOString(),
      attempts: 2,
    });

    // B answers under its own lease, and its verdict is the one stored.
    const bAt = new Date(T0 + 100_000);
    expect(await store.write(id, { verdict: "block", agrees: false, callId: null, concerns: ["amount_wrong"] }, bAt, tB)).toBe(true);
    expect(await auditRow(A, id)).toMatchObject({
      auditor_verdict: "block",
      auditor_agrees: false,
      auditor_call_id: null,
      concerns: '["amount_wrong"]',
      checked_at: bAt.toISOString(),
      started_at: tB.toISOString(),
      attempts: 2,
    });

    // A lease given back also writes nothing: a released lease is no one's.
    const other = await addProposal(A);
    const t1 = new Date(T0);
    expect(await store.lease(other, t1, 90_000, randomUUID())).not.toBeNull();
    await store.release(other, t1);
    expect(await store.write(other, { verdict: "pass", agrees: true, callId: null, concerns: [] }, new Date(T0 + 1_000), t1)).toBe(false);
    expect(await auditRow(A, other)).toMatchObject({ auditor_verdict: null, checked_at: null, started_at: null });
  });

  it("keeps each carrier's proposals to itself, for the store and for get_proposal", async () => {
    const id = await addProposal(A, { onDriver: true });
    const storeB = dbAuditStore(session(B), { db: app });
    expect(await storeB.read(id)).toBeNull();
    expect(await storeB.lease(id, new Date(T0), 90_000, randomUUID())).toBeNull();
    expect(await auditRow(A, id)).toMatchObject({ auditor_verdict: null, started_at: null });
    // Even with a lease the owner holds, the other carrier's write finds no row.
    const leasedAt = new Date(T0);
    expect(await dbAuditStore(session(A), { db: app }).lease(id, leasedAt, 90_000, randomUUID())).not.toBeNull();
    expect(await storeB.write(id, { verdict: "pass", agrees: true, callId: null, concerns: [] }, leasedAt, leasedAt)).toBe(false);
    expect(await auditRow(A, id)).toMatchObject({ auditor_verdict: null, started_at: leasedAt.toISOString() });

    const ctx = (tenantId: string, over: Partial<GatewayContext> = {}): GatewayContext => ({
      session: session(tenantId),
      role: "auditor",
      model: "wonder",
      turnId: turnOf[tenantId].turn,
      traceId: randomUUID(),
      now: new Date(T0),
      deadlineAt: T0 + 60_000,
      timeZone: "America/New_York",
      ...over,
    });
    const call = { id: "c", name: "get_proposal", argumentsJson: JSON.stringify({ proposalId: id }) };
    expect(await callTool(ctx(B), call, { db: app, clock: () => T0 })).toMatchObject({
      decision: "blocked",
      reason: "unknown_record",
    });
    const mine = await callTool(ctx(A), call, { db: app, clock: () => T0 });
    if (mine.decision !== "allowed") throw new Error(`not allowed: ${mine.reason}`);
    expect(mine.result).toMatchObject({ proposal: { id, kind: "advance_payout", subject: { label: "AU-1" } } });
    // The operator never reads it.
    expect(await callTool(ctx(A, { role: "operator", model: "spark" }), call, { db: app, clock: () => T0 })).toMatchObject({
      decision: "denied",
      reason: "role_not_allowed",
    });
  });

  it("never puts a person's override reason in the auditor's pack", async () => {
    const id = await addProposal(A, { audit: { verdict: "block", agrees: false, concerns: ["amount_wrong"] } });
    await asAdmin(
      `UPDATE proposals SET status = 'approved', decided_by = 'sub-x', decided_at = now(),
              auditor_override_reason = $2, auditor_override_by = 'sub-x', auditor_override_at = now()
        WHERE id = CAST($1 AS uuid)`,
      [id, REASON],
    );
    const out = await callTool(
      {
        session: session(A),
        role: "auditor",
        model: "wonder",
        turnId: turnOf[A].turn,
        traceId: randomUUID(),
        now: new Date(T0),
        deadlineAt: T0 + 60_000,
        timeZone: "America/New_York",
      },
      { id: "c", name: "get_proposal", argumentsJson: JSON.stringify({ proposalId: id }) },
      { db: app, clock: () => T0 },
    );
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(JSON.stringify(out.result)).not.toContain("fuel receipt");
    expect(JSON.stringify(out.result)).not.toContain("override");
  });

  it("audits end to end as the app role: one call, one decision on the audit's trace, the verdict stored", async () => {
    flags.auditorEnabled = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await addProposal(B, { onDriver: true });
    const calls = { n: 0 };
    const deps = {
      db: app,
      clock: () => new Date(T0),
      callTool: gatewayAt(T0),
      complete: passModel(calls),
      env: { META_MODEL_WONDER: "muse-wonder-1.0" },
    };
    const out = await runAudit(session(B), id, deps);
    expect(out).toEqual({ state: "done", verdict: "pass", concerns: [], checkedAt: new Date(T0).toISOString() });
    expect(calls.n).toBe(1);
    const row = await auditRow(B, id);
    expect(row).toMatchObject({ auditor_verdict: "pass", auditor_agrees: true, auditor_call_id: CALL_ID });
    const decisions = await admin.withTenant(B, (q) =>
      q.query<{ role: string; model: string; tool: string; decision: string }>(
        "SELECT role, model, tool, decision FROM gateway_decisions WHERE tenant_id = current_tenant_id() AND trace_id = $1",
        [row.trace_id],
      ),
    );
    expect(decisions).toEqual([{ role: "auditor", model: "wonder", tool: "get_proposal", decision: "allowed" }]);

    // Again: read back, no second call.
    expect(await runAudit(session(B), id, deps)).toMatchObject({ state: "done", verdict: "pass" });
    expect(calls.n).toBe(1);
    // Another carrier cannot find it.
    expect(await runAudit(session(A), id, deps)).toEqual({ state: "not_found" });
    // One from before the start date is never audited.
    const old = await addProposal(B, { createdAt: "2026-10-26T12:00:00.000Z" });
    expect(await runAudit(session(B), old, deps)).toEqual({ state: "not_auditable" });
    expect(calls.n).toBe(1);
  });

  it("writes no verdict on a proposal decided after the lease", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = dbAuditStore(session(A), { db: app });
    for (const status of ["rejected", "expired"]) {
      const id = await addProposal(A);
      const leasedAt = new Date(T0);
      expect(await store.lease(id, leasedAt, 90_000, randomUUID()), status).not.toBeNull();
      await asAdmin(
        "UPDATE proposals SET status = $2, decided_by = 'sub-x', decided_at = now() WHERE id = CAST($1 AS uuid)",
        [id, status],
      );
      const verdict = { verdict: "pass", agrees: true, callId: CALL_ID, concerns: [] };
      expect(await store.write(id, verdict, new Date(T0 + 5_000), leasedAt), status).toBe(false);
      expect(await auditRow(A, id), status).toMatchObject({ auditor_verdict: null, auditor_call_id: null, checked_at: null });
    }

    // End to end: a reject that lands during the call leaves no verdict, and none is reported.
    flags.auditorEnabled = true;
    const id = await addProposal(A);
    const rejecting: CompleteFn = async (...args) => {
      await asAdmin(
        "UPDATE proposals SET status = 'rejected', decided_by = 'sub-x', decided_at = now() WHERE id = CAST($1 AS uuid)",
        [id],
      );
      return passModel({ n: 0 })(...args);
    };
    const out = await runAudit(session(A), id, {
      db: app,
      clock: () => new Date(T0),
      callTool: gatewayAt(T0),
      complete: rejecting,
      env: { META_MODEL_WONDER: "muse-wonder-1.0" },
    });
    expect(out).toEqual({ state: "not_auditable" });
    expect(await auditRow(A, id)).toMatchObject({ auditor_verdict: null, checked_at: null });
  });

  it("gives the lease back as the app role when Meta is busy, and the retry stores the verdict on the same trace", async () => {
    flags.auditorEnabled = true;
    const id = await addProposal(B);
    const env = { META_MODEL_WONDER: "muse-wonder-1.0" };
    let busyCalls = 0;
    const busy: CompleteFn = async () => {
      busyCalls += 1;
      throw new AiError("rate_limited", 429);
    };
    const first = { db: app, clock: () => new Date(T0), callTool: gatewayAt(T0), complete: busy, env };
    expect(await runAudit(session(B), id, first)).toEqual({ state: "in_progress" });
    expect(busyCalls).toBe(1);
    const before = await auditRow(B, id);
    expect(before).toMatchObject({ auditor_verdict: null, started_at: null, checked_at: null });
    expect(before.trace_id).toMatch(/^[0-9a-f-]{36}$/);

    // The page's retry, well inside the 90 seconds: the lease is free again.
    const calls = { n: 0 };
    const later = new Date(T0 + 1_000);
    const retry = { db: app, clock: () => later, callTool: gatewayAt(later.getTime()), complete: passModel(calls), env };
    const out = await runAudit(session(B), id, retry);
    expect(out).toEqual({ state: "done", verdict: "pass", concerns: [], checkedAt: later.toISOString() });
    expect(calls.n).toBe(1);
    expect(await auditRow(B, id)).toMatchObject({ auditor_verdict: "pass", trace_id: before.trace_id });
  });

  it("stores unknown as the app role on the third failed attempt, and a fourth page load makes no call", async () => {
    flags.auditorEnabled = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await addProposal(B);
    const env = { META_MODEL_WONDER: "muse-wonder-1.0" };
    // A timeout, an answer cut short at the output budget, then Meta busy: each would give the lease back.
    let failing = 0;
    const failures: CompleteFn = async (...args) => {
      failing += 1;
      if (failing === 1) throw new AiError("timeout");
      if (failing === 2) return { ...(await passModel({ n: 0 })(...args)), status: "incomplete", text: '{"verdict":"pa' };
      throw new AiError("unavailable", 503);
    };
    const at = (n: number) => {
      const when = new Date(T0 + n * 1_000);
      return { db: app, clock: () => when, callTool: gatewayAt(when.getTime()), complete: failures, env };
    };
    for (const n of [0, 1]) {
      expect(await runAudit(session(B), id, at(n)), `attempt ${n + 1}`).toEqual({ state: "in_progress" });
      expect(await auditRow(B, id), `attempt ${n + 1}`).toMatchObject({ auditor_verdict: null, started_at: null, attempts: n + 1 });
    }
    const third = new Date(T0 + 2_000).toISOString();
    expect(await runAudit(session(B), id, at(2))).toEqual({
      state: "done",
      verdict: "unknown",
      concerns: ["insufficient_evidence"],
      checkedAt: third,
    });
    expect(failing).toBe(3);
    const row = await auditRow(B, id);
    expect(row).toMatchObject({
      auditor_verdict: "unknown",
      auditor_agrees: null,
      auditor_call_id: null,
      concerns: '["insufficient_evidence"]',
      checked_at: third,
      started_at: third,
      attempts: 3,
    });
    // The three attempts read their evidence on the one audit trace.
    const reads = await admin.withTenant(B, (q) =>
      q.query<{ n: number }>(
        "SELECT CAST(count(*) AS integer) AS n FROM gateway_decisions WHERE tenant_id = current_tenant_id() AND trace_id = $1",
        [row.trace_id],
      ),
    );
    expect(reads).toEqual([{ n: 3 }]);

    // A fourth page load, past the lease: the stored verdict is read back, with no lease and no call.
    const calls = { n: 0 };
    const fourth = new Date(T0 + 200_000);
    const out = await runAudit(session(B), id, {
      db: app,
      clock: () => fourth,
      callTool: gatewayAt(fourth.getTime()),
      complete: passModel(calls),
      env,
    });
    expect(out).toEqual({ state: "done", verdict: "unknown", concerns: ["insufficient_evidence"], checkedAt: third });
    expect(calls.n).toBe(0);
    expect(failing).toBe(3);
    expect((await auditRow(B, id)).attempts).toBe(3);
  });

  it("finds only the waiting pass with Approve all clean's filter", async () => {
    const ids: Record<string, string> = {};
    for (const [name, audit] of [
      ["pass", { verdict: "pass", agrees: true }],
      ["concerns", { verdict: "concerns", agrees: false, concerns: ["source_missing"] }],
      ["block", { verdict: "block", agrees: false, concerns: ["amount_wrong"] }],
      ["unknown", { verdict: "unknown", agrees: null, concerns: ["insufficient_evidence"] }],
      ["none", undefined],
    ] as const) {
      ids[name] = await addProposal(B, { audit });
    }
    const rows = await app.withTenant(B, (q) =>
      q.query<{ id: string }>(
        `SELECT CAST(p.id AS text) AS id FROM proposals p
          WHERE p.tenant_id = current_tenant_id() AND p.id = ANY(CAST($1 AS uuid[])) AND ${CLEAN_SQL}`,
        [`{${Object.values(ids).join(",")}}`],
      ),
    );
    expect(rows).toEqual([{ id: ids.pass }]);
  });

  // The code-side engine check (0045), stored by the app role.
  type EngineRow = { check: string | null; cents: string | null; checked_at: string | null; exceptions: string[] };
  const engineRow = async (tenantId: string, id: string) =>
    (
      await admin.withTenant(tenantId, (q) =>
        q.query<EngineRow>(
          `SELECT engine_check AS check, CAST(engine_cents AS text) AS cents,
                  to_char(engine_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS checked_at,
                  exceptions
             FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [id],
        ),
      )
    )[0];

  it("stores the engine check as the app role in the same run as the verdict, at the lease's instant", async () => {
    flags.auditorEnabled = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await addProposal(B);
    const calls = { n: 0 };
    const deps = { db: app, clock: () => new Date(T0), callTool: gatewayAt(T0), complete: passModel(calls), env: { META_MODEL_WONDER: "muse-wonder-1.0" } };
    expect(await runAudit(session(B), id, deps)).toMatchObject({ state: "done", verdict: "pass" });
    const row = await engineRow(B, id);
    expect(["matched", "mismatch", "unavailable"]).toContain(row.check);
    expect(row.checked_at).toBe(new Date(T0).toISOString());
    // A mismatch is an exception on the card, once; anything else adds none.
    expect(row.exceptions).toEqual(row.check === "mismatch" ? ["engine_mismatch"] : []);
  });

  it("runs the engine check alone with no call: once, only while the proposal waits, and only on its carrier", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const at = (ms: number) => ({ db: app, clock: () => new Date(T0 + ms) });
    // The auditor is off, and a verdict is already stored: the check still runs, with no model.
    const passed = await addProposal(B, { audit: { verdict: "pass", agrees: true } });
    await runEngineCheck(session(B), passed, at(0));
    const first = await engineRow(B, passed);
    expect(first.check).not.toBeNull();
    expect(first.checked_at).toBe(new Date(T0).toISOString());
    // Again later: left as it is.
    await runEngineCheck(session(B), passed, at(60_000));
    expect(await engineRow(B, passed)).toEqual(first);
    expect(await auditRow(B, passed)).toMatchObject({ auditor_verdict: "pass", attempts: 0 });

    // Another carrier cannot reach it; a decided proposal is left unchecked.
    const theirs = await addProposal(B);
    await runEngineCheck(session(A), theirs, at(0));
    expect(await engineRow(B, theirs)).toMatchObject({ check: null, checked_at: null });
    const decided = await addProposal(B);
    await admin.withTenant(B, (q) =>
      q.execute(
        `UPDATE proposals SET status = 'rejected', decided_by = 'someone', decided_at = now()
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [decided],
      ),
    );
    await runEngineCheck(session(B), decided, at(0));
    expect(await engineRow(B, decided)).toMatchObject({ check: null, checked_at: null });
  });

  it("writes a check once, a mismatch adds one exception, and Approve all clean's filter then leaves it out", async () => {
    const id = await addProposal(B, { audit: { verdict: "pass", agrees: true } });
    const write = (check: "matched" | "mismatch", ms: number) =>
      app.withTenant(B, (q) => writeEngineCheck(q, id, { check, engineCents: 19_999 }, new Date(T0 + ms)));
    expect(await write("mismatch", 0)).toBe(true);
    expect(await write("matched", 1_000)).toBe(false);
    expect(await write("mismatch", 2_000)).toBe(false);
    expect(await engineRow(B, id)).toEqual({
      check: "mismatch",
      cents: "19999",
      checked_at: new Date(T0).toISOString(),
      exceptions: ["engine_mismatch"],
    });
    const clean = await app.withTenant(B, (q) =>
      q.query<{ id: string }>(
        `SELECT CAST(p.id AS text) AS id FROM proposals p
          WHERE p.tenant_id = current_tenant_id() AND p.id = CAST($1 AS uuid) AND ${CLEAN_SQL}`,
        [id],
      ),
    );
    expect(clean).toEqual([]);
  });
});
