import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { applyLocalOverrides } from "../../config/local-overrides";
import { LOCAL_SWITCHES, REPLAY_FIXTURE } from "../../../e2e/env.local-mode";
import { fingerprint, fingerprintParts, parseFixture, RESPONSES_PATH } from "../../../e2e/replay";
import type { FocusSubject } from "../agent/gateway/focus";
import { toolsFor } from "../agent/gateway/registry";
import type { OpenedTurn, TurnStore } from "../agent/gateway/store";
import { buildStateSummary } from "../agent/gateway/store/summary";
import { runTurn, turnRequest, type TurnDeps } from "../agent/operator/turn";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { complete } from "./index";
import type { FetchFn } from "./providers/http";
import { QUIET_JOB } from "./test-fixtures";

// The page focus adds no tool and no prompt line to the recorded demo path (design-ui-pass 2): the
// demo-path run's first question, through the real turn loop and the real wrapper with the local
// run's switches, sends a request whose replay fingerprint is the recorded fixture key, with a
// focus in the state summary or without one. The focus rides in the summary, a system message the
// fingerprint never reads; the tools and the person's text are the same. A fake host and a fake
// ledger; nothing leaves the test (the agent test files may not import the wrapper).

const QUESTION = "Who has a problem on this week's paystub?";
const RECORDED_KEY = "a982319d3a12c36b";
const SETTLEMENT = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-27T15:00:00.000Z");
const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const CONVERSATION = "55555555-5555-4555-8555-555555555555";

const ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  DB_CLUSTER_ARN: "",
  META_MODEL_SPARK: "muse-spark-1.3",
  META_MODEL_WONDER: "muse-wonder-1.0",
  AI_SPEND_CAP_CENTS: "200",
  AI_WONDER_CAP_CENTS: "60",
  META_CONTRIBUTOR_MODE: "false",
  META_API_KEY: "local-replay-placeholder",
};

const FOCUS: FocusSubject = {
  table: "settlements",
  id: SETTLEMENT,
  words: ["settlement for Sam Rivera (AG-1)", "week ending 2026-10-25", "status draft"],
  amount: { what: "net", cents: 123_456 },
};

// The carrier's rows as the summary reads them: a tenant, no pay rules, a fresh conversation.
const carrier: Queryable = {
  async query<T>(sql: string): Promise<T[]> {
    if (sql.includes("FROM tenants")) {
      return [{ id: SESSION.tenantId, slug: "blue-ridge", name: "Blue Ridge Freight", timezone: "America/New_York" }] as T[];
    }
    if (sql.includes("FROM conversations")) return [{ subject_table: null, subject_id: null }] as T[];
    return [] as T[];
  },
  async execute() {
    throw new Error("the summary only reads");
  },
};

// The model-call ledger, answered just well enough for the call to reserve and settle.
function ledger(): TenantDb {
  const rows = new Map<string, { reserved_nanocents: number; target: string }>();
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("FROM spend_alerts")) return [QUIET_JOB] as T[];
      if (sql.includes("FROM ops.ai_spend")) {
        return [
          { spent_nanocents: 0, reserved_nanocents: 0, calls: 0, wonder_spent_nanocents: 0, wonder_reserved_nanocents: 0 },
        ] as T[];
      }
      if (sql.includes("FROM model_calls")) {
        const row = rows.get(String(params[0]));
        return (row ? [row] : []) as T[];
      }
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      if (sql.startsWith("INSERT INTO model_calls")) {
        rows.set(String(params[0]), { reserved_nanocents: Number(params[8]), target: String(params[1]) });
      }
      return 1;
    },
  };
  return { withTenant: async (_tenantId, fn) => fn(q) };
}

function memoryStore(): TurnStore {
  let seq = 0;
  const view = (id: string, kind: string, label: string, state: "running" | "done" | "failed") =>
    ({ id, seq, kind, label, state }) as Awaited<ReturnType<TurnStore["startStep"]>>;
  return {
    startStep: async (_turnId, s) => {
      seq += 1;
      return view(`step-${seq}`, s.kind, s.label, "running");
    },
    finishStep: async (_turnId, stepId, f) => view(stepId, "model", "", f.state),
    persistProposal: async () => {
      throw new Error("no proposal in this turn");
    },
    checkDraft: async () => null,
    flagTurnProposals: async () => 0,
    setChecklist: async () => {},
    finishTurn: async () => {},
  };
}

// The demo-path run's first question with the local run's switches, as defaultTurnDeps builds it,
// through complete() to a fake host. Returns each request as sent, with the path it went to.
async function firstQuestion(focus: FocusSubject | null) {
  const summary = await buildStateSummary(carrier, SESSION, CONVERSATION, new Date(NOW), flags.agentTurnLimits.summaryChars, QUESTION, [], focus);
  const turn: OpenedTurn = {
    turnId: "44444444-4444-4444-8444-444444444444",
    conversationId: CONVERSATION,
    seq: 1,
    traceId: "66666666-6666-4666-8666-666666666666",
    timeZone: "America/New_York",
    summary: summary.text,
    summaryChars: summary.chars,
    summaryCents: summary.cents,
  };
  const fetchFn = vi.fn<FetchFn>(async () =>
    Response.json({
      id: "resp_focus",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "No one has a problem this week." }] }],
      usage: { input_tokens: 9_000, output_tokens: 40 },
    }),
  );
  const db = ledger();
  const tools = toolsFor("operator", { defer: flags.agentToolSearch });
  const verification = { enabled: flags.verification.enabled, maxAttempts: flags.verification.maxAttempts };
  const deps: TurnDeps = {
    complete: (target, request, session) => complete(target, request, session, { fetch: fetchFn, db }),
    callTool: async () => {
      throw new Error("no tool call in this turn");
    },
    store: memoryStore(),
    tools,
    clock: () => NOW,
    limits: { ...flags.agentTurnLimits, maxTurns: flags.runLimits.maxTurns },
    request: turnRequest(tools, flags.agentToolSearch, flags.agentPromptCache, verification.enabled),
    verification,
  };
  const outcome = await runTurn({ session: SESSION, turn, text: QUESTION, startedAt: NOW }, deps);
  const sent = fetchFn.mock.calls.map(([url, init]) => ({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) as unknown }));
  return { outcome, sent, summary, tools };
}

const saved = structuredClone(flags);

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The demo-path run's switches, exactly as its app is started.
  expect(applyLocalOverrides(flags, { NODE_ENV: "test", FLAGS_LOCAL_OVERRIDES: LOCAL_SWITCHES }).length).toBeGreaterThan(0);
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the page focus and the recorded demo path", () => {
  it("runs with the focus switch on and the recorded tool set", () => {
    expect(flags.agentFocusEnabled).toBe(true);
    expect(toolsFor("operator", { defer: flags.agentToolSearch })).toHaveLength(27);
    expect(Object.keys(parseFixture(readFileSync(REPLAY_FIXTURE, "utf8")).entries)).toContain(RECORDED_KEY);
  });

  it("sends the recorded request, fingerprint unchanged, with a focus in the summary or without one", async () => {
    const plain = await firstQuestion(null);
    const focused = await firstQuestion(FOCUS);
    for (const run of [plain, focused]) {
      expect(run.outcome.status).toBe("done");
      expect(run.sent).toHaveLength(1);
      expect(run.sent[0].path).toBe(RESPONSES_PATH);
      const parts = fingerprintParts(RESPONSES_PATH, run.sent[0].body);
      expect(parts.user).toBe(QUESTION);
      expect(parts.tools).toHaveLength(27);
      expect(fingerprint(parts)).toBe(RECORDED_KEY);
    }
    // The focus is in the summary the model reads, and only there.
    const line = `settlements ${SETTLEMENT}, settlement for Sam Rivera (AG-1), week ending 2026-10-25, status draft, net $1,234.56`;
    expect(focused.summary.text).toContain(`Subject:\n${line}`);
    expect(focused.summary.cents).toContain(123_456);
    expect(JSON.stringify(focused.sent[0].body)).toContain("settlement for Sam Rivera (AG-1)");
    expect(JSON.stringify(plain.sent[0].body)).not.toContain("settlement for Sam Rivera");
    // Apart from the summary, the two requests are the same request.
    const strip = (body: unknown) => JSON.stringify(body).split(JSON.stringify(focused.summary.text).slice(1, -1)).join("SUMMARY");
    const stripPlain = (body: unknown) => JSON.stringify(body).split(JSON.stringify(plain.summary.text).slice(1, -1)).join("SUMMARY");
    expect(strip(focused.sent[0].body)).toBe(stripPlain(plain.sent[0].body));
  });
});
