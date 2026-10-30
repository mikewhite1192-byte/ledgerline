import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { callTool } from "../agent/gateway";
import { screenUntrustedInput } from "../agent/gateway/screen";
import type { CompleteFn, GatewayContext } from "../agent/gateway/types";
import type { AuditResult } from "../agent/auditor/run";
import { AiError, type AiRequest, type AiResult } from "../ai";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param } from "../db/types";
import { dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { untrustedContentHash } from "../data/content-hash";
import { EXECUTORS, executeProposal, type ProposalRow } from "../proposals/execute";
import { payPolicySetupExecutor } from "../proposals/executors/pay-policy-setup";
import { PROPOSE_PURPOSE, READ_PURPOSE } from "./format";
import {
  advancePolicyRun,
  readPolicyRun,
  startPolicyRun,
  type AdvanceOutcome,
  type RunComplete,
  type RunDeps,
  type RunView,
} from "./run";
import { SAMPLE_POLICY_PDFS } from "./samples.generated";
import { readAnswerFor, rulesAnswerFor, type SampleName } from "./test-fixtures";

// A pay policy run against the real database, as the app's role, from the stored file to the
// approved version. The model's two answers are hand-written from the samples' answer keys and the
// screen is the real one over a fake model, so no model is called. One stage runs per request; a
// second request while a stage runs is busy and runs nothing; the card waits with every rule's
// state and the auditor's evidence shows the engine's plan; nothing changes until a person
// approves, and the approval refuses a rule still needing a choice, a bad edit, a member whose
// role does not cover the change, a start that no longer holds and the switch off, each without
// writing anything. One approval writes one version and one pay_rule_changes row per changed rule,
// once. A run ends at the spending cap, on a file it cannot read, on text the screen flags and for
// a carrier with no pay rules, each with nothing proposed; the daily limit refuses a start; another
// carrier sees and approves nothing. A week already paid on the start, a Found quote that no
// longer names its rule, or a transcript changed after the card was made, refuses the approval and
// writes nothing, and the executor fails a row that reached it anyway. A run's turn costs what its
// model calls cost. Only this file's five tenants are made, and they are removed after.

const saved = { ...flags, policyLimits: { ...flags.policyLimits }, approverRole: { ...flags.approverRole } };
// Tuesday Oct 27, 2026, 10:00 in Chicago: the week of Oct 26 has begun, so the next week start is
// Monday Nov 2, the date the Harrow Flats policy takes effect.
const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const clock = () => new Date(NOW);
const NEXT_WEEK = "2026-11-02";
const HARROW: SampleName = "harrow-flats-pay-policy";
const CEDAR: SampleName = "cedar-bend-pay-policy";
const CLEAN = "VERDICT: clean\nCATEGORIES: none\nCONFIDENCE: 0.99";
const FLAGGED = "VERDICT: flagged\nCATEGORIES: instruction_to_agent\nCONFIDENCE: 0.9";

let admin: Db;
let app: Db;
// A: the run from start to an approved version. B: a start that stops holding, the switch, an
// admin. C: the read's ends. D: no pay rules, the screen's flag and the daily limit. E: a paid
// week and a changed transcript.
let A: Fixture;
let B: Fixture;
let C: Fixture;
let D: Fixture;
let E: Fixture;
const V1: Record<string, string> = {};
const seenA = { turnId: "", proposalId: "" };

async function addPayRules(f: Fixture, effectiveFrom = "2026-10-05"): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
         empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to, insurance_per_day_cents,
         escrow_target_cents, escrow_per_settlement_cents, net_pay_floor_cents, advance_recovery_cap_cents,
         advance_fee_cents, advance_limit_default_cents, advance_max_bps_of_earned, advance_min_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), 'seed', 1, 'linehaul',
         0, 10000, 'all', 1100, 0, 0, 0, NULL, 500, 150000, 5000, 5000)`,
      [id, effectiveFrom],
    ),
  );
  return id;
}

const result = (text: string): AiResult => ({
  callId: randomUUID(),
  status: "ok",
  text,
  toolCalls: [],
  usage: { input: 10, cached: 0, output: 5, reasoning: 0 },
  costNanocents: 1,
  upstreamId: null,
  replay: [],
  toolSearches: 0,
});

type Model = { calls: AiRequest[]; complete: RunComplete };

// The run's model: the sample's read answer (or the given one) and its rules answer.
function modelFor(name: SampleName, read?: (request: AiRequest) => Promise<AiResult>): Model {
  const calls: AiRequest[] = [];
  return {
    calls,
    complete: async (_target, request) => {
      calls.push(request);
      if (request.purpose === READ_PURPOSE) return read ? read(request) : result(readAnswerFor(name));
      if (request.purpose === PROPOSE_PURPOSE) return result(JSON.stringify(rulesAnswerFor(name)));
      throw new Error(`an unexpected model call: ${request.purpose}`);
    },
  };
}

// The same model, each call also written to the model ledger at the given cost on the request's
// trace, as complete() writes it before it answers.
function billed(f: Fixture, model: Model, costs: Record<string, number>): Model {
  return {
    calls: model.calls,
    complete: async (target, request, session) => {
      const answer = await model.complete(target, request, session);
      await admin.withTenant(f.tenantId, (q) =>
        q.execute(
          `INSERT INTO model_calls (id, tenant_id, target, provider, model, kind, purpose, trace_id, status,
             reserved_nanocents, cost_nanocents)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'spark', 'meta', 'test-model', 'text', $2,
             CAST($3 AS uuid), 'ok', 0, CAST($4 AS bigint))`,
          [answer.callId, request.purpose, request.traceId ?? null, costs[request.purpose] ?? 0],
        ),
      );
      return { ...answer, costNanocents: costs[request.purpose] ?? 0 };
    },
  };
}

const screenSays =
  (text: string): CompleteFn =>
  async () =>
    result(text);

const PASS = async (): Promise<AuditResult> => ({ state: "done", verdict: "pass", concerns: [], checkedAt: null });

function depsFor(model: Model, screen = CLEAN): RunDeps {
  return {
    db: app,
    now: clock,
    complete: model.complete,
    screen: (ctx, inputId) => screenUntrustedInput(ctx, inputId, { db: app, complete: screenSays(screen), clock: () => NOW }),
    audit: PASS,
  };
}

const fileOf = (name: SampleName) => ({
  name: `${name}.pdf`,
  type: "application/pdf",
  bytes: new Uint8Array(Buffer.from(SAMPLE_POLICY_PDFS[name], "base64")),
});

async function started(f: Fixture, name: SampleName, deps: RunDeps): Promise<string> {
  const out = await startPolicyRun(f.session, fileOf(name), deps);
  if (!out.ok) throw new Error(`the start was refused: ${out.error}`);
  return out.turnId;
}

// Every stage until the run ends.
async function drive(f: Fixture, turnId: string, deps: RunDeps): Promise<RunView> {
  for (let i = 0; i < 8; i += 1) {
    const out = await advancePolicyRun(f.session, turnId, deps);
    if (!out.ok) throw new Error(`the advance was refused: ${out.error}`);
    if (out.view.status !== "running") return out.view;
  }
  throw new Error("the run did not end");
}

function viewOf(out: AdvanceOutcome): RunView {
  if (!out.ok) throw new Error(`the advance was refused: ${out.error}`);
  expect(out.busy).toBe(false);
  return out.view;
}

const stagesOf = (view: RunView | null) => view?.steps.map((s) => [s.stage, s.state]);
const checklistOf = (view: RunView | null) => Object.fromEntries((view?.checklist?.items ?? []).map((i) => [i.key, i.state]));

async function adminRows<T>(f: Fixture, sql: string, params: Param[] = []): Promise<T[]> {
  return admin.withTenant(f.tenantId, (q) => q.query<T>(sql, params));
}

type Card = { id: string; status: string; amount_cents: string; subject_id: string; args: string; exceptions: string };

const cardsOf = (f: Fixture) =>
  adminRows<Card>(
    f,
    `SELECT CAST(id AS text) AS id, status, CAST(amount_cents AS text) AS amount_cents,
       CAST(subject_id AS text) AS subject_id, CAST(args AS text) AS args, CAST(exceptions AS text) AS exceptions
       FROM proposals WHERE tenant_id = current_tenant_id() AND kind = 'pay_policy_setup' ORDER BY created_at`,
  );

const versionsOf = (f: Fixture) =>
  adminRows<Record<string, unknown>>(
    f,
    `SELECT *, CAST(effective_from AS text) AS effective_from
       FROM pay_configs WHERE tenant_id = current_tenant_id() ORDER BY pay_configs.effective_from`,
  );

const changesOf = (f: Fixture) =>
  adminRows<Record<string, unknown>>(
    f,
    `SELECT CAST(pay_config_id AS text) AS pay_config_id, CAST(proposal_id AS text) AS proposal_id, rule_key,
       old_value, new_value, CAST(asked_from AS text) AS asked_from, CAST(effective_from AS text) AS effective_from,
       applied, decided_by
       FROM pay_rule_changes WHERE tenant_id = current_tenant_id() ORDER BY created_at, id`,
  );

const readStatusOf = async (f: Fixture, documentId: string) =>
  (
    await adminRows<{ read_status: string }>(
      f,
      "SELECT read_status FROM documents WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [documentId],
    )
  )[0]?.read_status;

// The auditor's pass, stored as the second check stores it (the run's check is a fake here).
const auditorPasses = (f: Fixture, id: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_concerns = '[]',
         auditor_checked_at = CAST($2 AS timestamptz)
       WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id, new Date(NOW).toISOString()],
    ),
  );

const approve = (f: Fixture, id: string, edits?: Record<string, string>) =>
  executeProposal(f.session, id, { confirmed: false, ...(edits ? { edits } : {}) }, { db: app, clock, executors: EXECUTORS });

const setRole = (f: Fixture, role: "admin" | "staff") =>
  admin.withTenant(f.tenantId, (q) =>
    q.execute("UPDATE memberships SET role = $1 WHERE tenant_id = current_tenant_id() AND cognito_sub = $2", [
      role,
      f.session.sub,
    ]),
  );

// The auditor's evidence pack for a proposal, through the gateway as the second check reads it.
async function evidenceOf(f: Fixture, proposalId: string): Promise<Record<string, unknown>> {
  const ctx: GatewayContext = {
    session: f.session,
    role: "auditor",
    model: "wonder",
    turnId: null,
    traceId: randomUUID(),
    now: clock(),
    deadlineAt: NOW + 60_000,
    timeZone: "America/Chicago",
  };
  const out = await callTool(
    ctx,
    { id: "c", name: "get_proposal", argumentsJson: JSON.stringify({ proposalId }) },
    { db: app, clock: () => NOW },
  );
  if (out.decision !== "allowed") throw new Error(`get_proposal was not allowed: ${out.reason}`);
  return out.result;
}

// The sample's answer key, as pay_configs columns (camelCase to snake_case).
function expectedColumns(name: SampleName): Record<string, string> {
  const key = JSON.parse(readFileSync(join(process.cwd(), "src", "lib", "seed", "policy", `${name}.expected.json`), "utf8"));
  return Object.fromEntries(
    Object.entries(key.config as Record<string, { value: number | string }>).map(([k, v]) => [
      k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      String(v.value),
    ]),
  );
}

describe("a pay policy run", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `policy-a-${randomUUID().slice(0, 8)}`);
    B = await makeTenant(admin, `policy-b-${randomUUID().slice(0, 8)}`);
    C = await makeTenant(admin, `policy-c-${randomUUID().slice(0, 8)}`);
    D = await makeTenant(admin, `policy-d-${randomUUID().slice(0, 8)}`);
    E = await makeTenant(admin, `policy-e-${randomUUID().slice(0, 8)}`);
    V1.A = await addPayRules(A);
    V1.B = await addPayRules(B);
    V1.C = await addPayRules(C);
    V1.E = await addPayRules(E);
  });

  beforeAll(() => {
    flags.policyOnboardEnabled = true;
  });

  afterEach(() => {
    Object.assign(flags, saved, {
      policyLimits: { ...saved.policyLimits },
      approverRole: { ...saved.approverRole },
      policyOnboardEnabled: true,
    });
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    Object.assign(flags, saved);
    await dropTenant(admin, A);
    await dropTenant(admin, B);
    await dropTenant(admin, C);
    await dropTenant(admin, D);
    await dropTenant(admin, E);
    await app?.close();
    await admin?.close();
  });

  it("runs a sample one stage a request into a card that waits, with each model call inside its caps", async () => {
    const during: AdvanceOutcome[] = [];
    let turnId = "";
    const model = billed(
      A,
      modelFor(HARROW, async () => {
        // A second request while the read runs: the stage is taken, so it is busy and runs nothing.
        during.push(await advancePolicyRun(A.session, turnId, deps));
        return result(readAnswerFor(HARROW));
      }),
      { [READ_PURPOSE]: 700_000, [PROPOSE_PURPOSE]: 1_100_000 },
    );
    const deps = depsFor(model);

    const start = await startPolicyRun(A.session, fileOf(HARROW), deps);
    if (!start.ok) throw new Error(`the start was refused: ${start.error}`);
    turnId = start.turnId;
    let view = await readPolicyRun(A.session, turnId, deps);
    expect(view).toMatchObject({ status: "running", endedReason: null, documentId: start.documentId, proposalId: null });
    expect(stagesOf(view)).toEqual([["open", "done"]]);
    expect(Object.values(checklistOf(view))).toEqual(Array(6).fill("todo"));

    // The read: one call with the PDF, inside the read's caps.
    view = viewOf(await advancePolicyRun(A.session, turnId, deps));
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ ok: true, busy: true });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toMatchObject({
      purpose: READ_PURPOSE,
      maxOutputTokens: 6_144,
      maxCostCents: 10,
      timeoutMs: 25_000,
      messages: [{ role: "system" }, { role: "user", attachments: [{ kind: "pdf", filename: "document.pdf" }] }],
    });
    expect(stagesOf(view)).toEqual([
      ["open", "done"],
      ["read", "done"],
    ]);
    expect(checklistOf(view).read).toBe("done");
    expect(await readStatusOf(A, start.documentId)).toBe("read");

    // The screen: the real screener over the transcript, clean.
    view = viewOf(await advancePolicyRun(A.session, turnId, deps));
    expect(stagesOf(view)?.[2]).toEqual(["screen", "done"]);
    expect(model.calls).toHaveLength(1);

    // The rules: one text call over the transcript, inside the propose caps, and the card.
    view = viewOf(await advancePolicyRun(A.session, turnId, deps));
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]).toMatchObject({
      purpose: PROPOSE_PURPOSE,
      maxOutputTokens: 4_096,
      maxCostCents: 6,
      timeoutMs: 20_000,
    });
    expect(model.calls[1].messages[1]).not.toHaveProperty("attachments");
    expect(stagesOf(view)?.[3]).toEqual(["propose", "done"]);
    expect(view.proposalId).not.toBeNull();

    // The second check, then the run ends with the card ready.
    view = viewOf(await advancePolicyRun(A.session, turnId, deps));
    expect(view).toMatchObject({ status: "done", endedReason: "card_ready" });
    expect(stagesOf(view)?.[4]).toEqual(["check", "done"]);
    expect(Object.values(checklistOf(view))).toEqual(Array(6).fill("done"));
    // An ended run runs nothing more.
    expect(viewOf(await advancePolicyRun(A.session, turnId, deps))).toEqual(view);
    expect(model.calls).toHaveLength(2);
    // The turn costs what its two calls cost, never nothing.
    const [cost] = await adminRows<{ turn: string; calls: string; n: string }>(
      A,
      `SELECT CAST(t.cost_nanocents AS text) AS turn, CAST(SUM(m.cost_nanocents) AS text) AS calls,
         CAST(COUNT(m.id) AS text) AS n
         FROM turns t JOIN model_calls m ON m.tenant_id = t.tenant_id AND m.trace_id = CAST(t.trace_id AS uuid)
        WHERE t.tenant_id = current_tenant_id() AND t.id = CAST($1 AS uuid)
        GROUP BY t.cost_nanocents`,
      [turnId],
    );
    expect(cost).toEqual({ turn: "1800000", calls: "1800000", n: "2" });

    const cards = await cardsOf(A);
    expect(cards.map((c) => [c.id, c.status, c.amount_cents, c.subject_id])).toEqual([
      [view.proposalId, "proposed", "0", V1.A],
    ]);
    const args = JSON.parse(cards[0].args);
    expect(args).toMatchObject({
      v: 1,
      documentId: start.documentId,
      baseVersionId: V1.A,
      effectiveFrom: NEXT_WEEK,
      askedFrom: NEXT_WEEK,
      carrierNameInDocument: "Harrow Flats Trucking",
      revision: 0,
    });
    expect(args.fields.net_pay_floor_cents.state).toBe("needs_you");
    expect(args.fields.insurance_per_day_cents).toMatchObject({ state: "found", value: "1050" });
    // The tenant is named for its slug, not the document's carrier.
    expect(JSON.parse(cards[0].exceptions)).toContain("carrier_name_differs");
    // Nothing changed yet.
    expect(await versionsOf(A)).toHaveLength(1);
    seenA.turnId = turnId;
    seenA.proposalId = cards[0].id;

    // The second check's evidence: the engine's plan from the version in force now.
    expect((await evidenceOf(A, cards[0].id)).engine).toMatchObject({
      ok: true,
      check: "pay_policy_setup",
      proposedCents: 0,
      engine: {
        ok: true,
        amountCents: 0,
        matchesProposal: true,
        figures: {
          effectiveFrom: NEXT_WEEK,
          baseVersionId: V1.A,
          needsYou: ["net_pay_floor_cents"],
          adminRequired: false,
          changes: expect.arrayContaining([{ key: "insurance_per_day_cents", oldValue: 1_100, newValue: 1_050 }]),
        },
        sources: [{ table: "pay_configs", id: V1.A }],
      },
    });
  });

  it("approves only with a choice for every rule that needs one, and writes one version once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const id = seenA.proposalId;
    expect(id).not.toBe("");
    // The auditor's verdict first, as for every card.
    expect(await approve(A, id, { net_pay_floor_cents: "30000" })).toMatchObject({ ok: false, category: "auditor_required" });
    await auditorPasses(A, id);

    // Each of these leaves the card waiting with its Approve button and writes nothing.
    expect(await approve(A, id)).toEqual({ ok: false, category: "needs_choice", retryable: true });
    expect(await approve(A, id, { net_pay_floor_cents: "$300" })).toEqual({ ok: false, category: "bad_edit", retryable: true });
    expect(await approve(A, id, { net_pay_floor_cents: "30000", week_start_dow: "0" })).toEqual({
      ok: false,
      category: "bad_edit",
      retryable: true,
    });
    // Raising the advance limit needs an admin.
    expect(await approve(A, id, { net_pay_floor_cents: "30000", advance_limit_default_cents: "200000" })).toEqual({
      ok: false,
      category: "role",
      retryable: true,
    });
    expect((await cardsOf(A)).map((c) => c.status)).toEqual(["proposed"]);
    expect(await versionsOf(A)).toHaveLength(1);
    expect(await changesOf(A)).toEqual([]);

    expect(await approve(A, id, { net_pay_floor_cents: "30000" })).toEqual({
      ok: true,
      proposalId: id,
      status: "done",
      moneyActionId: null,
    });
    const versions = await versionsOf(A);
    expect(versions).toHaveLength(2);
    const [v1, v2] = versions;
    expect(v2.effective_from).toBe(NEXT_WEEK);
    expect(v2.id).not.toBe(V1.A);
    // Every rule the document states, the person's floor in place of the two it gives, and the
    // week start kept.
    const expected = { ...expectedColumns(HARROW), net_pay_floor_cents: "30000" };
    for (const [column, value] of Object.entries(expected)) expect(String(v2[column]), column).toBe(value);
    expect(String(v2.note)).toContain("(changed by you)");
    expect(v1.id).toBe(V1.A);

    // One row per rule that differs from the base: all but the most of earned pay an advance may
    // take, which the document states at the base's own 50 percent.
    const changes = await changesOf(A);
    expect(changes.map((c) => String(c.rule_key)).sort()).toEqual(
      [
        "accessorial_driver_share_bps",
        "advance_fee_cents",
        "advance_limit_default_cents",
        "advance_min_cents",
        "advance_recovery_cap_cents",
        "empty_miles_paid_bps",
        "escrow_per_settlement_cents",
        "escrow_target_cents",
        "insurance_applies_to",
        "insurance_per_day_cents",
        "net_pay_floor_cents",
        "percent_base",
      ].sort(),
    );
    for (const c of changes) {
      expect(c).toMatchObject({
        pay_config_id: v2.id,
        proposal_id: id,
        asked_from: NEXT_WEEK,
        effective_from: NEXT_WEEK,
        applied: "new_version",
        decided_by: A.session.sub,
      });
    }
    expect(changes.find((c) => c.rule_key === "net_pay_floor_cents")).toMatchObject({ old_value: "0", new_value: "30000" });

    // Once: a second approval is already decided and writes nothing.
    expect(await approve(A, id, { net_pay_floor_cents: "30000" })).toMatchObject({ ok: false, category: "already_decided" });
    expect(await versionsOf(A)).toHaveLength(2);
    expect(await changesOf(A)).toHaveLength(12);
  });

  it("refuses a start that no longer holds and the switch off, and lets an admin raise the advance limit", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const model = modelFor(HARROW);
    const deps = depsFor(model);
    const view = await drive(B, await started(B, HARROW, deps), deps);
    expect(view.endedReason).toBe("card_ready");
    const id = view.proposalId as string;
    await auditorPasses(B, id);
    const edits = { net_pay_floor_cents: "30000", advance_limit_default_cents: "200000" };

    // The switch off: no start, no stage, no approval, nothing written.
    flags.policyOnboardEnabled = false;
    expect(await startPolicyRun(B.session, fileOf(CEDAR), deps)).toEqual({ ok: false, error: "disabled" });
    expect(await advancePolicyRun(B.session, view.turnId, deps)).toEqual({ ok: false, error: "disabled" });
    expect(await approve(B, id, edits)).toMatchObject({ ok: false, category: "not_executable" });
    flags.policyOnboardEnabled = true;

    // A later version saved meanwhile: the start no longer holds, so the card is refused and the
    // evidence says why.
    const later = await addPayRules(B, "2026-11-09");
    expect(await approve(B, id, edits)).toEqual({ ok: false, category: "stale", retryable: false });
    expect((await evidenceOf(B, id)).engine).toMatchObject({
      ok: true,
      check: "pay_policy_setup",
      engine: { ok: false, reason: "later_version" },
    });
    expect((await cardsOf(B)).map((c) => c.status)).toEqual(["proposed"]);
    await admin.withTenant(B.tenantId, (q) =>
      q.execute("DELETE FROM pay_configs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [later]),
    );

    // Staff may not raise the advance limit; an admin may.
    expect(await approve(B, id, edits)).toEqual({ ok: false, category: "role", retryable: true });
    await setRole(B, "admin");
    try {
      expect(await approve(B, id, edits)).toMatchObject({ ok: true, status: "done" });
    } finally {
      await setRole(B, "staff");
    }
    const versions = await versionsOf(B);
    expect(versions).toHaveLength(2);
    expect(String(versions[1].advance_limit_default_cents)).toBe("200000");
  });

  it("ends a run at the spending cap and on a file it cannot read, with nothing proposed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const capped = modelFor(HARROW, async () => {
      throw new AiError("cap");
    });
    let deps = depsFor(capped);
    const cappedTurn = await started(C, HARROW, deps);
    let view = await drive(C, cappedTurn, deps);
    expect(view).toMatchObject({ status: "failed", endedReason: "budget", proposalId: null });
    expect(stagesOf(view)).toEqual([
      ["open", "done"],
      ["read", "failed"],
    ]);
    expect(checklistOf(view).read).toBe("not_done");
    expect(await readStatusOf(C, view.documentId as string)).toBe("budget");

    const garbled = modelFor(CEDAR, async () => result("not the sections"));
    deps = depsFor(garbled);
    view = await drive(C, await started(C, CEDAR, deps), deps);
    expect(view).toMatchObject({ status: "failed", endedReason: "unreadable", proposalId: null });
    expect(await readStatusOf(C, view.documentId as string)).toBe("unreadable");
    expect(garbled.calls).toHaveLength(1);

    // The same file again is the same stored document: it ends at once, with no second call.
    view = await drive(C, await started(C, CEDAR, deps), deps);
    expect(view).toMatchObject({ status: "failed", endedReason: "unreadable" });
    expect(garbled.calls).toHaveLength(1);
    expect(await cardsOf(C)).toEqual([]);
    expect(await versionsOf(C)).toHaveLength(1);
  });

  it("stops on text the screen flags and for a carrier with no pay rules, and holds the daily limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const flaggedModel = modelFor(HARROW);
    let deps = depsFor(flaggedModel, FLAGGED);
    let view = await drive(D, await started(D, HARROW, deps), deps);
    expect(view).toMatchObject({ status: "failed", endedReason: "flagged", proposalId: null });
    expect(stagesOf(view)?.slice(-1)).toEqual([["screen", "failed"]]);
    expect(flaggedModel.calls.map((c) => c.purpose)).toEqual([READ_PURPOSE]);

    const noRules = modelFor(CEDAR);
    deps = depsFor(noRules);
    view = await drive(D, await started(D, CEDAR, deps), deps);
    expect(view).toMatchObject({ status: "failed", endedReason: "no_pay_config", proposalId: null });
    expect(noRules.calls.map((c) => c.purpose)).toEqual([READ_PURPOSE, PROPOSE_PURPOSE]);
    expect(await cardsOf(D)).toEqual([]);

    flags.policyLimits.perTenantPerDay = 2;
    expect(await startPolicyRun(D.session, fileOf(HARROW), deps)).toEqual({ ok: false, error: "limit" });
  });

  it("refuses a paid week on the start and a changed transcript, and the executor fails a row that slipped past", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = depsFor(modelFor(HARROW));
    const view = await drive(E, await started(E, HARROW, deps), deps);
    expect(view.endedReason).toBe("card_ready");
    const id = view.proposalId as string;
    await auditorPasses(E, id);
    const edits = { net_pay_floor_cents: "30000" };
    const nothingWritten = async (status: string) => {
      expect((await cardsOf(E)).map((c) => c.status)).toEqual([status]);
      expect(await versionsOf(E)).toHaveLength(1);
      expect(await changesOf(E)).toEqual([]);
    };

    // A week already paid on the start: the version would rewrite paid pay, so it is refused.
    const period = randomUUID();
    await admin.withTenant(E.tenantId, (q) =>
      q.execute(
        `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($2 AS date) + 6, 'paid')`,
        [period, NEXT_WEEK],
      ),
    );
    expect(await approve(E, id, edits)).toEqual({ ok: false, category: "locked_version", retryable: false });
    await nothingWritten("proposed");
    await admin.withTenant(E.tenantId, (q) =>
      q.execute("DELETE FROM settlement_periods WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [period]),
    );

    // A Found value whose quote no longer names its rule, the figure still in its section and the
    // same: the card no longer checks.
    const setArgs = (args: string) =>
      admin.withTenant(E.tenantId, (q) =>
        q.execute("UPDATE proposals SET args = CAST($2 AS jsonb) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [
          id,
          args,
        ]),
      );
    const original = (await cardsOf(E))[0].args;
    const bare = JSON.parse(original);
    expect(bare.fields.advance_recovery_cap_cents).toMatchObject({ state: "found", value: "30000" });
    bare.fields.advance_recovery_cap_cents.passages[0].quote = "at most $300 per settlement";
    await setArgs(JSON.stringify(bare));
    expect(await approve(E, id, edits)).toEqual({ ok: false, category: "not_executable", retryable: false });
    await nothingWritten("proposed");
    await setArgs(original);

    // The transcript changed after the card was made, its hash made to match: the card's quote of
    // the insurance rate is no longer in it, so the card no longer checks.
    const [card] = await cardsOf(E);
    const transcriptId = String(JSON.parse(card.args).transcriptId);
    const [before] = await adminRows<{ body_text: string }>(
      E,
      "SELECT body_text FROM untrusted_inputs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [transcriptId],
    );
    expect(before.body_text).toContain("$10.50");
    const changed = before.body_text.split("$10.50").join("$12.50");
    await admin.withTenant(E.tenantId, (q) =>
      q.execute(
        `UPDATE untrusted_inputs SET body_text = $2, content_hash = $3
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [transcriptId, changed, untrustedContentHash("document", changed)],
      ),
    );
    expect(await approve(E, id, edits)).toEqual({ ok: false, category: "not_executable", retryable: false });
    await nothingWritten("proposed");

    // A row moved to approved without the gate's check, then run: the executor checks it again
    // itself and fails it, with nothing written.
    await admin.withTenant(E.tenantId, (q) =>
      q.execute(
        `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id, E.session.sub, new Date(NOW).toISOString()],
      ),
    );
    const row = {
      id,
      kind: "pay_policy_setup",
      subjectTable: "pay_configs",
      subjectId: card.subject_id,
      status: "approved",
    } as ProposalRow;
    expect(await payPolicySetupExecutor(app, E.session, row, { confirmed: false, edits }, { db: app, clock })).toEqual({
      ok: false,
      category: "not_executable",
      retryable: false,
    });
    await nothingWritten("failed");
  });

  it("shows another carrier nothing and approves nothing for it", async () => {
    const deps = depsFor(modelFor(HARROW));
    expect(seenA.turnId).not.toBe("");
    expect(await readPolicyRun(B.session, seenA.turnId, deps)).toBeNull();
    expect(await advancePolicyRun(B.session, seenA.turnId, deps)).toEqual({ ok: false, error: "not_found" });
    expect(await approve(B, seenA.proposalId, { net_pay_floor_cents: "30000" })).toMatchObject({
      ok: false,
      category: "not_found",
    });
    expect(await readPolicyRun(A.session, "not-a-turn", deps)).toBeNull();
  });
});
