import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../config/flags";
import type { AuditResult } from "../../agent/auditor/run";
import { readSweepTurnTrace } from "../../agent/gateway/store";
import { reasonSentence } from "../../agent/reasons";
import type { Explained } from "../../agent/sweep/explain";
import type { AiRequest, AiResult, AiToolCall } from "../../ai";
import { NANOCENTS_PER_CENT } from "../../ai/prices";
import type { Session } from "../../auth/claims";
import { createPgDb } from "../../db/pg";
import { adminUrl, appUrl } from "../../db/test-urls";
import type { Db, Param } from "../../db/types";
import { DEMO_CARRIERS, type DemoCarrier } from "../../seed/carriers";
import { buildCarrierPlan } from "../../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../../seed/run";
import { advanceSweep, startSweep, type SweepDeps } from "../run";
import { readSweepPage } from "../view";
import { reserveRunCents, settleRunCents } from "./limits";

// The sweep's second opinion against the real database, as the app's role, with the real
// gateway, turn store and record reads. Only the model is a stand-in: it orders the roster as
// given, reads each driver's loads once and flags the first load it read, which the engine never
// does, so every flag is one only a check raised. One tenant seeded with the demo plan, and a
// second, empty carrier for the walls between them; both removed after.

const ANCHOR = "2026-11-02";
const NOW = new Date("2026-11-02T16:00:00.000Z");
const clock = () => NOW;
const SLICE = 20_000;
const CARRIER = { ...DEMO_CARRIERS[0], slug: "sweep-fanout-test", name: "Sweep Fanout Test" } as unknown as DemoCarrier;
const plan = buildCarrierPlan(CARRIER, ANCHOR);
const T = randomUUID();
const OTHER = randomUUID();
const SESSION: Session = { sub: `sub-${T}`, email: "ops@sweep-fanout-test.example", tenantId: T };
const OTHER_SESSION: Session = { sub: `sub-${OTHER}`, email: "ops@sweep-fanout-other.example", tenantId: OTHER };
const saved = { ...flags, sweepLimits: { ...flags.sweepLimits }, fanoutLimits: { ...flags.fanoutLimits } };

let admin: Db;
let app: Db;

const explain = vi.fn(
  async (): Promise<Explained> => ({
    ok: true,
    text: "The engine found this and the fix corrects it.",
    callId: randomUUID(),
    costNanocents: 2 * NANOCENTS_PER_CENT,
  }),
);

async function storePass(proposalId: string): Promise<AuditResult> {
  await admin.withTenant(T, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_checked_at = CAST($2 AS timestamptz)
        WHERE id = CAST($1 AS uuid)`,
      [proposalId, NOW.toISOString()],
    ),
  );
  return { state: "done", verdict: "pass", concerns: [], checkedAt: NOW.toISOString() };
}
const runAudit = vi.fn(async (_s: Session, id: string) => storePass(id));

const answer = (text: string, toolCalls: AiToolCall[] = []): AiResult => ({
  callId: randomUUID(),
  status: "ok",
  text,
  toolCalls,
  usage: { input: 10, cached: 0, output: 10, reasoning: 0 },
  costNanocents: NANOCENTS_PER_CENT,
  upstreamId: null,
  replay: [],
  toolSearches: 0,
});

// The stand-in model, one cent a call.
const model = vi.fn(async (target: string, req: AiRequest): Promise<AiResult> => {
  const user = req.messages.find((m) => m.role === "user");
  const sent = JSON.parse(user?.content ?? "{}") as { roster?: { driverId: string }[]; driverId?: string };
  if (req.purpose === "fanout_plan" && target === "wonder") {
    const order = (sent.roster ?? []).map((r, n) => ({ driverId: r.driverId, priority: n === 0 ? 1 : 3, focus: [], brief: "Look at the loads." }));
    return answer(JSON.stringify({ summary: "The busiest drivers first.", order, skipped: [] }));
  }
  if (req.purpose === "fanout_check" && target === "spark") {
    const tool = req.messages.find((m) => m.role === "tool");
    if (!tool) return answer("", [{ id: `tc-${randomUUID()}`, name: "get_loads", argumentsJson: JSON.stringify({ driverId: sent.driverId }) }]);
    const rows = ((JSON.parse(tool.content) as { rows?: { id: string }[] }).rows ?? []).slice(0, 1);
    const issues = rows.map((r) => ({ category: "other_for_review", sources: [{ table: "loads", id: r.id }], note: "Worth a second look." }));
    return answer(JSON.stringify({ driverId: sent.driverId, checkedAll: true, confidence: "medium", issues }));
  }
  if (req.purpose === "fanout_reconcile" && target === "wonder") {
    return answer(JSON.stringify({ summary: "The two checks mostly agree.", disagreements: [] }));
  }
  throw new Error("unexpected model call");
});

const deps = (over: SweepDeps = {}): SweepDeps => ({
  db: app,
  clock,
  explain,
  runAudit,
  complete: model as unknown as SweepDeps["complete"],
  ...over,
});

async function runToEnd(runId: string, d: SweepDeps = deps(), max = 40) {
  for (let i = 0; i < max; i++) {
    const s = await advanceSweep(SESSION, runId, NOW.getTime() + SLICE, d);
    if (!s.ok) throw new Error(`advance refused: ${s.category}`);
    if (s.status !== "running") return s;
  }
  throw new Error("the run did not finish");
}

async function start() {
  const s = await startSweep(SESSION, { runId: randomUUID(), trigger: "button" }, deps());
  if (!s.ok) throw new Error(`start refused: ${s.category}`);
  return s.runId;
}

const read = <R>(sql: string, params: Param[] = []) => admin.withTenant(T, (q) => q.query<R>(sql, params));

async function runRow(runId: string) {
  const rows = await read<{ status: string; phase: string; cap_cents: number; spent_cents: number; reserved_cents: number; fanout: boolean; truncated_reason: string | null }>(
    "SELECT status, phase, cap_cents, spent_cents, reserved_cents, fanout, truncated_reason FROM sweep_runs WHERE id = CAST($1 AS uuid)",
    [runId],
  );
  return rows[0];
}

async function fanoutRow(runId: string) {
  const rows = await read<{ status: string; counts: string | null; plan_turn_id: string | null; reconcile_turn_id: string | null; finished_at: string | null }>(
    `SELECT status, CAST(counts AS text) AS counts, CAST(plan_turn_id AS text) AS plan_turn_id,
            CAST(reconcile_turn_id AS text) AS reconcile_turn_id, CAST(finished_at AS text) AS finished_at
       FROM sweep_fanout WHERE run_id = CAST($1 AS uuid)`,
    [runId],
  );
  return rows[0];
}

async function checks(runId: string) {
  return read<{ driver_id: string; status: string; attempts: number; cost_cents: number; turn_id: string | null; priority: number }>(
    `SELECT CAST(driver_id AS text) AS driver_id, status, attempts, cost_cents, CAST(turn_id AS text) AS turn_id, priority
       FROM sweep_fanout_checks WHERE run_id = CAST($1 AS uuid) ORDER BY priority, driver_id`,
    [runId],
  );
}

async function flagged(runId?: string) {
  return read<{ finding_key: string; kind: string; status: string; check_name: string; note: string; proposal_id: string | null; seen_run_id: string }>(
    `SELECT finding_key, kind, status, check_name, note, CAST(proposal_id AS text) AS proposal_id, CAST(seen_run_id AS text) AS seen_run_id
       FROM sweep_items WHERE finding_key LIKE 'fanout:%' ${runId ? "AND seen_run_id = CAST($1 AS uuid)" : ""} ORDER BY finding_key`,
    runId ? [runId] : [],
  );
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
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES
         (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@sweep-fanout-test.invalid', 'staff'),
         (current_tenant_id(), $1, $2, 'staff')`,
      [SESSION.sub, SESSION.email],
    ),
  );
  await admin.withTenant(OTHER, async (q) => {
    await q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), 'sweep-fanout-other', 'Other Carrier', 'America/Chicago')");
    await q.execute("INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')", [
      OTHER_SESSION.sub,
      OTHER_SESSION.email,
    ]);
  });
});

beforeEach(async () => {
  flags.sweepEnabled = true;
  flags.aiEnabled = true;
  flags.fanoutEnabled = true;
  await clearTenantAgent(admin, T);
  model.mockClear();
  explain.mockClear();
  runAudit.mockClear();
});

afterEach(() => {
  Object.assign(flags, saved, { sweepLimits: { ...saved.sweepLimits }, fanoutLimits: { ...saved.fanoutLimits } });
});

afterAll(async () => {
  Object.assign(flags, saved);
  if (admin) {
    await clearTenantAgent(admin, T).catch(() => undefined);
    await admin.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()")).catch(() => undefined);
    await admin.withTenant(OTHER, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()")).catch(() => undefined);
  }
  await app?.close();
  await admin?.close();
});

describe("the sweep's second opinion", () => {
  it("checks each active driver, lists what only a check saw for a person, and drafts exactly what it drafted before", async () => {
    const runId = await start();
    expect(await runRow(runId)).toMatchObject({ cap_cents: flags.fanoutLimits.runCapCents });
    const done = await runToEnd(runId);
    expect(done).toMatchObject({ status: "done", phase: "done", truncatedReason: null });

    const f = await fanoutRow(runId);
    expect(f.status).toBe("done");
    expect(f.finished_at).not.toBeNull();
    const rows = await checks(runId);
    const n = rows.length;
    expect(n).toBeGreaterThan(1);
    expect(rows.every((c) => c.status === "done" && c.attempts === 1 && c.cost_cents === 2 && c.turn_id !== null)).toBe(true);
    // The plan's first driver is checked first.
    expect(rows[0].priority).toBe(1);

    const counts = JSON.parse(f.counts ?? "{}") as Record<string, number>;
    const items = await flagged(runId);
    expect(counts).toMatchObject({ drivers_checked: n, drivers_unchecked: 0, spark_only: items.length });
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i).toMatchObject({ kind: "needs_person", status: "needs_person", check_name: "fanout", note: reasonSentence("sub_agent_flag"), proposal_id: null });
    }
    // No proposal from the second opinion: the five engine fixes only.
    const proposals = await read<{ n: string }>("SELECT COUNT(*) AS n FROM proposals WHERE kind = 'pay_correction'");
    expect(Number(proposals[0].n)).toBe(5);

    // One plan call, two calls a driver, one comparison; each held and settled against the cap.
    const purposes = model.mock.calls.map((c) => (c[1] as AiRequest).purpose);
    expect(purposes.filter((p) => p === "fanout_plan")).toHaveLength(1);
    expect(purposes.filter((p) => p === "fanout_check")).toHaveLength(2 * n);
    expect(purposes.filter((p) => p === "fanout_reconcile")).toHaveLength(1);
    expect(await runRow(runId)).toMatchObject({ spent_cents: 10 + 1 + 2 * n + 1, reserved_cents: 0, fanout: true });

    // Every turn the fan-out opened is closed.
    const open = await read<{ n: string }>("SELECT COUNT(*) AS n FROM turns WHERE status = 'running'");
    expect(Number(open[0].n)).toBe(0);

    // The page's tree and a node's steps, read by the run.
    const page = await readSweepPage(SESSION, runId, { db: app });
    expect(page?.fanout?.status).toBe("done");
    expect(page?.fanout?.checks).toHaveLength(n);
    expect(page?.fanout?.reconcile.summary).toBe("The two checks mostly agree.");
    const trace = await readSweepTurnTrace(SESSION, runId, rows[0].turn_id as string, { db: app });
    expect(trace?.steps.map((s) => s.kind)).toEqual(["model", "tool", "model"]);
    expect(await readSweepTurnTrace(SESSION, randomUUID(), rows[0].turn_id as string, { db: app })).toBeNull();
  });

  it("keeps one needs-a-person item per record across two runs of the week", async () => {
    const first = await start();
    await runToEnd(first);
    const once = await flagged();
    const second = await start();
    await runToEnd(second);
    const twice = await flagged();
    expect(twice.map((i) => i.finding_key)).toEqual(once.map((i) => i.finding_key));
    expect(twice.every((i) => i.seen_run_id === second)).toBe(true);
  });

  it("skips the second opinion past the carrier's daily limit, and the run still finishes", async () => {
    flags.fanoutLimits = { ...flags.fanoutLimits, runsPerTenantDay: 1 };
    await runToEnd(await start());
    model.mockClear();
    const runId = await start();
    const done = await runToEnd(runId);
    expect(done).toMatchObject({ status: "done", phase: "done" });
    expect((await fanoutRow(runId)).status).toBe("skipped_daily_cap");
    expect(await checks(runId)).toEqual([]);
    expect(model).not.toHaveBeenCalled();
    expect(explain).toHaveBeenCalled();
    const page = await readSweepPage(SESSION, runId, { db: app });
    expect(page?.fanout?.status).toBe("skipped_daily_cap");
  });

  it("runs a plain sweep when the switch is off", async () => {
    flags.fanoutEnabled = false;
    const runId = await start();
    expect((await runRow(runId)).cap_cents).toBe(flags.sweepLimits.maxRunCents);
    await runToEnd(runId);
    expect(await fanoutRow(runId)).toBeUndefined();
    expect(model).not.toHaveBeenCalled();
    expect((await readSweepPage(SESSION, runId, { db: app }))?.fanout).toBeNull();
  });

  it("leases a check a dead slice left once more, and never a third time", async () => {
    const runId = await start();
    // Up to the checks: too little of the slice is left to start one, so the slice ends there.
    const s = await advanceSweep(SESSION, runId, NOW.getTime() + 12_000, deps());
    expect(s).toMatchObject({ ok: true, phase: "check" });
    const rows = await checks(runId);
    expect(rows.every((c) => c.status === "queued")).toBe(true);
    // A dead slice: one check on its first lease, one on its second, both lapsed.
    const lapsed = new Date(NOW.getTime() - 1_000).toISOString();
    await admin.withTenant(T, async (q) => {
      await q.execute(
        `UPDATE sweep_fanout_checks SET status = 'running', attempts = 1, lease_token = CAST($3 AS uuid), lease_until = CAST($4 AS timestamptz)
          WHERE run_id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)`,
        [runId, rows[0].driver_id, randomUUID(), lapsed],
      );
      await q.execute(
        `UPDATE sweep_fanout_checks SET status = 'running', attempts = 2, lease_token = CAST($3 AS uuid), lease_until = CAST($4 AS timestamptz)
          WHERE run_id = CAST($1 AS uuid) AND driver_id = CAST($2 AS uuid)`,
        [runId, rows[1].driver_id, randomUUID(), lapsed],
      );
    });
    await runToEnd(runId);
    const after = await checks(runId);
    expect(after.find((c) => c.driver_id === rows[0].driver_id)).toMatchObject({ status: "done", attempts: 2 });
    expect(after.find((c) => c.driver_id === rows[1].driver_id)).toMatchObject({ status: "error", attempts: 2 });
    expect(after.filter((c) => c.driver_id !== rows[0].driver_id && c.driver_id !== rows[1].driver_id).every((c) => c.attempts === 1)).toBe(true);
    expect(JSON.parse((await fanoutRow(runId)).counts ?? "{}")).toMatchObject({ drivers_unchecked: 1 });
    expect((await runRow(runId)).reserved_cents).toBe(0);
  });

  it("holds cents against the cap so two slices at once cannot pass it", async () => {
    const runId = await start();
    const token = randomUUID();
    await admin.withTenant(T, (q) =>
      q.execute("UPDATE sweep_runs SET lease_token = CAST($2 AS uuid), spent_cents = cap_cents - 10 WHERE id = CAST($1 AS uuid)", [
        runId,
        token,
      ]),
    );
    const held = await Promise.all([0, 1].map(() => app.withTenant(T, (q) => reserveRunCents(q, runId, token, 9))));
    expect(held.filter(Boolean)).toHaveLength(1);
    expect((await runRow(runId)).reserved_cents).toBe(9);
    // Another worker's token holds nothing.
    expect(await app.withTenant(T, (q) => reserveRunCents(q, runId, randomUUID(), 1))).toBe(false);
    // A cost never read back counts the whole hold; a known one counts itself.
    await app.withTenant(T, (q) => settleRunCents(q, runId, token, 9, null));
    expect(await runRow(runId)).toMatchObject({ reserved_cents: 0, spent_cents: (await runRow(runId)).cap_cents - 1 });
  });

  it("shows another carrier nothing of this one's second opinion", async () => {
    const runId = await start();
    await runToEnd(runId);
    const turn = (await checks(runId))[0].turn_id as string;
    expect(await readSweepTurnTrace(OTHER_SESSION, runId, turn, { db: app })).toBeNull();
    expect(await readSweepPage(OTHER_SESSION, runId, { db: app })).toBeNull();
    const seen = await app.withTenant(OTHER, async (q) => ({
      checks: await q.query<{ n: string }>("SELECT COUNT(*) AS n FROM sweep_fanout_checks"),
      fanout: await q.query<{ n: string }>("SELECT COUNT(*) AS n FROM sweep_fanout"),
    }));
    expect(Number(seen.checks[0].n)).toBe(0);
    expect(Number(seen.fanout[0].n)).toBe(0);
    const mine = await app.withTenant(T, (q) => q.query<{ n: string }>("SELECT COUNT(*) AS n FROM sweep_fanout_checks"));
    expect(Number(mine[0].n)).toBeGreaterThan(0);
  });
});
