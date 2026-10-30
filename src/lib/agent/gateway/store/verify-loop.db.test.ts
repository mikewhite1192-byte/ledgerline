import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "../../../auth/claims";
import { readAdvanceInput } from "../../../data/read";
import { createPgDb } from "../../../db/pg";
import { adminUrl, appUrl } from "../../../db/test-urls";
import type { Db } from "../../../db/types";
import { advanceEligibility } from "../../../rules-engine/advances";
import { DEMO_CARRIERS, type DemoCarrier } from "../../../seed/carriers";
import { buildCarrierPlan } from "../../../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../../../seed/run";
import { dbTurnStore, openAgentTurn } from "./index";
import type { GatewayContext, GatewayOutcome, ProposalDraft } from "../types";
import { escalatedText } from "../../policy";
import { runTurn, type TurnDeps } from "../../operator/turn";

// The checks inside the submit (design-agents-102 3.2) against a real database, as the app's role:
// the engine recomputes a chat draft before the insert, a draft one cent over what it allows is
// refused and never stored, a matched draft is stored with its match in the same INSERT, and three
// refused tries end the turn with a person (Home's row for that: home/needs-you.db.test.ts). The
// model and the gateway are stand-ins (a fixed reply list and an allowed outcome carrying the
// draft); the store, the engine and the tables are real. One tenant, seeded with the demo plan,
// removed after.

const ANCHOR = "2026-11-02";
const NOW = new Date("2026-11-02T16:00:00.000Z");
const CARRIER = { ...DEMO_CARRIERS[0], slug: "verify-loop-test", name: "Verify Loop Test" } as unknown as DemoCarrier;
const plan = buildCarrierPlan(CARRIER, ANCHOR);
const T = randomUUID();
const SESSION: Session = { sub: `sub-${T}`, email: "ops@verify-loop-test.example", tenantId: T };
const LIMITS = { maxToolSteps: 6, maxModelCalls: 4, maxTurnCents: 40, wallClockMs: 22_000, summaryChars: 10_000 };
const TOOLS: TurnDeps["tools"] = [{ name: "propose_advance", description: "propose", parameters: {} }];

type Reply = Awaited<ReturnType<TurnDeps["complete"]>>;

let admin: Db;
let app: Db;
// An armed driver with room for an advance today, and the most the engine allows.
let driverId = "";
let maxCents = 0;

const reply = (partial: Partial<Reply>): Reply => ({
  callId: randomUUID(),
  status: "ok",
  text: "",
  toolCalls: [],
  usage: { input: 100, cached: 0, output: 20, reasoning: 0 },
  costNanocents: 500_000_000,
  upstreamId: null,
  replay: [],
  toolSearches: 0,
  ...partial,
});

const propose = (id: string, amountCents: number) => ({
  id,
  name: "propose_advance",
  argumentsJson: JSON.stringify({ driverId, amountCents }),
});

const draftOf = (amountCents: number): ProposalDraft =>
  ({
    kind: "advance_payout",
    subjectTable: "drivers",
    subjectId: driverId,
    amountCents,
    args: { driverId, amountCents },
    limitCents: amountCents,
    exceptions: [],
    reasons: [],
    sources: [{ table: "drivers", id: driverId }],
  }) as unknown as ProposalDraft;

// A recorded gateway decision for each call (the steps and the card point at it).
async function decision(): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(T, (q) =>
    q.execute(
      `INSERT INTO gateway_decisions (id, tenant_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'trace-verify', 'operator', 'spark', 'propose_advance',
         'propose', 'allowed', 'ok', 1)`,
      [id],
    ),
  );
  return id;
}

// One turn: the replies in order, every propose_advance allowed with its draft, the real store.
async function runWith(replies: Reply[], text: string) {
  const turnId = randomUUID();
  const opened = await openAgentTurn(
    SESSION,
    { conversationId: null, turnId, text, now: NOW, summaryChars: LIMITS.summaryChars },
    { db: app, clock: () => NOW },
  );
  if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
  let modelCalls = 0;
  const deps: TurnDeps = {
    complete: async () => {
      modelCalls += 1;
      const next = replies.shift();
      if (!next) throw new Error("no reply queued");
      return next;
    },
    callTool: async (_ctx, call): Promise<GatewayOutcome> => {
      const { amountCents } = JSON.parse(call.argumentsJson) as { amountCents: number };
      return {
        decision: "allowed",
        decisionId: await decision(),
        tool: call.name,
        tier: "propose",
        reason: "ok",
        result: { proposed: true, amountCents },
        refs: [],
        draft: draftOf(amountCents),
        latencyMs: 1,
      };
    },
    store: dbTurnStore(SESSION, { db: app, clock: () => NOW }),
    tools: TOOLS,
    clock: () => NOW.getTime(),
    limits: LIMITS,
    verification: { enabled: true, maxAttempts: 3 },
  };
  const out = await runTurn({ session: SESSION, turn: opened, text, startedAt: NOW.getTime() }, deps);
  return { out, turnId, modelCalls: () => modelCalls };
}

const stepsOf = (turnId: string) =>
  admin.withTenant(T, (q) =>
    q.query<{ kind: string; state: string; detail: Record<string, unknown>; proposal_id: string | null }>(
      `SELECT kind, state, detail, CAST(proposal_id AS text) AS proposal_id FROM turn_steps
        WHERE turn_id = CAST($1 AS uuid) ORDER BY seq`,
      [turnId],
    ),
  );

type CardRow = {
  id: string;
  amount_cents: number | string;
  engine_check: string | null;
  engine_cents: number | string | null;
  same_time: boolean;
};
const cardsOf = (turnId: string) =>
  admin.withTenant(T, (q) =>
    q.query<CardRow>(
      `SELECT CAST(id AS text) AS id, amount_cents, engine_check, engine_cents,
              engine_checked_at IS NOT DISTINCT FROM created_at AS same_time
         FROM proposals WHERE turn_id = CAST($1 AS uuid)`,
      [turnId],
    ),
  );

describe("the checks inside the submit, against the database", () => {
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
        "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')",
        [SESSION.sub, SESSION.email],
      ),
    );
    // The engine's own answer, read the way the check reads it, picks the driver and the figure.
    await admin.withTenant(T, async (q) => {
      for (const d of plan.rows.drivers as { id: string }[]) {
        const input = await readAdvanceInput(q, d.id, NOW.toISOString(), 100);
        const decision = advanceEligibility(input);
        if (decision.maxCents >= 200) {
          driverId = d.id;
          maxCents = decision.maxCents;
          return;
        }
      }
    });
    expect(driverId, "the demo plan has an armed driver with room for an advance").not.toBe("");
  });

  afterAll(async () => {
    if (admin) {
      await clearTenantAgent(admin, T).catch(() => undefined);
      await admin.withTenant(T, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("asks the engine about a draft before it is saved: one cent over is a mismatch, the most it allows matches", async () => {
    const store = dbTurnStore(SESSION, { db: app, clock: () => NOW });
    const ctx = { session: SESSION, role: "operator", model: "spark", now: NOW } as unknown as GatewayContext;
    expect(await store.checkDraft(draftOf(maxCents + 1), ctx)).toEqual({ check: "mismatch", engineCents: 0 });
    expect(await store.checkDraft(draftOf(maxCents), ctx)).toEqual({ check: "matched", engineCents: maxCents });
    // Another carrier's session is refused by the membership check: unknown, never matched.
    const stranger = dbTurnStore({ ...SESSION, sub: "sub-nobody" }, { db: app, clock: () => NOW });
    expect(await stranger.checkDraft(draftOf(maxCents), ctx)).toBeNull();
  });

  it("refuses a draft one cent over with engine_mismatch and stores nothing, then saves the matched one with its match in the same insert", async () => {
    const { out, turnId } = await runWith(
      [
        reply({ toolCalls: [propose("p1", maxCents + 1)] }),
        reply({ toolCalls: [propose("p2", maxCents)] }),
        reply({ text: "The advance card is ready for you to approve." }),
      ],
      "Can this driver get an advance today?",
    );
    expect(out).toMatchObject({ status: "done", endedReason: null });
    const steps = await stepsOf(turnId);
    const tools = steps.filter((s) => s.kind === "tool");
    expect(tools.map((s) => [s.state, s.detail.attempt, s.detail.refusal ?? null])).toEqual([
      ["failed", 1, "engine_mismatch"],
      ["done", 2, null],
    ]);
    const cards = await cardsOf(turnId);
    expect(cards).toHaveLength(1);
    expect({ ...cards[0], amount_cents: Number(cards[0].amount_cents), engine_cents: Number(cards[0].engine_cents) }).toMatchObject({
      amount_cents: maxCents,
      engine_check: "matched",
      engine_cents: maxCents,
      same_time: true,
    });
    expect(steps.filter((s) => s.kind === "proposal").map((s) => [s.proposal_id, s.detail.accepted])).toEqual([
      [cards[0].id, true],
    ]);
    // The refused figure was never inserted anywhere on this carrier.
    const over = await admin.withTenant(T, (q) =>
      q.query<{ n: string }>("SELECT count(*) AS n FROM proposals WHERE amount_cents = $1", [maxCents + 1]),
    );
    expect(Number(over[0].n)).toBe(0);
  });

  it("hands the request to a person after three refused tries, with no card and no fourth model call", async () => {
    const { out, turnId, modelCalls } = await runWith(
      [
        reply({ toolCalls: [propose("q1", maxCents + 1)] }),
        reply({ toolCalls: [propose("q2", maxCents + 2)] }),
        reply({ toolCalls: [propose("q3", maxCents + 3)] }),
        reply({ text: "unused" }),
      ],
      "Pay this driver a bigger advance.",
    );
    expect(out).toMatchObject({ status: "partial", endedReason: "escalated", text: escalatedText(3) });
    expect(modelCalls()).toBe(3);
    expect(await cardsOf(turnId)).toEqual([]);
    const steps = await stepsOf(turnId);
    expect(steps.filter((s) => s.kind === "tool").map((s) => s.detail.attempt)).toEqual([1, 2, 3]);
    expect(steps.filter((s) => s.kind === "escalation").map((s) => [s.state, s.detail])).toEqual([
      [
        "failed",
        { reason: "verification_failed", attempts: 3, finishedBy: "person", toolName: expect.any(String) },
      ],
    ]);
    const [turn] = await admin.withTenant(T, (q) =>
      q.query<{ status: string; ended_reason: string | null }>(
        "SELECT status, ended_reason FROM turns WHERE id = CAST($1 AS uuid)",
        [turnId],
      ),
    );
    expect(turn).toEqual({ status: "partial", ended_reason: "escalated" });
  });
});
