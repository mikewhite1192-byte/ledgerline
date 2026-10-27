import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { AuditResult } from "../agent/auditor/run";
import { callTool as gatewayCallTool } from "../agent/gateway";
import type { GatewayContext, GatewayOutcome, ToolCall } from "../agent/gateway/types";
import type { Explained } from "../agent/sweep/explain";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { Session } from "../auth/claims";
import { checkInputOf } from "../data/records";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { runAllChecks } from "../rules-engine";
import type { Cents } from "../rules-engine/types";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../seed/run";
import { fixPlanFor, type FixLeg } from "./plan";
import { advanceSweep, MAX_DRAFT_ATTEMPTS, startSweep, type SweepDeps } from "./run";
import { readSweepPage } from "./view";

// The sweep against the real database, as the app's role, with the real gateway, turn store and
// pay correction checks. Only the two model calls are stand-ins: the explanation and the auditor
// (which stores a pass, as a real pass would). One tenant, seeded with the demo plan under its
// own slug, removed after; every test starts with no runs, items or proposals.

const ANCHOR = "2026-11-02";
const NOW = new Date("2026-11-02T16:00:00.000Z");
const clock = () => NOW;
const SLICE = 20_000;
const CARRIER = { ...DEMO_CARRIERS[0], slug: "sweep-run-test", name: "Sweep Run Test" } as unknown as DemoCarrier;
const plan = buildCarrierPlan(CARRIER, ANCHOR);
const T = randomUUID();
const SESSION: Session = { sub: `sub-${T}`, email: "ops@sweep-run-test.example", tenantId: T };
const saved = { ...flags, sweepLimits: { ...flags.sweepLimits } };

// The fix legs the engine plans for the open week, keyed driver id : signed cents.
const input = checkInputOf(plan.rows);
const fixLegs: FixLeg[] = runAllChecks(input)
  .flatMap((f) => fixPlanFor(f, input, plan.periods[3]))
  .filter((l): l is FixLeg => l.kind === "fix");
const legKeys = fixLegs.map((l) => `${l.driverId}:${l.expectedCents}`).sort();
// Each fix leg's finding category (the engine's word for what it found, such as
// newer_is_duplicate), which is not the correction's reason category (duplicate_charge).
const fixFindings = runAllChecks(input).flatMap((f) =>
  fixPlanFor(f, input, plan.periods[3])
    .filter((l): l is FixLeg => l.kind === "fix")
    .map((l) => ({ category: f.category as string, reason: l.reasonCategories[0] as string })),
);

let admin: Db;
let app: Db;

const explainOk = async (): Promise<Explained> => ({
  ok: true,
  text: "The engine found this and the fix corrects it.",
  callId: randomUUID(),
  costNanocents: 2 * NANOCENTS_PER_CENT,
});
const explain = vi.fn(explainOk);

async function storePass(proposalId: string): Promise<AuditResult> {
  await admin.withTenant(T, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true,
              auditor_checked_at = CAST($2 AS timestamptz)
        WHERE id = CAST($1 AS uuid)`,
      [proposalId, NOW.toISOString()],
    ),
  );
  return { state: "done", verdict: "pass", concerns: [], checkedAt: NOW.toISOString() };
}
const runAudit = vi.fn(async (_s: Session, id: string) => storePass(id));

const deps = (over: SweepDeps = {}): SweepDeps => ({ db: app, clock, explain, runAudit, ...over });

async function runToEnd(runId: string, d: SweepDeps = deps(), max = 30) {
  for (let i = 0; i < max; i++) {
    const s = await advanceSweep(SESSION, runId, NOW.getTime() + SLICE, d);
    if (!s.ok) throw new Error(`advance refused: ${s.category}`);
    if (s.status !== "running") return s;
  }
  throw new Error("the run did not finish");
}

async function items(runId: string) {
  return admin.withTenant(T, (q) =>
    q.query<{ kind: string; status: string; proposal_id: string | null; check_name: string; audit_attempts: number }>(
      `SELECT kind, status, CAST(proposal_id AS text) AS proposal_id, check_name, audit_attempts
         FROM sweep_items WHERE seen_run_id = CAST($1 AS uuid) ORDER BY finding_key`,
      [runId],
    ),
  );
}

async function fixRows(runId: string) {
  return admin.withTenant(T, (q) =>
    q.query<{ status: string; refusal_category: string | null; draft_attempts: number }>(
      `SELECT status, refusal_category, draft_attempts FROM sweep_items
        WHERE seen_run_id = CAST($1 AS uuid) AND kind = 'fix' ORDER BY finding_key`,
      [runId],
    ),
  );
}

// The item's turn never opens (another turn holds the conversation): a passing refusal.
const turnBusy: SweepDeps["openTurn"] = async () => ({ refused: "busy" });

async function proposals() {
  return admin.withTenant(T, (q) =>
    q.query<{ id: string; subject_id: string; amount_cents: string; direction: string; exceptions: string; status: string }>(
      `SELECT CAST(id AS text) AS id, CAST(subject_id AS text) AS subject_id, CAST(amount_cents AS text) AS amount_cents,
              direction, CAST(exceptions AS text) AS exceptions, status
         FROM proposals WHERE kind = 'pay_correction' ORDER BY id`,
    ),
  );
}

async function run(runId: string) {
  const rows = await admin.withTenant(T, (q) =>
    q.query<{ status: string; phase: string; spent_cents: number; truncated_reason: string | null; trigger: string; started_by: string }>(
      "SELECT status, phase, spent_cents, truncated_reason, trigger, started_by FROM sweep_runs WHERE id = CAST($1 AS uuid)",
      [runId],
    ),
  );
  return rows[0];
}

async function start(runId = randomUUID()) {
  const s = await startSweep(SESSION, { runId, trigger: "button" }, deps());
  if (!s.ok) throw new Error(`start refused: ${s.category}`);
  return s.runId;
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
         (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@sweep-run-test.invalid', 'staff'),
         (current_tenant_id(), $1, $2, 'staff')`,
      [SESSION.sub, SESSION.email],
    ),
  );
});

beforeEach(async () => {
  flags.sweepEnabled = true;
  await clearTenantAgent(admin, T);
  explain.mockClear();
  explain.mockImplementation(explainOk);
  runAudit.mockClear();
  runAudit.mockImplementation(async (_s: Session, id: string) => storePass(id));
});

afterEach(() => {
  Object.assign(flags, saved, { sweepLimits: { ...saved.sweepLimits } });
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

describe("a sweep of the open week", () => {
  it("drafts one engine-numbered fix per fixable leg, lists the rest for a person, and audits each", async () => {
    expect(fixLegs.length).toBe(5);
    const runId = await start();
    const done = await runToEnd(runId);
    expect(done).toMatchObject({ status: "done", phase: "done", truncatedReason: null });

    const all = await items(runId);
    expect(all.filter((i) => i.kind === "fix").map((i) => i.status)).toEqual(Array(5).fill("drafted"));
    expect(all.filter((i) => i.kind === "needs_person").map((i) => i.check_name).sort()).toEqual([
      "delivered_without_rate",
      "over_advance_limit",
      "payment_on_wrong_invoice",
    ]);
    // Every proposal carries the engine's number to the cent, with its sign as the direction.
    const ps = await proposals();
    expect(ps.map((p) => `${p.subject_id}:${(p.direction === "in" ? -1 : 1) * Number(p.amount_cents)}`).sort()).toEqual(legKeys);
    expect(ps.every((p) => p.status === "proposed" && p.exceptions === "[]")).toBe(true);
    // One explanation per fix and one auditor run per audit slice, counted against the cap.
    expect(explain).toHaveBeenCalledTimes(5);
    // Each explanation names the finding's own category, and the correction's reason beside it.
    const asked = explain.mock.calls.map((c) => {
      const sent = (c as unknown as [Session, { category: string; reasonCategory: string }])[1];
      return { category: sent.category, reason: sent.reasonCategory };
    });
    expect(asked.map((a) => `${a.category}:${a.reason}`).sort()).toEqual(
      fixFindings.map((f) => `${f.category}:${f.reason}`).sort(),
    );
    expect(asked.some((a) => a.category !== a.reason)).toBe(true);
    expect(runAudit).toHaveBeenCalledTimes(5);
    expect((await run(runId)).spent_cents).toBe(10);
    expect(await run(runId)).toMatchObject({ trigger: "button", started_by: SESSION.sub });

    const page = await readSweepPage(SESSION, runId, { db: app });
    expect(page?.clean.proposalIds).toEqual(ps.map((p) => p.id).sort());
    expect(page?.clean.totalCents).toBe(ps.reduce((n, p) => n + Number(p.amount_cents), 0));
    expect(page?.counts).toMatchObject({ fixes_drafted: 5, needs_person: 3, clean: 5 });
  });

  it("replays a start to the same run, and a second run adds no proposal and no model call", async () => {
    const runId = await start();
    expect(await startSweep(SESSION, { runId, trigger: "button" }, deps())).toEqual({ ok: true, runId, existing: true });
    // A second press with a new id while the first is running opens the running one.
    expect(await startSweep(SESSION, { runId: randomUUID(), trigger: "button" }, deps())).toMatchObject({ runId, existing: true });
    await runToEnd(runId);
    const first = await proposals();
    explain.mockClear();
    runAudit.mockClear();

    const again = await start();
    expect(again).not.toBe(runId);
    await runToEnd(again);
    expect(await proposals()).toEqual(first);
    expect(explain).not.toHaveBeenCalled();
    expect(runAudit).not.toHaveBeenCalled();
    expect((await items(again)).filter((i) => i.kind === "fix").map((i) => i.status)).toEqual(Array(5).fill("drafted"));
  });

  it("stops at the run's cap and marks the item it could not explain over_cap", async () => {
    // Two explanations fit (5 cents each, held whole when no cost comes back); the third does not.
    flags.sweepLimits = { ...flags.sweepLimits, maxRunCents: 12 };
    explain.mockImplementation(async () => ({ ok: false, category: "timeout", callId: null, costNanocents: null }));
    const runId = await start();
    const done = await runToEnd(runId);
    expect(done).toMatchObject({ status: "done", truncatedReason: "cap" });
    const fixes = (await items(runId)).filter((i) => i.kind === "fix");
    expect(fixes.filter((i) => i.status === "drafted")).toHaveLength(2);
    expect(fixes.filter((i) => i.status === "over_cap")).toHaveLength(1);
    expect(fixes.filter((i) => i.status === "found")).toHaveLength(2);
    expect((await run(runId)).spent_cents).toBe(10);
    expect(runAudit).not.toHaveBeenCalled();
  });

  it("marks a saved proposal whose numbers are not the engine's, so it is never clean", async () => {
    const tamper = async (ctx: GatewayContext, call: ToolCall): Promise<GatewayOutcome> => {
      const out = await gatewayCallTool(ctx, call, { db: app });
      if (out.decision !== "allowed" || !out.draft) return out;
      return { ...out, draft: { ...out.draft, amountCents: (out.draft.amountCents + 1) as Cents } };
    };
    const runId = await start();
    await runToEnd(runId, deps({ callTool: tamper }));
    const fixes = (await items(runId)).filter((i) => i.kind === "fix");
    expect(fixes.map((i) => i.status)).toEqual(Array(5).fill("mismatch"));
    const ps = await proposals();
    expect(ps.every((p) => p.exceptions.includes("sweep_mismatch"))).toBe(true);
    expect(explain).not.toHaveBeenCalled();
    expect((await readSweepPage(SESSION, runId, { db: app }))?.clean.proposalIds).toEqual([]);
  });

  it("links the same waiting proposal again when an item is found anew, and never drafts a second", async () => {
    await runToEnd(await start());
    const first = await proposals();
    // The runs and items go; the proposals stay waiting.
    const forget = () =>
      admin.withTenant(T, async (q) => {
        await q.execute("DELETE FROM sweep_items WHERE tenant_id = current_tenant_id()");
        await q.execute("DELETE FROM sweep_runs WHERE tenant_id = current_tenant_id()");
      });
    await forget();
    const runId = await start();
    await runToEnd(runId);
    const fixes = (await items(runId)).filter((i) => i.kind === "fix");
    expect(fixes.map((i) => i.status)).toEqual(Array(5).fill("drafted"));
    expect(fixes.map((i) => i.proposal_id).sort()).toEqual(first.map((p) => p.id).sort());
    expect(await proposals()).toEqual(first);

    // A different proposal still waiting for the same driver: the sweep links it and drafts none.
    await forget();
    await admin.withTenant(T, (q) =>
      q.execute(
        `UPDATE proposals SET dedupe_key = 'pay_correction:' || CAST(subject_id AS text) || ':'
                                           || md5(CAST(id AS text)) || md5('other') WHERE kind = 'pay_correction'`,
      ),
    );
    const third = await start();
    await runToEnd(third);
    const blocked = (await items(third)).filter((i) => i.kind === "fix");
    expect(blocked.map((i) => i.status)).toEqual(Array(5).fill("blocked_live"));
    expect(blocked.map((i) => i.proposal_id).sort()).toEqual(first.map((p) => p.id).sort());
    expect((await proposals()).map((p) => p.id)).toEqual(first.map((p) => p.id));
  });

  it("carries a run cut off by its deadline on in the next slice", async () => {
    const runId = await start();
    // Too little time for any draft: the find phase runs, then the slice hands the run back.
    const first = await advanceSweep(SESSION, runId, NOW.getTime() + 5_000, deps());
    expect(first).toMatchObject({ ok: true, status: "running", phase: "draft" });
    expect((await items(runId)).filter((i) => i.kind === "fix").map((i) => i.status)).toEqual(Array(5).fill("found"));
    expect(explain).not.toHaveBeenCalled();
    await expect(runToEnd(runId)).resolves.toMatchObject({ status: "done" });
    expect((await proposals()).length).toBe(5);
  });

  it("answers busy while another slice holds the lease, and takes an expired lease", async () => {
    const runId = await start();
    const hold = (at: string) =>
      admin.withTenant(T, (q) =>
        q.execute(
          "UPDATE sweep_runs SET lease_token = CAST($2 AS uuid), lease_until = CAST($3 AS timestamptz) WHERE id = CAST($1 AS uuid)",
          [runId, randomUUID(), at],
        ),
      );
    await hold(new Date(NOW.getTime() + 10_000).toISOString());
    await expect(advanceSweep(SESSION, runId, NOW.getTime() + SLICE, deps())).resolves.toEqual({ ok: false, category: "busy" });
    expect((await items(runId)).length).toBe(0);
    await hold(new Date(NOW.getTime() - 1_000).toISOString());
    await expect(advanceSweep(SESSION, runId, NOW.getTime() + SLICE, deps())).resolves.toMatchObject({ ok: true });
    expect((await items(runId)).length).toBeGreaterThan(0);
  });

  it("retries an audit still in progress up to the limit, then finishes", async () => {
    // Room for every attempt: 10 cents of explanations and 15 audits held at 10 cents each.
    flags.sweepLimits = { ...flags.sweepLimits, maxRunCents: 200 };
    runAudit.mockImplementation(async () => ({ state: "in_progress" }));
    const runId = await start();
    const done = await runToEnd(runId, deps(), 40);
    expect(done).toMatchObject({ status: "done" });
    const fixes = (await items(runId)).filter((i) => i.kind === "fix");
    expect(fixes.every((i) => i.status === "audit_pending" && i.audit_attempts === 3)).toBe(true);
    expect(runAudit).toHaveBeenCalledTimes(15);
    // Unknown is not zero: every reservation stays counted.
    expect((await run(runId)).spent_cents).toBe(10 + 15 * 10);
  });

  it("ends the audit phase when the auditor is switched off", async () => {
    runAudit.mockImplementation(async () => ({ state: "disabled" }));
    const runId = await start();
    await expect(runToEnd(runId)).resolves.toMatchObject({ status: "done" });
    expect(runAudit).toHaveBeenCalledTimes(1);
    const fixes = (await items(runId)).filter((i) => i.kind === "fix");
    expect(fixes.map((i) => i.status)).toEqual(Array(5).fill("drafted"));
    expect((await run(runId)).spent_cents).toBe(10);
  });

  it("tries an item refused for a passing reason again in a later run, and drafts it", async () => {
    const first = await start();
    await runToEnd(first, deps({ openTurn: turnBusy }));
    expect(await fixRows(first)).toEqual(
      Array(5).fill({ status: "refused", refusal_category: "turn_unavailable", draft_attempts: 1 }),
    );
    expect(await proposals()).toEqual([]);

    const second = await start();
    await runToEnd(second);
    expect((await fixRows(second)).map((r) => [r.status, r.refusal_category])).toEqual(Array(5).fill(["drafted", null]));
    expect((await proposals()).length).toBe(5);
  });

  it("never tries a lasting refusal again, and stops a passing one at the attempt limit", async () => {
    // The gateway refuses every fix as over the limit: that refusal stands in every later run.
    const overLimit: SweepDeps["callTool"] = async (_ctx, call) => ({
      decision: "blocked",
      decisionId: randomUUID(),
      tool: call.name,
      reason: "amount_over_limit",
      result: { blocked: true, reason: "amount_over_limit" },
      latencyMs: 1,
    });
    const first = await start();
    await runToEnd(first, deps({ callTool: overLimit }));
    expect((await fixRows(first)).map((r) => r.refusal_category)).toEqual(Array(5).fill("amount_over_limit"));
    const again = await start();
    await runToEnd(again);
    expect(await fixRows(again)).toEqual(
      Array(5).fill({ status: "refused", refusal_category: "amount_over_limit", draft_attempts: 1 }),
    );
    expect(await proposals()).toEqual([]);

    // A passing refusal, run after run, until the items have had every try.
    await clearTenantAgent(admin, T);
    for (let i = 1; i <= MAX_DRAFT_ATTEMPTS; i++) {
      const runId = await start();
      await runToEnd(runId, deps({ openTurn: turnBusy }));
      expect((await fixRows(runId)).map((r) => r.draft_attempts)).toEqual(Array(5).fill(i));
    }
    const last = await start();
    await runToEnd(last);
    expect(await fixRows(last)).toEqual(
      Array(5).fill({ status: "refused", refusal_category: "turn_unavailable", draft_attempts: MAX_DRAFT_ATTEMPTS }),
    );
    expect(await proposals()).toEqual([]);
    expect(explain).not.toHaveBeenCalled();
  });

  it("refuses everything while the switch is off", async () => {
    const runId = await start();
    flags.sweepEnabled = false;
    await expect(startSweep(SESSION, { runId: randomUUID(), trigger: "button" }, deps())).resolves.toEqual({
      ok: false,
      category: "disabled",
    });
    await expect(advanceSweep(SESSION, runId, NOW.getTime() + SLICE, deps())).resolves.toEqual({ ok: false, category: "disabled" });
  });
});
