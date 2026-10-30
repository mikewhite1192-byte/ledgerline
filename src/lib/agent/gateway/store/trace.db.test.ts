import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import type { Session } from "../../../auth/claims";
import { createPgDb } from "../../../db/pg";
import { adminUrl, appUrl } from "../../../db/test-urls";
import type { Db, Queryable } from "../../../db/types";
import { traceLines } from "../../../trace/format";
import { readAgentModelWeek, readAgentTurnTrace } from "./index";

// How a turn was worked out, and the carrier's model week, against a real database as the app's
// role: a carrier never sees another carrier's model calls, a person sees only the traces of
// their own conversations, and the week holds only calls inside the carrier's own pay week in its
// own time zone. Every row is written with a fixed time, so nothing here reads the wall clock.
// Only this file's two tenants are made, and they are removed after (their rows go by cascade).

const A = randomUUID();
const B = randomUUID();
const T0 = Date.UTC(2026, 10, 2, 15, 0, 0); // Monday Nov 2, 2026, 10:00 in New York

const ids = (tenant: string) => ({
  conversation: randomUUID(),
  turn: randomUUID(),
  trace: randomUUID(),
  driver: randomUUID(),
  input: randomUUID(),
  proposal: randomUUID(),
  plan: randomUUID(),
  wonder: randomUUID(),
  screen: randomUUID(),
  edge: randomUUID(),
  old: randomUUID(),
  blocked: randomUUID(),
  allowed: randomUUID(),
  tenant,
});
const IDS = { [A]: ids(A), [B]: ids(B) };
const SUMMARY = "Current state (from the database, for this turn only):\n\nCarrier:\nCarrier: Trace test";
const NOTE = "Over the limit, so ask again at the limit.";

let admin: Db;
let app: Db;

const session = (tenantId: string, sub = `sub-${tenantId}`): Session => ({ sub, email: "", tenantId });
const deps = () => ({ db: app, clock: () => new Date(T0) });

async function call(
  q: Queryable,
  id: string,
  target: string,
  model: string,
  purpose: string,
  at: string,
  opts: {
    effort?: string;
    ms?: number;
    cost?: number | null;
    trace?: string | null;
    status?: string;
    input?: number;
    cached?: number;
  } = {},
) {
  await q.execute(
    `INSERT INTO model_calls (id, tenant_id, provider, model, purpose, status, reserved_nanocents,
       cost_nanocents, duration_ms, created_at, settled_at, target, reasoning_effort, trace_id,
       input_tokens, cached_tokens)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, $5, 2000000000, $6, $7,
       CAST($8 AS timestamptz), CAST($8 AS timestamptz), $9, $10, CAST($11 AS uuid),
       CAST($12 AS integer), CAST($13 AS integer))`,
    [
      id,
      target === "spark_open" ? "baseten" : "meta",
      model,
      purpose,
      opts.status ?? "ok",
      opts.cost === undefined ? 100_000_000 : opts.cost,
      opts.ms ?? 1_000,
      at,
      target,
      opts.effort ?? null,
      opts.trace ?? null,
      opts.input ?? null,
      opts.cached ?? null,
    ],
  );
}

async function seed(tenantId: string, slug: string, payWeekFromWednesday: boolean) {
  const x = IDS[tenantId];
  await admin.withTenant(tenantId, async (q) => {
    await q.execute(
      "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
      [slug, `Carrier ${slug}`],
    );
    for (const [sub, role] of [
      [`sub-${tenantId}`, "admin"],
      [`other-${tenantId}`, "staff"],
    ]) {
      await q.execute(
        "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, $3)",
        [sub, `${sub.slice(0, 12)}@${slug}.example`, role],
      );
    }
    if (payWeekFromWednesday) {
      await q.execute(
        `INSERT INTO pay_configs (id, tenant_id, effective_from, source, week_start_dow, percent_base,
           empty_miles_paid_bps, accessorial_driver_share_bps, insurance_applies_to,
           insurance_per_day_cents, escrow_target_cents, escrow_per_settlement_cents,
           net_pay_floor_cents, advance_fee_cents, advance_limit_default_cents,
           advance_max_bps_of_earned, advance_min_cents)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST('2026-01-01' AS date), 'seed', 3, 'linehaul',
           0, 10000, 'owner_operator', 0, 0, 0, 0, 500, 50000, 5000, 2500)`,
        [randomUUID()],
      );
    }
    await q.execute(
      `INSERT INTO conversations (id, tenant_id, created_by, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS timestamptz), CAST($3 AS timestamptz))`,
      [x.conversation, `sub-${tenantId}`, "2026-11-02T14:00:00Z"],
    );
    await q.execute(
      `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, assistant_text, status, trace_id,
         started_at, finished_at, context_summary)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Can AG-1 get an advance?',
         'Yes, up to the limit.', 'done', $3, CAST('2026-11-02T14:00:00Z' AS timestamptz),
         CAST('2026-11-02T14:00:08Z' AS timestamptz), $4)`,
      // Carrier A's turn kept the summary it started from; carrier B's is an older turn that did not.
      [x.turn, x.conversation, x.trace, tenantId === A ? SUMMARY : null],
    );
    // Carrier A's first call read most of its input from the prompt cache after a tool search;
    // carrier B's has no token counts.
    await call(q, x.plan, "spark", "muse-spark-1.3", "agent_operator_turn", "2026-11-02T14:00:01Z", {
      effort: "low",
      ms: 1_840,
      cost: 700_000_000,
      trace: x.trace,
      ...(tenantId === A ? { input: 2_480, cached: 1_912 } : {}),
    });
    await q.execute(
      `INSERT INTO turn_steps (id, tenant_id, turn_id, seq, kind, label, state, model_call_id, detail,
         started_at, finished_at, reasoning_note)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'model', 'Thinking it through',
         'done', CAST($3 AS uuid), CAST($4 AS jsonb),
         CAST('2026-11-02T14:00:00Z' AS timestamptz), CAST('2026-11-02T14:00:02Z' AS timestamptz), $5)`,
      [
        randomUUID(),
        x.turn,
        x.plan,
        JSON.stringify(tenantId === A ? { status: "ok", toolCalls: 1, toolSearches: 1 } : { status: "ok", toolCalls: 1 }),
        tenantId === A ? NOTE : null,
      ],
    );
    if (tenantId !== A) return;

    // Carrier A's turn goes on: a blocked ask, a screening, an escalation, a saved card.
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, refs,
         decision, reason, limit_cents, model_call_id, latency_ms, created_at, result_chars)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark',
         'propose_advance', 'propose', CAST($4 AS jsonb), 'blocked', 'amount_over_limit', 41200,
         CAST($5 AS uuid), 3, CAST('2026-11-02T14:00:02Z' AS timestamptz), 57)`,
      [x.blocked, x.turn, x.trace, JSON.stringify([{ table: "drivers", id: x.driver }]), x.plan],
    );
    await q.execute(
      `INSERT INTO turn_steps (id, tenant_id, turn_id, seq, kind, label, state, gateway_decision_id,
         detail, started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 2, 'tool',
         'Checking advance eligibility', 'failed', CAST($3 AS uuid),
         CAST('{"tool":"propose_advance","decision":"blocked","reason":"amount_over_limit"}' AS jsonb),
         CAST('2026-11-02T14:00:02Z' AS timestamptz), CAST('2026-11-02T14:00:03.500Z' AS timestamptz))`,
      [randomUUID(), x.turn, x.blocked],
    );
    await q.execute(
      `INSERT INTO untrusted_inputs (id, tenant_id, kind, source, body_text, content_hash, received_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'email', 'inbound', 'Please advance my pay.', $2,
         CAST('2026-11-02T12:00:00Z' AS timestamptz))`,
      [x.input, "b".repeat(64)],
    );
    await call(q, x.screen, "spark_open", "meta-models/muse-spark-open-1026", "screen_untrusted_input",
      "2026-11-02T14:00:03Z", { ms: 400, cost: 50_000_000, trace: x.trace });
    await q.execute(
      `INSERT INTO screenings (id, tenant_id, input_id, content_hash, verdict, via, model_call_id,
         latency_ms, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'clean', 'model',
         CAST($4 AS uuid), 400, CAST('2026-11-02T14:00:03.400Z' AS timestamptz))`,
      [randomUUID(), x.input, "b".repeat(64), x.screen],
    );
    await call(q, x.wonder, "wonder", "muse-wonder-1.0", "agent_operator_escalation", "2026-11-02T14:00:05Z", {
      effort: "high",
      ms: 4_100,
      cost: 5_800_000_000,
      trace: x.trace,
      input: 3_000,
      cached: 0,
    });
    await q.execute(
      `INSERT INTO turn_steps (id, tenant_id, turn_id, seq, kind, label, state, model_call_id, detail,
         started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 3, 'escalation',
         'Asking Muse Wonder to form the proposal', 'done', CAST($3 AS uuid),
         CAST('{"reason":"schema_failed_twice","attempts":2,"from":"spark","finishedBy":"wonder"}' AS jsonb),
         CAST('2026-11-02T14:00:04Z' AS timestamptz), CAST('2026-11-02T14:00:09Z' AS timestamptz))`,
      [randomUUID(), x.turn, x.wonder],
    );
    await q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision,
         reason, limit_cents, model_call_id, latency_ms, created_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'wonder',
         'propose_advance', 'propose', 'allowed', 'ok', 41200, CAST($4 AS uuid), 3,
         CAST('2026-11-02T14:00:09Z' AS timestamptz))`,
      [x.allowed, x.turn, x.trace, x.wonder],
    );
    await q.execute(
      `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
         amount_cents, direction, title, args, exceptions, operator_verdict, gateway_decision_id,
         dedupe_key, trace_id, created_at, updated_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'advance_payout',
         'drivers', CAST($4 AS uuid), 41200, 'out', 'Pay advance', CAST('{}' AS jsonb),
         CAST('["capped_to_eligible"]' AS jsonb), 'partial', CAST($5 AS uuid), $6, $7,
         CAST('2026-11-02T14:00:10Z' AS timestamptz), CAST('2026-11-02T14:00:10Z' AS timestamptz))`,
      [x.proposal, x.conversation, x.turn, x.driver, x.allowed, `propose_advance:${x.driver}:${"c".repeat(64)}`, x.trace],
    );
    await q.execute(
      `INSERT INTO turn_steps (id, tenant_id, turn_id, seq, kind, label, state, proposal_id, detail,
         started_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 4, 'proposal',
         'Preparing a proposal card', 'done', CAST($3 AS uuid), CAST('{"result":"created"}' AS jsonb),
         CAST('2026-11-02T14:00:10Z' AS timestamptz), CAST('2026-11-02T14:00:10Z' AS timestamptz))`,
      [randomUUID(), x.turn, x.proposal],
    );
    // Two calls with no turn: one a second before A's pay week starts (Wednesday Oct 28, 00:00 in
    // New York, still daylight time, so 04:00 UTC) and one right at the start.
    await call(q, x.old, "spark", "muse-spark-1.3", "ai_proof", "2026-10-28T03:59:59Z", { cost: 1_000_000_000 });
    await call(q, x.edge, "spark", "muse-spark-1.3", "ai_proof", "2026-10-28T04:00:00Z", {
      cost: 100_000_000,
      input: 1_000,
      cached: 500,
    });
  });
}

describe("the trace and the model week", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await seed(A, `trace-a-${A.slice(0, 8)}`, true);
    await seed(B, `trace-b-${B.slice(0, 8)}`, false);
  });

  afterAll(async () => {
    for (const id of [A, B]) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("never shows one carrier the other's model calls, even to a plain read as the app", async () => {
    const seen = await app.withTenant(A, (q) => q.query<{ id: string }>("SELECT id FROM model_calls"));
    const a = IDS[A];
    expect(seen.map((r) => r.id).sort()).toEqual([a.plan, a.screen, a.wonder, a.old, a.edge].sort());
    expect(seen.map((r) => r.id)).not.toContain(IDS[B].plan);
  });

  it("reads a turn's trace with each call's model, effort, time and cost, and each decision", async () => {
    const a = IDS[A];
    const trace = await readAgentTurnTrace(session(A), a.turn, deps());
    expect(trace).not.toBeNull();
    if (!trace) return;
    expect(trace.steps.map((s) => s.kind)).toEqual(["model", "tool", "escalation", "proposal"]);
    expect(trace.steps[0]).toMatchObject({
      toolCalls: 1,
      toolSearches: 1,
      call: {
        id: a.plan,
        target: "spark",
        provider: "meta",
        model: "muse-spark-1.3",
        effort: "low",
        durationMs: 1_840,
        costNanocents: 700_000_000,
        inputTokens: 2_480,
        cachedTokens: 1_912,
        // The cached tokens at Muse Spark's full input price less their cached price.
        savedNanocents: 1_912 * 110_000,
      },
    });
    expect(trace.steps[1].decision).toEqual({
      id: a.blocked,
      tool: "propose_advance",
      decision: "blocked",
      reason: "amount_over_limit",
      limitCents: 41_200,
      issuedBy: a.plan,
      refs: [{ table: "drivers", id: a.driver }],
      resultChars: 57,
    });
    // The step-through's three pieces: the summary the turn started from, the model step's note,
    // and the size of what each tool sent back. Only a model step carries a note.
    expect(trace.contextSummary).toBe(SUMMARY);
    expect(trace.steps[0].reasoningNote).toBe(NOTE);
    expect(trace.steps.slice(1).every((s) => s.reasoningNote === undefined)).toBe(true);
    expect(trace.steps[1].toolSearches).toBeNull();
    expect(trace.steps[2]).toMatchObject({
      call: { id: a.wonder, target: "wonder", effort: "high", costNanocents: 5_800_000_000, inputTokens: 3_000, cachedTokens: 0, savedNanocents: 0 },
      escalation: { attempts: 2, finishedBy: "wonder" },
    });
    expect(trace.steps[3]).toMatchObject({ proposalId: a.proposal, result: "created" });
    expect(trace.extraCalls).toEqual([
      expect.objectContaining({
        id: a.screen,
        target: "spark_open",
        provider: "baseten",
        afterSeq: 2,
        screen: { verdict: "clean", via: "model" },
        // No token counts: no saving, never a zero one.
        inputTokens: null,
        cachedTokens: null,
        savedNanocents: null,
      }),
    ]);
    expect(trace.proposals).toEqual([
      expect.objectContaining({ id: a.proposal, gatewayDecisionId: a.allowed, operatorVerdict: "partial", exceptions: ["capped_to_eligible"], flagged: false }),
    ]);
    const text = traceLines(trace).map((l) => `${l.who}: ${l.text}`);
    expect(text).toEqual([
      "Muse Spark 1.3: Planned the next step: asked for 1 tool, after one tool search",
      "Safety check: Checking advance eligibility: blocked, the amount is over the eligible limit ($412.00)",
      "Muse Spark Open: Screened outside text before the agent read it: clean",
      "Muse Wonder: Took over after Muse Spark could not form the card twice",
      "LedgerLine: Saved the card for a person to approve",
    ]);
    expect(traceLines(trace).map((l) => l.cache ?? null)).toEqual([
      "1,912 of 2,480 input tokens from cache, saved 0.2 cents at list price",
      null,
      null,
      "no input tokens from cache",
      null,
    ]);
  });

  it("keeps the turn's summary and the model's note on the server while the step-through is not shown", async () => {
    const a = IDS[A];
    const saved = flags.stepThrough;
    flags.stepThrough = { dev: false, staff: false };
    try {
      const off = await readAgentTurnTrace(session(A), a.turn, deps());
      expect(off).not.toBeNull();
      expect(off && "contextSummary" in off).toBe(false);
      expect(off?.steps.some((s) => "reasoningNote" in s)).toBe(false);
      expect(JSON.stringify(off)).not.toContain(SUMMARY);
      expect(JSON.stringify(off)).not.toContain(NOTE);
      // The rest of the trace reads as it does with the switch on.
      expect(off?.steps.map((s) => s.kind)).toEqual(["model", "tool", "escalation", "proposal"]);
      expect(off?.steps[0].call?.id).toBe(a.plan);
    } finally {
      flags.stepThrough = saved;
    }
    const on = await readAgentTurnTrace(session(A), a.turn, deps());
    expect(on?.contextSummary).toBe(SUMMARY);
    expect(on?.steps[0].reasoningNote).toBe(NOTE);
  });

  it("gives nothing for another carrier's turn, or for another person's conversation", async () => {
    expect(await readAgentTurnTrace(session(A), IDS[B].turn, deps())).toBeNull();
    expect(await readAgentTurnTrace(session(B), IDS[A].turn, deps())).toBeNull();
    expect(await readAgentTurnTrace(session(A, `other-${A}`), IDS[A].turn, deps())).toBeNull();
    const own = await readAgentTurnTrace(session(B), IDS[B].turn, deps());
    expect(JSON.stringify(own)).not.toContain(IDS[A].plan);
    expect(own?.steps[0].call?.id).toBe(IDS[B].plan);
    expect(own?.steps[0]).toMatchObject({ toolSearches: null, call: { inputTokens: null, cachedTokens: null, savedNanocents: null } });
    // A turn that kept no summary and a step with no note read as absent, never as empty text.
    expect(own && "contextSummary" in own).toBe(false);
    expect(own && "reasoningNote" in own.steps[0]).toBe(false);
    expect(JSON.stringify(own)).not.toContain(NOTE);
  });

  it("sums only this carrier's calls inside its own pay week", async () => {
    const a = await readAgentModelWeek(session(A), deps());
    expect(a.week).toEqual({ start: "2026-10-28", end: "2026-11-03", zone: "America/New_York" });
    expect(a.calls).toBe(4);
    expect(a.costNanocents).toBe(700_000_000 + 50_000_000 + 5_800_000_000 + 100_000_000);
    const spark = a.models.find((m) => m.target === "spark");
    expect(spark).toMatchObject({ calls: 2, ok: 2, costNanocents: 800_000_000, versions: ["Muse Spark 1.3"] });
    // The plan call and the call at the week's edge: 2,412 of 3,480 input tokens cached (69%).
    expect(spark).toMatchObject({ inputTokens: 3_480, cachedTokens: 2_412, savedNanocents: 2_412 * 110_000, cachedShare: 69 });
    expect(a.models.find((m) => m.target === "wonder")).toMatchObject({ calls: 1, p50Ms: 4_100 });
    expect(a.models.find((m) => m.target === "wonder")).toMatchObject({ inputTokens: 3_000, cachedTokens: 0, savedNanocents: 0, cachedShare: 0 });
    expect(a.models.find((m) => m.target === "spark_open")).toMatchObject({ inputTokens: 0, cachedTokens: 0, cachedShare: null });
    expect(a).toMatchObject({ inputTokens: 6_480, cachedTokens: 2_412, savedNanocents: 2_412 * 110_000, cachedShare: 37 });
    expect(a.decisions).toEqual({ allowed: 1, blocked: 1, refused: 0, failed: 0, total: 2 });
    expect(a.screenings).toMatchObject({ clean: 1, flagged: 0, byModel: 1, total: 1 });
    expect(a.escalations).toBe(1);

    // Carrier B has no pay config, so its week runs from Monday; it holds B's one call only.
    const b = await readAgentModelWeek(session(B), deps());
    expect(b.week).toEqual({ start: "2026-11-02", end: "2026-11-08", zone: "America/New_York" });
    expect(b.calls).toBe(1);
    expect(b.costNanocents).toBe(700_000_000);
    expect(b).toMatchObject({ inputTokens: 0, cachedTokens: 0, savedNanocents: 0, cachedShare: null });
    expect(b.decisions.total).toBe(0);
    expect(b.screenings.total).toBe(0);
    expect(b.escalations).toBe(0);
  });
});
