import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { createRunIn, startPortalRun } from "./start";
import { STALLED_AFTER_MS, UNCLAIMED_AFTER_MS } from "./views";

const mocks = vi.hoisted(() => ({ kick: vi.fn(() => true) }));
vi.mock("./runner/kick", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runner/kick")>()),
  kickPortalRun: mocks.kick,
}));

const SESSION: Session = { sub: "sub-1", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const LOAD = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-27T15:00:00Z");

const EVIDENCE = {
  run_id: "55555555-5555-4555-8555-555555555555",
  delivery_checked_in_at: "2026-10-20T14:05:00.000Z",
  delivery_checked_out_at: "2026-10-20T16:10:00.000Z",
  facility_time_zone: "America/Chicago",
  pod_byte_length: 5_900,
  times_step_seq: 2,
  pod_step_seq: 3,
  screen_verdict: "flagged",
  readback_match: "matches",
  untrusted_input_id: "66666666-6666-4666-8666-666666666666",
  created_at: "2026-10-27T14:00:00.000Z",
};

function fakeQ(state: { portal?: boolean; evidence?: boolean; live?: { id: string; status: string }[]; inserted?: boolean } = {}) {
  const calls: { sql: string; params: Param[] }[] = [];
  let liveReads = 0;
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("FROM portal_loads")) return (state.portal === false ? [] : [{ reference: "FFE-100001" }]) as T[];
      if (sql.includes("FROM portal_evidence")) return (state.evidence ? [EVIDENCE] : []) as T[];
      if (sql.includes("FROM portal_runs")) {
        liveReads += 1;
        const live = state.live ?? [];
        // In a race the first read sees nothing and the second sees the winner.
        return (state.inserted === false && liveReads === 1 ? [] : live) as T[];
      }
      if (sql.startsWith("INSERT INTO portal_runs")) return (state.inserted === false ? [] : [{ id: params[0] }]) as T[];
      throw new Error(`unexpected query ${sql}`);
    },
    async execute(sql: string, params: Param[] = []) {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE portal_runs SET status = 'failed'")) return 0;
      throw new Error(`unexpected statement ${sql}`);
    },
  };
  return { q, calls };
}

beforeEach(() => {
  mocks.kick.mockClear();
  flags.portalRunnerEnabled = true;
  vi.stubEnv("DB_CLUSTER_ARN", "");
  vi.stubEnv("PORTAL_RUNNER_MODE", "");
  vi.stubEnv("PORTAL_BASE_URL", "");
});

const SHIPPED_MODEL = flags.portalRunnerModel;

afterEach(() => {
  flags.portalRunnerEnabled = false;
  flags.portalRunnerModel = SHIPPED_MODEL;
  vi.unstubAllEnvs();
});

const input = (refresh = true) => ({ loadId: LOAD, refresh, turnId: null });

describe("createRunIn", () => {
  it("is disabled with the switch off, or with no runner where the app is deployed, and reads nothing", async () => {
    flags.portalRunnerEnabled = false;
    const off = fakeQ();
    expect(await createRunIn(off.q, SESSION, input(), NOW)).toEqual({ kind: "disabled" });
    expect(off.calls).toEqual([]);

    flags.portalRunnerEnabled = true;
    vi.stubEnv("DB_CLUSTER_ARN", "arn:aws:rds:us-east-2:000000000000:cluster:x");
    const deployed = fakeQ();
    expect(await createRunIn(deployed.q, SESSION, input(), NOW)).toEqual({ kind: "disabled" });
    expect(deployed.calls).toEqual([]);
  });

  it("refuses a load the portal does not carry", async () => {
    expect(await createRunIn(fakeQ({ portal: false }).q, SESSION, input(), NOW)).toEqual({ kind: "no_portal_load" });
    expect(await createRunIn(fakeQ().q, SESSION, { ...input(), loadId: "nope" }, NOW)).toEqual({ kind: "no_portal_load" });
  });

  it("returns finished evidence instead of a new run unless asked to refresh", async () => {
    const out = await createRunIn(fakeQ({ evidence: true }).q, SESSION, input(false), NOW);
    expect(out).toMatchObject({ kind: "done", runId: EVIDENCE.run_id, evidence: { checkedIn: "2026-10-20 09:05 CT", minutesAtDock: 125, pod: "present" } });
    const fresh = await createRunIn(fakeQ({ evidence: true }).q, SESSION, input(true), NOW);
    expect(fresh.kind).toBe("queued");
  });

  it("ends the load's stale live runs as runner errors before looking for a live one", async () => {
    const { q, calls } = fakeQ();
    await createRunIn(q, SESSION, input(), NOW);
    const ending = calls.findIndex((c) => c.sql.startsWith("UPDATE portal_runs SET status = 'failed'"));
    const live = calls.findIndex((c) => c.sql.includes("FROM portal_runs"));
    expect(ending).toBeGreaterThanOrEqual(0);
    expect(ending).toBeLessThan(live);
    const { sql, params } = calls[ending];
    expect(sql).toContain("ended_reason = 'runner_error'");
    expect(sql).toContain("claim_token = NULL");
    expect(sql).toContain("load_id = CAST($1 AS uuid)");
    expect(params).toEqual([
      LOAD,
      NOW.toISOString(),
      new Date(NOW.getTime() - STALLED_AFTER_MS).toISOString(),
      new Date(NOW.getTime() - UNCLAIMED_AFTER_MS).toISOString(),
    ]);
  });

  it("sets the stalled limit past any live worker's wall limit", () => {
    // A worker ends itself at its wall limit plus one last step; twice the wall limit is past it.
    expect(2 * flags.portalRunLimits.maxWallMs).toBeLessThanOrEqual(STALLED_AFTER_MS);
  });

  it("returns the live run instead of a second one", async () => {
    const live = { id: "77777777-7777-4777-8777-777777777777", status: "waiting_approval" };
    const { q, calls } = fakeQ({ live: [live] });
    expect(await createRunIn(q, SESSION, input(), NOW)).toEqual({ kind: "live", runId: live.id, status: "waiting_approval" });
    expect(calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
  });

  it("queues a new run on the model the switch names, and adopts the winner of a race", async () => {
    flags.portalRunnerModel = "wonder";
    const { q, calls } = fakeQ();
    const out = await createRunIn(q, SESSION, input(), NOW);
    expect(out.kind).toBe("queued");
    const insert = calls.find((c) => c.sql.startsWith("INSERT"))!;
    expect(insert.sql).toContain("ON CONFLICT DO NOTHING");
    expect(insert.params.slice(2, 5)).toEqual(["FFE-100001", "sub-1", null]);
    expect(insert.params[6]).toBe("wonder");

    const winner = { id: "88888888-8888-4888-8888-888888888888", status: "queued" };
    expect(await createRunIn(fakeQ({ inserted: false, live: [winner] }).q, SESSION, input(), NOW)).toEqual({ kind: "live", runId: winner.id, status: "queued" });
  });
});

describe("startPortalRun", () => {
  const db = (q: Queryable): TenantDb => ({ withTenant: async (_t, fn) => fn(q) });

  it("starts the worker only for a new run, after its transaction", async () => {
    const kick = vi.fn(() => true);
    const out = await startPortalRun(SESSION, input(), { db: db(fakeQ().q), kick, now: NOW });
    expect(out.kind).toBe("queued");
    expect(kick).toHaveBeenCalledWith({ tenantId: SESSION.tenantId, runId: (out as { runId: string }).runId });

    const again = vi.fn(() => true);
    await startPortalRun(SESSION, input(), { db: db(fakeQ({ live: [{ id: "x", status: "running" }] }).q), kick: again, now: NOW });
    expect(again).not.toHaveBeenCalled();
  });

  it("opens no transaction when disabled", async () => {
    flags.portalRunnerEnabled = false;
    const withTenant = vi.fn();
    expect(await startPortalRun(SESSION, input(), { db: { withTenant }, kick: vi.fn(), now: NOW })).toEqual({ kind: "disabled" });
    expect(withTenant).not.toHaveBeenCalled();
  });
});
