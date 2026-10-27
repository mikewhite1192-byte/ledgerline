import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { Param, Queryable } from "../db";
import { decideCheck } from "./decide";

const SESSION: Session = { sub: "sub-2", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const RUN = "22222222-2222-4222-8222-222222222222";
const CHECK = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-27T15:00:00Z");
const RECENT = new Date(NOW.getTime() - 60_000).toISOString();

function fakeQ(state: {
  run?: { status: string; session_id: string | null } | null;
  check?: { status: string; seq: number; created_at: string } | null;
  alive?: boolean;
  pendingLeft?: number;
}) {
  const writes: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string) {
      if (sql.startsWith("SELECT status, session_id FROM portal_runs")) return (state.run === null ? [] : [state.run ?? { status: "waiting_approval", session_id: "sess-1" }]) as T[];
      if (sql.includes("FROM portal_run_checks c")) return (state.check === null ? [] : [state.check ?? { status: "pending", seq: 3, created_at: RECENT }]) as T[];
      if (sql.includes("FROM portal_sessions")) return (state.alive === false ? [] : [{ ok: 1 }]) as T[];
      if (sql.includes("count(*)")) return [{ n: state.pendingLeft ?? 0 }] as T[];
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []) {
      writes.push({ sql, params });
      return 1;
    },
  };
  return { q, writes };
}

const decide = (q: Queryable, decision: "approve" | "decline" = "approve") =>
  decideCheck(q, SESSION, { runId: RUN, checkId: CHECK, decision }, NOW);

afterEach(() => {
  flags.portalRunLimits = { ...flags.portalRunLimits, approvalWaitMinutes: 30 };
});

describe("decideCheck", () => {
  it("approves the last pending check and queues the run to resume at its step", async () => {
    const { q, writes } = fakeQ({});
    expect(await decide(q)).toEqual({ kind: "approved", resume: true });
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toContain("UPDATE portal_run_checks SET status = $3");
    expect(writes[0].params).toEqual([RUN, CHECK, "approved", "sub-2", NOW.toISOString()]);
    expect(writes[1].sql).toContain("status = 'queued', resume_step = $2");
    expect(writes[1].params).toEqual([RUN, 3]);
  });

  it("approves one check and waits while another on the step is still pending", async () => {
    const { q, writes } = fakeQ({ pendingLeft: 1 });
    expect(await decide(q)).toEqual({ kind: "approved", resume: false });
    expect(writes).toHaveLength(1);
  });

  it("writes nothing on a repeat click or a run that has moved on", async () => {
    for (const state of [
      { check: { status: "approved", seq: 3, created_at: RECENT } },
      { run: { status: "running", session_id: "sess-1" } },
      { run: { status: "declined", session_id: "sess-1" }, check: { status: "declined", seq: 3, created_at: RECENT } },
    ]) {
      const { q, writes } = fakeQ(state);
      const out = await decide(q);
      expect(out.kind).toBe("unchanged");
      expect(writes).toEqual([]);
    }
  });

  it("declines: the check, the rest expired, the run ended declined", async () => {
    const { q, writes } = fakeQ({});
    expect(await decide(q, "decline")).toEqual({ kind: "declined" });
    expect(writes).toHaveLength(3);
    expect(writes[0].params).toEqual([RUN, CHECK, "declined", "sub-2", NOW.toISOString()]);
    expect(writes[1].sql).toContain("SET status = 'expired'");
    expect(writes[1].sql).toContain("status = 'pending'");
    expect(writes[2].params).toEqual([RUN, "declined", "declined", NOW.toISOString()]);
  });

  it("ends the run instead of approving a check older than the wait limit", async () => {
    const old = new Date(NOW.getTime() - 31 * 60_000).toISOString();
    const { q, writes } = fakeQ({ check: { status: "pending", seq: 3, created_at: old } });
    expect(await decide(q)).toEqual({ kind: "expired" });
    expect(writes.some((w) => w.params.includes("approved"))).toBe(false);
    expect(writes.at(-1)!.params).toEqual([RUN, "stopped", "approval_expired", NOW.toISOString()]);
  });

  it("ends the run instead of approving when its portal session has died", async () => {
    const { q, writes } = fakeQ({ alive: false });
    expect(await decide(q)).toEqual({ kind: "session_expired" });
    expect(writes.some((w) => w.params.includes("approved"))).toBe(false);
  });

  it("finds nothing for an id that is not a uuid or not this tenant's", async () => {
    expect(await decideCheck(fakeQ({}).q, SESSION, { runId: "x", checkId: CHECK, decision: "approve" }, NOW)).toEqual({ kind: "not_found" });
    expect(await decide(fakeQ({ run: null }).q)).toEqual({ kind: "not_found" });
    expect(await decide(fakeQ({ check: null }).q)).toEqual({ kind: "not_found" });
  });
});
