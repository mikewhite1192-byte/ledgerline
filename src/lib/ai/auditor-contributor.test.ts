import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { AUDIT_CALL } from "../agent/auditor/policy";
import { runAudit } from "../agent/auditor/run";
import { MAX_RESULT_CHARS } from "../agent/gateway";
import type { AuditState, AuditStore } from "../agent/gateway/store";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { complete } from "./index";
import { NANOCENTS_PER_CENT } from "./prices";
import type { FetchFn } from "./providers/http";
import { CONTRIBUTOR_IDS } from "./targets";
import { QUIET_JOB } from "./test-fixtures";

// Contributor mode never reaches Muse Wonder (design 4.2 tests): the auditor's one call, made
// through the real wrapper with Contributor mode on, still asks for muse-wonder-1.0, and no
// Contributor id is mapped from a Wonder id. Lives beside the wrapper: agent test files may not
// import it (the import-boundary test).

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const TURN = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-28T15:00:00.000Z");

const ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  DB_CLUSTER_ARN: "",
  META_MODEL_SPARK: "muse-spark-1.3",
  META_MODEL_WONDER: "muse-wonder-1.0",
  AI_SPEND_CAP_CENTS: "12000",
  AI_WONDER_CAP_CENTS: "3000",
  META_CONTRIBUTOR_MODE: "true",
  META_API_KEY: "test-key-abcdefghijklmnop",
};

const VERDICT = JSON.stringify({
  verdict: "pass",
  concerns: [],
  checks: ["cause", "sources", "amount", "limit"].map((name) => ({ name, pass: true, note: "holds" })),
});

// The model-call ledger, answered just well enough for one call to reserve and settle. seen gets
// the reservation.
function ledger(seen: { reserved: number } = { reserved: 0 }): TenantDb {
  let reserved = 0;
  const q: Queryable = {
    async query<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("FROM spend_alerts")) return [QUIET_JOB] as T[];
      if (sql.includes("FROM ops.ai_spend")) {
        return [
          {
            spent_nanocents: 0,
            reserved_nanocents: 0,
            calls: 0,
            wonder_spent_nanocents: 0,
            wonder_reserved_nanocents: 0,
          },
        ] as T[];
      }
      if (sql.includes("FROM model_calls")) return [{ reserved_nanocents: reserved, target: "wonder" }] as T[];
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      if (sql.startsWith("INSERT INTO model_calls")) {
        reserved = Number(params[8]);
        seen.reserved = reserved;
      }
      return 1;
    },
  };
  return { withTenant: async (_tenantId, fn) => fn(q) };
}

function store(): AuditStore {
  const state: AuditState = {
    id: PROPOSAL,
    status: "proposed",
    turnId: TURN,
    createdAt: "2026-10-28T14:00:00.000Z",
    verdict: null,
    concerns: [],
    checkedAt: null,
    startedAt: null,
    traceId: null,
    timeZone: "America/New_York",
  };
  return {
    read: async () => ({ ...state }),
    lease: async (_id, now, _ms, trace) => {
      state.startedAt = now.toISOString();
      state.traceId ??= trace;
      return { traceId: state.traceId, attempts: 1 };
    },
    release: async () => {
      state.startedAt = null;
    },
    write: async (_id, v, now) => {
      state.verdict = v.verdict;
      state.concerns = [...v.concerns];
      state.checkedAt = now.toISOString();
      return true;
    },
    checkEngine: async () => true,
  };
}

beforeEach(() => {
  flags.aiEnabled = true;
  flags.auditorEnabled = true;
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  flags.aiEnabled = false;
  flags.auditorEnabled = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the auditor in Contributor mode", () => {
  it("still sends exactly one request, for muse-wonder-1.0, with the audit's caps", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      Response.json({
        id: "resp_audit1",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: VERDICT }] }],
        usage: { input_tokens: 900, output_tokens: 300 },
      }),
    );
    const db = ledger();
    const result = await runAudit(SESSION, PROPOSAL, {
      clock: () => NOW,
      store: store(),
      callTool: async (ctx, call) => ({
        decision: "allowed",
        decisionId: "d-1",
        tool: call.name,
        tier: "read",
        reason: "ok",
        result: { proposal: { id: PROPOSAL, kind: "advance_payout", amountCents: 10_000 }, engine: { ok: true } },
        refs: [],
        latencyMs: 1,
      }),
      complete: (target, request, session) => complete(target, request, session, { fetch: fetchFn, db }),
    });
    expect(result).toMatchObject({ state: "done", verdict: "pass", concerns: [] });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(body.model).toBe("muse-wonder-1.0");
    expect(body.max_output_tokens).toBe(2_400);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "audit_verdict", strict: true });
  });

  it("fits the largest evidence the gateway returns inside the audit call's cost cap", async () => {
    // Every free character 3 bytes long, up to the gateway's result cap.
    const shell = { proposal: { id: PROPOSAL, title: "" }, engine: { ok: true } };
    const pack = {
      ...shell,
      proposal: { ...shell.proposal, title: "\u4e00".repeat(MAX_RESULT_CHARS - JSON.stringify(shell).length) },
    };
    expect(JSON.stringify(pack).length).toBe(MAX_RESULT_CHARS);
    const fetchFn = vi.fn<FetchFn>(async () =>
      Response.json({
        id: "resp_audit2",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: VERDICT }] }],
        usage: { input_tokens: 9_000, output_tokens: 2_000 },
      }),
    );
    const seen = { reserved: 0 };
    const db = ledger(seen);
    const result = await runAudit(SESSION, PROPOSAL, {
      clock: () => NOW,
      store: store(),
      callTool: async (_ctx, call) => ({
        decision: "allowed",
        decisionId: "d-2",
        tool: call.name,
        tier: "read",
        reason: "ok",
        result: pack,
        refs: [],
        latencyMs: 1,
      }),
      complete: (target, request, session) => complete(target, request, session, { fetch: fetchFn, db }),
    });
    // Not refused as too expensive (which would store the budget concern): the call went out.
    expect(result).toMatchObject({ state: "done", verdict: "pass", concerns: [] });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(seen.reserved).toBeGreaterThan(0);
    expect(seen.reserved).toBeLessThanOrEqual(AUDIT_CALL.maxCostCents * NANOCENTS_PER_CENT);
  });

  it("has no Contributor id for any Wonder model", () => {
    expect(Object.keys(CONTRIBUTOR_IDS).some((id) => id.startsWith("muse-wonder"))).toBe(false);
    expect(Object.values(CONTRIBUTOR_IDS).some((id) => id.startsWith("muse-wonder"))).toBe(false);
  });
});
