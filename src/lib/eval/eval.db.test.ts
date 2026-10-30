import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { CompleteFn } from "../agent/gateway/types";
import { AiError, type AiRequest, type AiResult } from "../ai";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { Session } from "../auth/claims";
import { checkInputOf } from "../data/records";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { runAllChecks } from "../rules-engine";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../seed/run";
import { fixPlanFor, type FixLeg } from "../sweep/plan";
import { casesFor } from "./cases";
import { evalClock, runArm, runCase, type CaseDeps } from "./run";
import type { EvalCase } from "./types";

// One case through the real operator turn, gateway, turn store and proposal tables, as the app's
// role. Only the model calls are stand-ins: a recorded answer that proposes the engine's fix and
// writes its call to the ledger as the wrapper would, so the scorer reads the proposal and the
// model calls back from the tables. One tenant, seeded with the demo plan under its own slug,
// removed after. The clock is the eval's, fixed to the anchor day: no wall clock.

const ANCHOR = "2026-11-02";
const CARRIER = { ...DEMO_CARRIERS[0], slug: "eval-db-test", name: "Eval Db Test" } as unknown as DemoCarrier;
const plan = buildCarrierPlan(CARRIER, ANCHOR);
const T = randomUUID();
const SESSION: Session = { sub: `sub-${T}`, email: "ops@eval-db-test.example", tenantId: T };
const saved = { ...flags };
const clock = evalClock(ANCHOR, () => 0);
const CALL_COST = 3 * NANOCENTS_PER_CENT;
const AUDIT_COST = 2 * NANOCENTS_PER_CENT;

const theCase = casesFor(plan).find((c) => c.key === "eval-db-test:missing_reimbursement") as EvalCase;
const noRateCase = casesFor(plan).find((c) => c.key === "eval-db-test:delivered_without_rate") as EvalCase;
const openPeriod = plan.rows.settlement_periods.find((p) => p.status === "open");
const input = checkInputOf(plan.rows);
// The engine's fix for the planted lumper, in the open week, as the sweep would draft it.
const leg = runAllChecks(input)
  .flatMap((f) => fixPlanFor(f, input, plan.periods[plan.periods.length - 1]))
  .find((l): l is FixLeg => l.kind === "fix" && l.sourceRefs.some((r) => r.id === theCase?.expected.sourceId));

let admin: Db;
let app: Db;
const dirs: string[] = [];

// A call the ledger holds, as the wrapper writes it, under the call's trace.
async function ledgerCall(traceId: string | undefined, costNanocents: number, durationMs: number): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(T, (q) =>
    q.execute(
      `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, trace_id, status,
         reserved_nanocents, cost_nanocents, duration_ms, created_at, settled_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'spark', 'meta', 'test-model', 'text', 'eval_db_test',
         CAST($2 AS uuid), 'ok', $3, $3, $4, CAST($5 AS timestamptz), CAST($5 AS timestamptz))`,
      [id, traceId ?? null, costNanocents, durationMs, new Date(clock()).toISOString()],
    ),
  );
  return id;
}

const result = (callId: string, partial: Partial<AiResult>): AiResult => ({
  callId,
  status: "ok",
  text: "",
  toolCalls: [],
  usage: { input: 900, cached: 0, output: 40, reasoning: 0 },
  costNanocents: CALL_COST,
  upstreamId: null,
  replay: [],
  toolSearches: 0,
  ...partial,
});

// The recorded answer: the checks first (a cited record counts only once a tool returned it), then
// the engine's correction, then a short closing line once both tool results are in.
function recorded(seen: string[]): CompleteFn {
  return async (target, request: AiRequest) => {
    seen.push(target);
    const callId = await ledgerCall(request.traceId, CALL_COST, 1_500);
    const results = request.messages.filter((m) => m.role === "tool").length;
    if (results === 0) {
      return result(callId, { toolCalls: [{ id: "call_checks", name: "run_checks", argumentsJson: JSON.stringify({ driverId: leg?.driverId }) }] });
    }
    if (results >= 2) {
      return result(callId, { text: "The lumper was paid by the driver and not reimbursed; a correction is proposed for approval." });
    }
    const args = {
      driverId: leg?.driverId,
      periodId: openPeriod?.id,
      deltaCents: leg?.expectedCents,
      operatorVerdict: leg?.verdict,
      reasonCategories: leg?.reasonCategories,
      sourceRefs: leg?.sourceRefs.slice(0, 8),
    };
    return result(callId, { toolCalls: [{ id: "call_fix", name: "propose_pay_correction", argumentsJson: JSON.stringify(args) }] });
  };
}

// The second check's stand-in stores a pass under its own trace, with its call in the ledger.
async function auditPass(_s: Session, proposalId: string): Promise<void> {
  const trace = randomUUID();
  await ledgerCall(trace, AUDIT_COST, 900);
  await admin.withTenant(T, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_trace_id = CAST($2 AS uuid),
              auditor_checked_at = CAST($3 AS timestamptz)
        WHERE id = CAST($1 AS uuid)`,
      [proposalId, trace, new Date(clock()).toISOString()],
    ),
  );
}

const deps = (complete: CompleteFn, audit = vi.fn(auditPass)): CaseDeps => ({ arm: "spark", session: SESSION, db: app, complete, clock, audit });

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
    q.execute("INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')", [
      SESSION.sub,
      SESSION.email,
    ]),
  );
});

afterEach(async () => {
  Object.assign(flags, saved);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await clearTenantAgent(admin, T);
  await admin.withTenant(T, (q) => q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id()"));
});

afterAll(async () => {
  Object.assign(flags, saved);
  if (admin) {
    await clearTenantAgent(admin, T).catch(() => undefined);
    await admin.withTenant(T, (q) => q.execute("DELETE FROM model_calls WHERE tenant_id = current_tenant_id()")).catch(() => undefined);
    await admin.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
  }
  await app?.close();
  await admin?.close();
});

function turnOn() {
  flags.aiEnabled = true;
  flags.agentEnabled = true;
  flags.auditorEnabled = true;
}

describe("an eval case on the real tables", () => {
  it("scores the proposal and the model calls it reads back from the tables", async () => {
    expect(theCase).toBeDefined();
    expect(openPeriod).toBeDefined();
    expect(leg?.expectedCents).toBe(theCase.expected.cents);
    turnOn();
    const seen: string[] = [];
    const audit = vi.fn(auditPass);
    const s = await runCase(theCase, deps(recorded(seen), audit));
    expect(seen).toEqual(["spark", "spark", "spark"]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({
      status: "scored",
      causeRight: true,
      amountRight: true,
      fixRight: true,
      pass: true,
      operatorRight: true,
      proposalKinds: ["pay_correction"],
      auditorVerdict: "pass",
      auditorAgrees: true,
      endedReason: null,
      costNanocents: 3 * CALL_COST,
      auditorNanocents: AUDIT_COST,
      latencyMs: 4_500,
    });
    // The proposal stays proposed: nothing here approves or pays.
    const rows = await admin.withTenant(T, (q) => q.query<{ status: string; amount_cents: string }>("SELECT status, CAST(amount_cents AS text) AS amount_cents FROM proposals"));
    expect(rows).toEqual([{ status: "proposed", amount_cents: String(theCase.expected.cents) }]);
  });

  it("an answer-only case counts its cause only from a tool's result, never from the question", async () => {
    expect(noRateCase.expected.fixKind).toBeNull();
    turnOn();
    const answer = "It has no rate on file, so it cannot be invoiced yet.";
    // The same words with no tool call: the question echoed and the cause guessed.
    const echo: CompleteFn = async (_target, request: AiRequest) =>
      result(await ledgerCall(request.traceId, CALL_COST, 1_000), { text: `${noRateCase.prompt} ${answer}` });
    const echoed = await runCase(noRateCase, deps(echo));
    expect(echoed).toMatchObject({ status: "scored", fixRight: true, causeRight: false, pass: false, proposalKinds: [] });

    // The checks read first: the engine's own word for the cause comes back in their result.
    const read: CompleteFn = async (_target, request: AiRequest) => {
      const callId = await ledgerCall(request.traceId, CALL_COST, 1_000);
      if (!request.messages.some((m) => m.role === "tool")) {
        return result(callId, { toolCalls: [{ id: "call_checks", name: "run_checks", argumentsJson: "{}" }] });
      }
      return result(callId, { text: answer });
    };
    const backed = await runCase(noRateCase, deps(read));
    expect(backed).toMatchObject({ status: "scored", fixRight: true, causeRight: true, pass: true, proposalKinds: [] });
  });

  it("a model call that times out scores unknown, never a pass, and a rerun is not served from the cache", async () => {
    turnOn();
    const timeout: CompleteFn = async () => {
      throw new AiError("timeout");
    };
    const audit = vi.fn(auditPass);
    const s = await runCase(theCase, deps(timeout, audit));
    expect(s).toMatchObject({ status: "unknown", pass: null, operatorRight: null, proposalKinds: [] });
    expect(audit).not.toHaveBeenCalled();
    const turns = await admin.withTenant(T, (q) => q.query<{ status: string }>("SELECT status FROM turns"));
    expect(turns.map((t) => t.status)).toEqual(["failed"]);

    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eval-db-test-"));
    dirs.push(cacheDir);
    const arm = {
      arm: "spark" as const,
      cases: [theCase],
      sessions: { [CARRIER.slug]: SESSION },
      deps: { db: app, complete: timeout, clock, audit },
      anchor: ANCHOR,
      modelId: "spark-test-model",
      auditorModelId: "wonder-test-model",
      screenModelId: "spark-open-test-model",
      cacheDir,
      fresh: false,
    };
    for (let i = 0; i < 2; i++) {
      const out = await runArm(arm);
      expect(out.results.map((r) => [r.score.status, r.cached])).toEqual([["unknown", false]]);
      expect(out.stoppedAtCap).toBe(false);
    }
  });
});
