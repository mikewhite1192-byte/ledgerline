import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { Param, Queryable, TenantDb } from "../db";
import { decideRoute } from "./http";

// The approve and decline routes' own checks, in order, then the decision. Only a person's click
// reaches these routes; the worker is kicked only after an approval that leaves nothing pending.

const SESSION: Session = { sub: "sub-2", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const RUN = "22222222-2222-4222-8222-222222222222";
const CHECK = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-27T15:00:00Z");

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));

function fakeDb(state: { member?: boolean; checkStatus?: string } = {}) {
  const writes: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string) {
      if (sql.includes("FROM memberships")) return (state.member === false ? [] : [{ ok: 1 }]) as T[];
      if (sql.startsWith("SELECT status, session_id")) return [{ status: "waiting_approval", session_id: "sess-1" }] as T[];
      if (sql.includes("FROM portal_run_checks c")) {
        return [{ status: state.checkStatus ?? "pending", seq: 2, created_at: new Date(NOW.getTime() - 60_000).toISOString() }] as T[];
      }
      if (sql.includes("FROM portal_sessions")) return [{ ok: 1 }] as T[];
      if (sql.includes("count(*)")) return [{ n: 0 }] as T[];
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []) {
      writes.push({ sql, params });
      return 1;
    },
  };
  const db: TenantDb = { withTenant: async (_tenant, fn) => fn(q) };
  return { db, writes };
}

function call(decision: "approve" | "decline", opts: { id?: string; checkId?: string; site?: string; db?: TenantDb; kick?: () => boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.site) headers["Sec-Fetch-Site"] = opts.site;
  const request = new Request(`https://app.example/api/portal-runs/${RUN}/checks/${CHECK}/${decision}`, { method: "POST", headers });
  return decideRoute(request, Promise.resolve({ id: opts.id ?? RUN, checkId: opts.checkId ?? CHECK }), decision, {
    db: opts.db ?? fakeDb().db,
    kick: opts.kick ?? vi.fn(() => true),
    now: NOW,
  });
}

beforeEach(() => {
  flags.portalRunnerEnabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  vi.stubEnv("DB_CLUSTER_ARN", "");
  vi.stubEnv("PORTAL_RUNNER_MODE", "");
  vi.stubEnv("PORTAL_BASE_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  flags.portalRunnerEnabled = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST approve and decline", () => {
  it("is not found with the switch off, before anything else", async () => {
    flags.portalRunnerEnabled = false;
    const response = await call("approve", { site: "cross-site" });
    expect(response.status).toBe(404);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("refuses a cross-site post, a missing session and an id that is not a uuid, in that order", async () => {
    expect((await call("approve", { site: "cross-site" })).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await call("approve")).status).toBe(401);
    expect((await call("approve", { checkId: "nope" })).status).toBe(400);
  });

  it("refuses a person who is not a member of the carrier, writing nothing", async () => {
    const { db, writes } = fakeDb({ member: false });
    const response = await call("approve", { db });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(writes).toEqual([]);
  });

  it("approves and kicks the worker once the step has nothing pending", async () => {
    const kick = vi.fn(() => true);
    const response = await call("approve", { kick });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "approved", resumed: true });
    expect(kick).toHaveBeenCalledWith({ tenantId: SESSION.tenantId, runId: RUN });
  });

  it("answers a repeat approval with the state, writing nothing and kicking nothing", async () => {
    const { db, writes } = fakeDb({ checkStatus: "approved" });
    const kick = vi.fn(() => true);
    const response = await call("approve", { db, kick });
    expect(await response.json()).toEqual({ status: "unchanged", runStatus: "waiting_approval", checkStatus: "approved" });
    expect(writes).toEqual([]);
    expect(kick).not.toHaveBeenCalled();
  });

  it("refuses an approval where no runner can resume the run, but still takes a decline", async () => {
    vi.stubEnv("DB_CLUSTER_ARN", "arn:aws:rds:us-east-2:000000000000:cluster:x");
    const approve = await call("approve");
    expect(approve.status).toBe(409);
    expect(await approve.json()).toEqual({ started: false, reason: "disabled" });
    const decline = await call("decline");
    expect(await decline.json()).toEqual({ status: "declined" });
  });

  it("answers a database failure with a category only", async () => {
    const db: TenantDb = {
      withTenant: async () => {
        throw Object.assign(new Error("connection refused at 10.0.0.1"), { name: "DbError" });
      },
    };
    const response = await call("approve", { db });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
});
