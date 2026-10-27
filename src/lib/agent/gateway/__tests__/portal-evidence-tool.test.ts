import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../../config/flags";
import type { Session } from "../../../auth/claims";
import type { Queryable } from "../../../db";
import { STALLED_AFTER_MS } from "../../../portal/views";
import { getPortalEvidence } from "../tools/read/get-portal-evidence";

// get_portal_evidence only reads (design 4.1): a model turn can carry untrusted text, so no tool
// call ever starts, queues or kicks a portal run. Only a person starts one, on the Portal runs page.

const mocks = vi.hoisted(() => ({ kick: vi.fn(() => true), createRunIn: vi.fn(), startPortalRun: vi.fn() }));
vi.mock("../../../portal/runner/kick", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../portal/runner/kick")>()),
  kickPortalRun: mocks.kick,
}));
vi.mock("../../../portal/start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../portal/start")>()),
  createRunIn: mocks.createRunIn,
  startPortalRun: mocks.startPortalRun,
}));

const SESSION: Session = { sub: "sub-1", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const LOAD = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-27T15:00:00Z");
const START_ON = "Portal runs page (/portal-runs)";
const ctx = { session: SESSION, turnId: "t-1", now: NOW } as Parameters<typeof getPortalEvidence.run>[1];
const EXTRAS = { screen: null, limit: null };

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

type RunRow = { id: string; status: string; ended_reason: string | null; claimed_at: string | null; queued_at: string };
const RUN = "77777777-7777-4777-8777-777777777777";
const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: RUN,
  status: "running",
  ended_reason: null,
  claimed_at: "2026-10-27T14:59:00.000Z",
  queued_at: "2026-10-27T14:58:59.000Z",
  ...over,
});

// Answers the tool's reads; any statement, or any SQL that writes, fails the test.
function fakeQ(state: { portal?: boolean; run?: RunRow; evidence?: boolean } = {}) {
  const calls: string[] = [];
  const q: Queryable = {
    async query<T>(sql: string) {
      calls.push(sql);
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) throw new Error("a read tool wrote");
      if (sql.includes("FROM portal_loads")) return (state.portal === false ? [] : [{ reference: "FFE-100001" }]) as T[];
      if (sql.includes("FROM portal_runs")) return (state.run ? [state.run] : []) as T[];
      if (sql.includes("FROM portal_evidence")) return (state.evidence ? [EVIDENCE] : []) as T[];
      throw new Error(`unexpected query ${sql}`);
    },
    async execute(sql: string) {
      throw new Error(`a read tool ran a statement: ${sql}`);
    },
  };
  return { q, calls };
}

const call = (q: Queryable) => getPortalEvidence.run(q, ctx, { loadId: LOAD }, EXTRAS);

beforeEach(() => {
  mocks.kick.mockClear();
  mocks.createRunIn.mockClear();
  mocks.startPortalRun.mockClear();
  flags.portalRunnerEnabled = true;
});

afterEach(() => {
  flags.portalRunnerEnabled = false;
  // Whatever the case, nothing started, queued or kicked a run.
  expect(mocks.kick).not.toHaveBeenCalled();
  expect(mocks.createRunIn).not.toHaveBeenCalled();
  expect(mocks.startPortalRun).not.toHaveBeenCalled();
});

describe("get_portal_evidence", () => {
  it("is a read tool for the operator, whose args cannot ask for a fresh run", () => {
    expect(getPortalEvidence.tier).toBe("read");
    expect(getPortalEvidence.roles).toEqual(["operator"]);
    expect(getPortalEvidence.args.safeParse({ loadId: LOAD, refresh: true }).success).toBe(false);
  });

  it("answers disabled with the switch off, and reads nothing", async () => {
    flags.portalRunnerEnabled = false;
    const { q, calls } = fakeQ();
    expect(await call(q)).toEqual({ result: { status: "disabled" } });
    expect(calls).toEqual([]);
  });

  it("names a load the portal does not carry", async () => {
    expect(await call(fakeQ({ portal: false }).q)).toEqual({ result: { status: "not_on_portal" } });
  });

  it("says no run exists and where a person starts one, and starts nothing", async () => {
    expect(await call(fakeQ().q)).toEqual({ result: { status: "no_run", startOn: START_ON } });
  });

  it("reports a run still going without pointing at a second one", async () => {
    for (const status of ["queued", "running", "waiting_approval"]) {
      expect(await call(fakeQ({ run: run({ status }) }).q)).toEqual({ result: { status, runId: RUN, evidence: null } });
    }
  });

  it("marks a run with no worker left as stalled, and points at where a person starts a fresh one", async () => {
    const old = new Date(NOW.getTime() - STALLED_AFTER_MS - 1_000).toISOString();
    expect(await call(fakeQ({ run: run({ claimed_at: old }) }).q)).toEqual({
      result: { status: "running", runId: RUN, stalled: true, evidence: null, startOn: START_ON },
    });
  });

  it("returns the newest evidence, code-computed facts only, with the newest run's end", async () => {
    const out = await call(fakeQ({ run: run({ status: "failed", ended_reason: "wall_time" }), evidence: true }).q);
    expect(out).toEqual({
      result: {
        status: "failed",
        runId: RUN,
        endedReason: "wall_time",
        evidence: {
          runId: EVIDENCE.run_id,
          deliveryCheckedIn: "2026-10-20 09:05 CT",
          deliveryCheckedOut: "2026-10-20 11:10 CT",
          timeZone: "CT",
          minutesAtDock: 125,
          pod: "present",
          readback: "matches",
          screening: "flagged",
          flaggedInputId: EVIDENCE.untrusted_input_id,
        },
        startOn: START_ON,
      },
    });
  });
});
