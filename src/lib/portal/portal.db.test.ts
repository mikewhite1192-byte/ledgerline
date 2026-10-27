import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { ComputerRequest, ComputerResult, ComputerScreenshot, SafetyCheck } from "../ai";
import { PNG_BYTES } from "../ai/test-fixtures";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable } from "../db/types";
import type { PortalPlan } from "../seed/portal";
import { clearTenantPortal, seedTenantPortal } from "../seed/portal-db";
import { decideCheck } from "./decide";
import { findPortalLoads, portalLoadByReference, portalPod } from "./read";
import type { CapturedPod, PortalCredentials, PortalDriver } from "./runner/driver";
import { runPortalRun, type RunDeps, type StepFn } from "./runner/run";
import { dbRunStore, LostClaimError } from "./runner/store";
import { cookieValue, mintSession, SIGN_IN_FAILURE_LIMIT, signIn } from "./session";
import { iso } from "./sql";
import { createRunIn } from "./start";
import { withPortalTenant } from "./tenant";
import { evidencePod, latestEvidence, listRuns, runView, STALLED_AFTER_MS, stepScreenshot, UNCLAIMED_AFTER_MS } from "./views";

// The portal tables against a real database: the runner start to finish through the real store,
// paused on a safety check and resumed after a person approved it; the live-run index and the
// claim under a race; the largest screenshot and POD through the same base64 path the Data API
// uses; the tenant walls and the app login's grants; and the seed's clear and re-seed.

const PORTAL_TABLES = [
  "portal_accounts",
  "portal_loads",
  "portal_sessions",
  "portal_runs",
  "portal_run_steps",
  "portal_run_checks",
  "portal_evidence",
] as const;

const A = randomUUID();
const B = randomUUID();
const SUB_A = `portal-member-${A.slice(0, 8)}`;
const ORIGIN = "http://localhost:3000";
const REF_TIMES = "FFE-100001";
const REF_PENDING = "FFE-100002";
const DETAIL = `${ORIGIN}/portal/loads/${REF_TIMES}`;
const T0 = Date.parse("2026-10-27T15:00:00Z");

// One carrier number per tenant; the column is unique across tenants.
const carrierOf = (id: string) => `MC-${String(100000 + (parseInt(id.slice(0, 5), 16) % 899999)).padStart(6, "0")}`;
const CARRIER_A = carrierOf(A);
const CARRIER_B = carrierOf(B) === CARRIER_A ? "MC-999998" : carrierOf(B);

type TenantSetup = { customerId: string; timesLoad: string; pendingLoad: string; loadNumbers: [string, string] };
const setup: Record<string, TenantSetup> = {
  [A]: { customerId: randomUUID(), timesLoad: randomUUID(), pendingLoad: randomUUID(), loadNumbers: ["PA-1001", "PA-1002"] },
  [B]: { customerId: randomUUID(), timesLoad: randomUUID(), pendingLoad: randomUUID(), loadNumbers: ["PB-1001", "PB-1002"] },
};

// The largest screenshot a step may store, and the largest POD a run may keep.
const BIG_SHOT: ComputerScreenshot = { mime: "image/png", bytes: padded(PNG_BYTES, 400_000) };
const BIG_POD = padded(new Uint8Array(Buffer.from("%PDF-1.4 synthetic\n")), 300_000);

function padded(head: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(head);
  for (let i = head.length; i < size; i++) out[i] = (i * 31) % 251;
  return out;
}

function planFor(tenantId: string, carrierNumber: string): PortalPlan {
  const s = setup[tenantId];
  return {
    carrierNumber,
    carrierName: "Test Carrier Lines",
    loads: [
      {
        id: randomUUID(),
        loadId: s.timesLoad,
        loadNumber: s.loadNumbers[0],
        reference: REF_TIMES,
        shipperName: "Sample Shipper Co",
        consigneeName: "Sample Receiver Inc",
        consigneeCity: "Joliet",
        consigneeState: "IL",
        scheduledFrom: "2026-10-20T13:00:00.000Z",
        scheduledTo: "2026-10-20T15:00:00.000Z",
        // 09:05 to 11:10 Central on Oct 20 (CDT, UTC-5).
        checkedIn: "2026-10-20T14:05:00.000Z",
        checkedOut: "2026-10-20T16:10:00.000Z",
        facilityTimeZone: "America/Chicago",
        podStatus: "available",
        podSignedBy: "Dana Reyes",
        podSignedAt: "2026-10-20T16:12:00.000Z",
        notes: null,
        seedKey: null,
      },
      {
        id: randomUUID(),
        loadId: s.pendingLoad,
        loadNumber: s.loadNumbers[1],
        reference: REF_PENDING,
        shipperName: "Sample Shipper Co",
        consigneeName: "Sample Receiver Inc",
        consigneeCity: "Dayton",
        consigneeState: "OH",
        scheduledFrom: "2026-10-21T13:00:00.000Z",
        scheduledTo: "2026-10-21T15:00:00.000Z",
        checkedIn: null,
        checkedOut: null,
        facilityTimeZone: "America/New_York",
        podStatus: "pending",
        podSignedBy: null,
        podSignedAt: null,
        notes: null,
        seedKey: null,
      },
    ],
  };
}

let admin: Db;
let app: Db;

async function sqlStateOf(work: Promise<unknown>): Promise<string | undefined> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return (err as { sqlState?: string }).sqlState;
}

async function createTenant(id: string, prefix: string): Promise<void> {
  const s = setup[id];
  await admin.withTenant(id, async (q) => {
    await q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
      `${prefix}-${id.slice(0, 8)}`,
      "Portal Test Carrier",
      "America/Chicago",
    ]);
    await q.execute(
      "INSERT INTO customers (id, tenant_id, code, name, terms_days, city, state)" +
        " VALUES (CAST($1 AS uuid), current_tenant_id(), 'PT-1', 'Sample Shipper Co', 30, 'Joliet', 'IL')",
      [s.customerId],
    );
    for (const [i, loadId] of [s.timesLoad, s.pendingLoad].entries()) {
      await q.execute(
        "INSERT INTO loads (id, tenant_id, load_number, customer_id, status, origin_city, origin_state, dest_city," +
          " dest_state, pickup_on, loaded_miles) VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid)," +
          " 'planned', 'Gary', 'IN', 'Joliet', 'IL', CAST('2026-10-20' AS date), 120)",
        [loadId, s.loadNumbers[i], s.customerId],
      );
    }
  });
}

// A browser that runs nothing real: every screenshot is the largest allowed, and the click on
// the detail page captures the POD the portal serves. Signing in hands what the driver would type
// to the test, which signs in for real and says whether the portal let it in.
function fakeDriver(pod: Uint8Array, portalSignIn: (typed: PortalCredentials) => Promise<boolean> = async () => false) {
  const state = {
    url: "about:blank",
    pod: null as CapturedPod | null,
    ran: 0,
    opened: [] as string[],
    signIns: [] as { url: string; typed: PortalCredentials }[],
  };
  const driver: PortalDriver = {
    async open(url) {
      state.opened.push(url);
      state.url = url;
    },
    async signIn(url, typed) {
      state.signIns.push({ url, typed });
      state.url = (await portalSignIn(typed)) ? `${ORIGIN}/portal/loads` : `${url}&e=1`;
    },
    async run(action) {
      state.ran += 1;
      if (action.type === "click") {
        state.url = DETAIL;
        state.pod = { bytes: pod, url: `${DETAIL}/pod` };
      }
    },
    async settle() {},
    async screenshot() {
      return BIG_SHOT;
    },
    url: () => state.url,
    pod: () => state.pod,
    async close() {},
  };
  return { driver, state };
}

const CHECK: SafetyCheck = { id: "sc_portal_1", code: "malicious_instructions", message: "The page asks for something unusual." };

function callResult(n: number, actions: Record<string, unknown>[], checks: SafetyCheck[] = []): ComputerResult {
  const callId = `call_${n}`;
  const raw = { type: "computer_call", call_id: callId, actions, pending_safety_checks: checks, status: "completed" };
  return {
    callId: randomUUID(),
    status: "ok",
    text: "",
    toolCalls: [],
    usage: { input: 10, cached: 0, output: 10, reasoning: 0 },
    costNanocents: 2_000_000_000,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
    call: { callId, actions, pendingSafetyChecks: checks, checks, status: "completed", raw },
  };
}

function answerResult(text: string): ComputerResult {
  return { ...callResult(0, []), call: null, text };
}

function scripted(results: ComputerResult[]) {
  const requests: ComputerRequest[] = [];
  const step = vi.fn<StepFn>(async (_target, request) => {
    requests.push(request);
    const next = results.shift();
    if (!next) throw new Error("script ran out");
    return next;
  });
  return { step, requests };
}

let clock = T0;
const tick = () => new Date((clock += 1_000));

function deps(driver: PortalDriver, step: StepFn): RunDeps {
  return {
    store: dbRunStore(A, app),
    openDriver: async () => driver,
    step,
    screen: async () => "clean",
    now: tick,
    sleep: async () => undefined,
    origin: ORIGIN,
    recordDir: null,
  };
}

const memberA: Session = { sub: SUB_A, email: "member@example.test", tenantId: A };
const asApp = <T>(tenantId: string, fn: (q: Queryable) => Promise<T>) => app.withTenant(tenantId, fn);

describe("the portal tables", () => {
  const LIMITS = { ...flags.portalRunLimits };
  let flowRunId = "";
  let sessionA = "";

  beforeAll(async () => {
    vi.stubEnv("DB_CLUSTER_ARN", "");
    vi.stubEnv("PORTAL_RUNNER_MODE", "");
    vi.stubEnv("PORTAL_BASE_URL", "");
    flags.portalRunnerEnabled = true;
    flags.portalRunLimits = { ...LIMITS };
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await createTenant(A, "portal-a");
    await createTenant(B, "portal-b");
    await admin.withTenant(A, (q) =>
      q.execute(
        "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')",
        [SUB_A, memberA.email],
      ),
    );
    expect(await seedTenantPortal(admin, A, planFor(A, CARRIER_A))).toBe(2);
    expect(await seedTenantPortal(admin, B, planFor(B, CARRIER_B))).toBe(2);
  });

  afterAll(async () => {
    flags.portalRunnerEnabled = false;
    flags.portalRunLimits = { ...LIMITS };
    vi.unstubAllEnvs();
    // Only what this file made: the two tenants, and every row under them by cascade, after the
    // portal rows that point at each other are let go.
    for (const id of [A, B]) {
      await clearTenantPortal(admin, id);
      await admin.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("reads each tenant's own portal rows, and a session from one tenant opens nothing in another", async () => {
    const lines = await asApp(B, (q) => findPortalLoads(q, REF_TIMES));
    expect(lines).toEqual([
      { reference: REF_TIMES, loadNumber: "PB-1001", consignee: "Sample Receiver Inc", destination: "Joliet, IL", podStatus: "available" },
    ]);
    const detailA = await asApp(A, (q) => portalLoadByReference(q, REF_TIMES));
    expect(detailA?.loadNumber).toBe("PA-1001");
    expect(await asApp(A, (q) => portalPod(q, REF_PENDING))).toBeNull();
    const podA = await asApp(A, (q) => portalPod(q, REF_TIMES));
    expect(podA && Buffer.from(podA.slice(0, 5)).toString()).toBe("%PDF-");
  });

  it("runs, pauses on a safety check, resumes once a member approves it, and stores matching evidence", async () => {
    const podA = (await asApp(A, (q) => portalPod(q, REF_TIMES)))!;
    const started = await asApp(A, (q) =>
      createRunIn(q, memberA, { loadId: setup[A].timesLoad, refresh: false, turnId: null }, tick()),
    );
    expect(started.kind).toBe("queued");
    flowRunId = (started as { runId: string }).runId;

    // First pass: the driver signs in with the code the runner minted for this run, which works
    // only in its own tenant; then a search, then a call with a safety check pauses before acting.
    const first = scripted([
      callResult(1, [{ type: "type", text: REF_TIMES }, { type: "keypress", keys: ["Enter"] }]),
      callResult(2, [{ type: "click", x: 100, y: 200, button: "left" }], [CHECK]),
    ]);
    const d1 = fakeDriver(podA, async (typed) => {
      expect(await asApp(B, (q) => signIn(q, { ...typed, now: tick() }))).toBeNull();
      sessionA = (await asApp(A, (q) => signIn(q, { ...typed, now: tick() }))) ?? "";
      return sessionA !== "";
    });
    expect(await runPortalRun({ tenantId: A, runId: flowRunId }, deps(d1.driver, first.step))).toEqual({ kind: "paused" });
    expect(d1.state.ran).toBe(2);
    expect(d1.state.opened).toEqual([]);
    expect(d1.state.signIns.map((s) => [s.url, s.typed.carrierNumber])).toEqual([[`${ORIGIN}/portal?t=${A}`, CARRIER_A]]);
    expect(sessionA).toMatch(/^[0-9a-f-]{36}$/);
    const code = d1.state.signIns[0].typed.code;
    // Single use.
    expect(await asApp(A, (q) => signIn(q, { carrierNumber: CARRIER_A, code, now: tick() }))).toBeNull();
    // The code reached no model request and no stored step.
    for (const r of first.requests) {
      expect(JSON.stringify({ task: r.task, instructions: r.instructions, history: r.history.map((h) => h.call) })).not.toContain(
        code,
      );
    }
    const storedSteps = await asApp(A, (q) =>
      q.query<{ call_item: string | null; action_summary: string; url_after: string | null }>(
        "SELECT CAST(call_item AS text) AS call_item, CAST(action_summary AS text) AS action_summary, url_after" +
          " FROM portal_run_steps WHERE run_id = CAST($1 AS uuid)",
        [flowRunId],
      ),
    );
    // The opening screen, the search, and the paused click.
    expect(storedSteps).toHaveLength(3);
    expect(JSON.stringify(storedSteps)).not.toContain(code);

    const paused = await asApp(A, (q) =>
      q.query<{ status: string; claim_token: string | null; step_count: number }>(
        "SELECT status, claim_token, step_count FROM portal_runs WHERE id = CAST($1 AS uuid)",
        [flowRunId],
      ),
    );
    expect(paused).toEqual([{ status: "waiting_approval", claim_token: null, step_count: 2 }]);
    const checks = await asApp(A, (q) =>
      q.query<{ id: string; check_id: string; status: string; created_at: Date }>(
        "SELECT id, check_id, status, created_at FROM portal_run_checks WHERE run_id = CAST($1 AS uuid)",
        [flowRunId],
      ),
    );
    expect(checks.map((c) => [c.check_id, c.status])).toEqual([[CHECK.id, "pending"]]);
    // Stamped by the runner's clock, so the approval wait never depends on the database's.
    expect(new Date(checks[0].created_at).getTime()).toBeGreaterThan(T0);

    expect(
      await asApp(A, (q) => decideCheck(q, memberA, { runId: flowRunId, checkId: checks[0].id, decision: "approve" }, tick())),
    ).toEqual({ kind: "approved", resume: true });

    // Second pass: the approved click runs, and the answer comes back with the approval on it.
    const answer = {
      found: true,
      reference: REF_TIMES,
      deliveryCheckedIn: "2026-10-20 09:05",
      deliveryCheckedOut: "2026-10-20 11:10",
      timeZoneLabel: "CT",
      podDownloaded: true,
      podSignedBy: "Dana Reyes",
      notes: "",
    };
    const second = scripted([answerResult(JSON.stringify(answer))]);
    const d2 = fakeDriver(podA);
    expect(await runPortalRun({ tenantId: A, runId: flowRunId }, deps(d2.driver, second.step))).toEqual({
      kind: "ended",
      status: "done",
      reason: "ok",
    });
    expect(d2.state.ran).toBe(1);
    const resumed = second.requests[0];
    expect(resumed.history).toHaveLength(2);
    expect(resumed.history[0].output.acknowledged).toEqual([]);
    expect(resumed.history[1].output.acknowledged).toEqual([CHECK]);
    // Every screenshot came back from the table byte for byte, at the largest size allowed.
    expect(Buffer.from(resumed.screenshot.bytes).equals(Buffer.from(BIG_SHOT.bytes))).toBe(true);
    expect(Buffer.from(resumed.history[0].output.screenshot.bytes).equals(Buffer.from(BIG_SHOT.bytes))).toBe(true);

    const evidence = await asApp(A, (q) => latestEvidence(q, setup[A].timesLoad));
    expect(evidence).toMatchObject({
      runId: flowRunId,
      checkedInAt: "2026-10-20T14:05:00.000Z",
      checkedOutAt: "2026-10-20T16:10:00.000Z",
      zoneLabel: "CT",
      minutesAtDock: 125,
      pod: "present",
      podBytes: podA.length,
      screenVerdict: "clean",
      readback: "matches",
    });
    const kept = await asApp(A, (q) => evidencePod(q, flowRunId));
    expect(kept && Buffer.from(kept).equals(Buffer.from(podA))).toBe(true);
    const stored = await asApp(A, (q) =>
      q.query<{ kind: string; source: string }>(
        "SELECT kind, source FROM untrusted_inputs WHERE id = CAST($1 AS uuid)",
        [evidence!.untrustedInputId],
      ),
    );
    expect(stored).toEqual([{ kind: "portal", source: "portal_run" }]);

    const view = await asApp(A, (q) => runView(q, flowRunId, tick()));
    expect(view?.run.status).toBe("done");
    expect(view?.steps.map((s) => [s.seq, s.kind, s.executed])).toEqual([
      [0, "opening", true],
      [1, "action", true],
      [2, "action", true],
      [3, "answer", false],
    ]);
    expect(view?.checks.map((c) => c.status)).toEqual(["approved"]);
    expect((await asApp(A, (q) => listRuns(q, tick()))).map((r) => r.id)).toEqual([flowRunId]);

    // Done means the same ask again reuses the evidence.
    const again = await asApp(A, (q) =>
      createRunIn(q, memberA, { loadId: setup[A].timesLoad, refresh: false, turnId: null }, tick()),
    );
    expect(again).toMatchObject({ kind: "done", runId: flowRunId });
  });

  it("keeps a POD captured before a pause through the resume, stores it once, and holds none once done", async () => {
    const podA = (await asApp(A, (q) => portalPod(q, REF_TIMES)))!;
    const podHash = createHash("sha256").update(podA).digest("hex");
    const started = await asApp(A, (q) =>
      createRunIn(q, memberA, { loadId: setup[A].timesLoad, refresh: true, turnId: null }, tick()),
    );
    expect(started.kind).toBe("queued");
    const runId = (started as { runId: string }).runId;
    const held = () =>
      asApp(A, (q) =>
        q.query<{ status: string; data: string | null; step_seq: number | null; paused_hash: string | null }>(
          "SELECT status, encode(held_pod_pdf, 'base64') AS data, held_pod_step_seq AS step_seq," +
            " paused_pod_hash AS paused_hash FROM portal_runs WHERE id = CAST($1 AS uuid)",
          [runId],
        ),
      ).then((r) => r[0]);

    // First pass: the click on the detail page downloads the POD, then a call pauses on a check.
    const first = scripted([
      callResult(11, [{ type: "click", x: 100, y: 200, button: "left" }]),
      callResult(12, [{ type: "wait" }], [{ ...CHECK, id: "sc_portal_2" }]),
    ]);
    const d1 = fakeDriver(podA, async (typed) => (await asApp(A, (q) => signIn(q, { ...typed, now: tick() }))) !== null);
    expect(await runPortalRun({ tenantId: A, runId }, deps(d1.driver, first.step))).toEqual({ kind: "paused" });
    const atPause = await held();
    expect(atPause).toMatchObject({ status: "waiting_approval", step_seq: 1, paused_hash: podHash });
    expect(atPause.data !== null && Buffer.from(atPause.data, "base64").equals(Buffer.from(podA))).toBe(true);

    const checks = await asApp(A, (q) =>
      q.query<{ id: string }>("SELECT id FROM portal_run_checks WHERE run_id = CAST($1 AS uuid)", [runId]),
    );
    expect(
      await asApp(A, (q) => decideCheck(q, memberA, { runId, checkId: checks[0].id, decision: "approve" }, tick())),
    ).toEqual({ kind: "approved", resume: true });

    // Second pass: the approved wait downloads nothing, and the answer comes back.
    const answer = {
      found: true,
      reference: REF_TIMES,
      deliveryCheckedIn: "2026-10-20 09:05",
      deliveryCheckedOut: "2026-10-20 11:10",
      timeZoneLabel: "CT",
      podDownloaded: true,
      podSignedBy: "Dana Reyes",
      notes: "",
    };
    const d2 = fakeDriver(podA);
    expect(await runPortalRun({ tenantId: A, runId }, deps(d2.driver, scripted([answerResult(JSON.stringify(answer))]).step))).toEqual({
      kind: "ended",
      status: "done",
      reason: "ok",
    });
    expect(d2.state.pod).toBeNull();
    const rows = await asApp(A, (q) =>
      q.query<{ pod_content_hash: string; pod_step_seq: number; readback_match: string }>(
        "SELECT pod_content_hash, pod_step_seq, readback_match FROM portal_evidence WHERE run_id = CAST($1 AS uuid)",
        [runId],
      ),
    );
    expect(rows).toEqual([{ pod_content_hash: podHash, pod_step_seq: 1, readback_match: "matches" }]);
    const kept = await asApp(A, (q) => evidencePod(q, runId));
    expect(kept && Buffer.from(kept).equals(Buffer.from(podA))).toBe(true);
    // The run ended, so the evidence row is the one copy.
    expect(await held()).toEqual({ status: "done", data: null, step_seq: null, paused_hash: null });
  });

  it("makes one live run per load when two asks race, and lets only one worker claim it", async () => {
    const ask = () =>
      asApp(A, (q) => createRunIn(q, memberA, { loadId: setup[A].pendingLoad, refresh: false, turnId: null }, tick()));
    const both = await Promise.all([ask(), ask()]);
    expect(both.map((o) => o.kind).sort()).toEqual(["live", "queued"]);
    const runId = (both[0] as { runId: string }).runId;
    expect((both[1] as { runId: string }).runId).toBe(runId);

    // The index itself refuses a second live run, whoever writes it.
    expect(
      await sqlStateOf(
        asApp(A, (q) =>
          q.execute(
            "INSERT INTO portal_runs (id, tenant_id, load_id, reference, requested_by, trace_id, model, status)" +
              " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, 'wonder', 'queued')",
            [randomUUID(), setup[A].pendingLoad, REF_PENDING, SUB_A, randomUUID()],
          ),
        ),
      ),
    ).toBe("23505");

    const store = dbRunStore(A, app);
    const tokens = [randomUUID(), randomUUID()];
    const claims = await Promise.all(tokens.map((t) => store.claim(runId, t, tick())));
    expect(claims.map((c) => c.kind).sort()).toEqual(["claimed", "not_queued"]);
    const token = tokens[claims.findIndex((c) => c.kind === "claimed")];
    expect(await store.claim(randomUUID(), randomUUID(), tick())).toEqual({ kind: "missing" });

    // The largest screenshot and POD go in through decode and come back through encode, whole;
    // one byte more is refused by the table.
    const tooBigShot: ComputerScreenshot = { mime: "image/png", bytes: padded(PNG_BYTES, 400_001) };
    const step = {
      seq: 0,
      modelCallId: null,
      call: null,
      summary: [],
      executed: true,
      stoppedEarly: false,
      urlAfter: `${ORIGIN}/portal`,
      costNanocents: 0,
      pendingCheckCount: 0,
    };
    expect(await sqlStateOf(store.insertStep(runId, token, { ...step, screenshot: tooBigShot }))).toBe("23514");
    await store.insertStep(runId, token, { ...step, screenshot: BIG_SHOT });
    const shot = await asApp(A, (q) => stepScreenshot(q, runId, 0));
    expect(shot?.mime).toBe("image/png");
    expect(shot && Buffer.from(shot.bytes).equals(Buffer.from(BIG_SHOT.bytes))).toBe(true);

    const inputId = await store.storeAnswer('{"found":false}', tick());
    const evidence = (pod: Uint8Array) => ({
      checkedIn: null,
      checkedOut: null,
      zone: null,
      timesStepSeq: null,
      pod: { bytes: pod, hash: "a".repeat(64), stepSeq: 0 },
      answer: { found: false },
      untrustedInputId: inputId,
      screenVerdict: "clean" as const,
      readback: "differs" as const,
    });
    const progress = { costNanocents: 0, modelCallCount: 0, stepCount: 1, lastUrl: null };
    const ending = { status: "done" as const, reason: "ok" };
    const tooBigPod = padded(BIG_POD.slice(0, 20), 300_001);
    expect(
      await sqlStateOf(store.finishWithEvidence(runId, token, setup[A].pendingLoad, evidence(tooBigPod), ending, progress, tick())),
    ).toBe("23514");
    await store.finishWithEvidence(runId, token, setup[A].pendingLoad, evidence(BIG_POD), ending, progress, tick());
    const pod = await asApp(A, (q) => evidencePod(q, runId));
    expect(pod && Buffer.from(pod).equals(Buffer.from(BIG_POD))).toBe(true);
    // A finished run gives up its claim token.
    await expect(store.progress(runId, token, progress)).rejects.toThrow();
  });

  it("holds the largest POD a run may keep, lets it go when a person declines, and never on an ended run", async () => {
    const runId = randomUUID();
    await asApp(A, (q) =>
      q.execute(
        "INSERT INTO portal_runs (id, tenant_id, load_id, reference, requested_by, trace_id, model, status)" +
          " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, 'spark', 'queued')",
        [runId, setup[A].pendingLoad, REF_PENDING, SUB_A, randomUUID()],
      ),
    );
    const store = dbRunStore(A, app);
    const token = randomUUID();
    expect(await store.claim(runId, token, tick())).toMatchObject({ kind: "claimed" });

    // Through decode and back through encode, whole; one byte more is refused by the table.
    expect(await sqlStateOf(store.holdPod(runId, token, { bytes: padded(BIG_POD.slice(0, 20), 300_001), stepSeq: 1 }))).toBe(
      "23514",
    );
    await store.holdPod(runId, token, { bytes: BIG_POD, stepSeq: 1 });
    const before = await store.heldPod(runId, token);
    expect(before.pausedHash).toBeNull();
    expect(before.held?.stepSeq).toBe(1);
    expect(before.held && Buffer.from(before.held.bytes).equals(Buffer.from(BIG_POD))).toBe(true);
    await expect(store.heldPod(runId, randomUUID())).rejects.toBeInstanceOf(LostClaimError);

    const hash = createHash("sha256").update(BIG_POD).digest("hex");
    const stepId = await store.insertStep(runId, token, {
      seq: 0,
      modelCallId: null,
      call: null,
      summary: [],
      executed: false,
      stoppedEarly: false,
      screenshot: null,
      urlAfter: null,
      costNanocents: 0,
      pendingCheckCount: 1,
    });
    const progress = { costNanocents: 0, modelCallCount: 1, stepCount: 1, lastUrl: null };
    await store.pause(runId, token, stepId, [{ ...CHECK, id: "sc_hold" }], progress, hash, tick());
    const row = () =>
      asApp(A, (q) =>
        q.query<{ status: string; bytes: number | null; step_seq: number | null; paused_hash: string | null }>(
          "SELECT status, octet_length(held_pod_pdf) AS bytes, held_pod_step_seq AS step_seq, paused_pod_hash AS paused_hash" +
            " FROM portal_runs WHERE id = CAST($1 AS uuid)",
          [runId],
        ),
      ).then((r) => r[0]);
    expect(await row()).toEqual({ status: "waiting_approval", bytes: BIG_POD.length, step_seq: 1, paused_hash: hash });

    const check = await asApp(A, (q) =>
      q.query<{ id: string }>("SELECT id FROM portal_run_checks WHERE run_id = CAST($1 AS uuid)", [runId]),
    );
    expect(await asApp(A, (q) => decideCheck(q, memberA, { runId, checkId: check[0].id, decision: "decline" }, tick()))).toEqual({
      kind: "declined",
    });
    expect(await row()).toEqual({ status: "declined", bytes: null, step_seq: null, paused_hash: null });
    // The table itself refuses a POD held on a run that has ended.
    expect(
      await sqlStateOf(
        asApp(A, (q) => q.execute("UPDATE portal_runs SET paused_pod_hash = $2 WHERE id = CAST($1 AS uuid)", [runId, hash])),
      ),
    ).toBe("23514");
  });

  it("claims a run only for a member of the run's own tenant, even on a login that skips row security", async () => {
    // A run in tenant B asked for by someone who is a member only in tenant A.
    const runId = randomUUID();
    await admin.withTenant(B, (q) =>
      q.execute(
        "INSERT INTO portal_runs (id, tenant_id, load_id, reference, requested_by, trace_id, model, status)" +
          " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, 'spark', 'queued')",
        [runId, setup[B].pendingLoad, REF_PENDING, SUB_A, randomUUID()],
      ),
    );
    const claimed = await dbRunStore(B, admin).claim(runId, randomUUID(), tick());
    expect(claimed).toMatchObject({ kind: "claimed", member: false });
  });

  it("ends a run no worker claimed or a worker lost as a runner error, so the load is never held", async () => {
    const asker: Session = { sub: SUB_A, email: memberA.email, tenantId: B };
    const load = setup[B].timesLoad;
    const t0 = tick().getTime();
    const at = (ms: number) => new Date(t0 + ms);
    const ask = (now: Date) => asApp(B, (q) => createRunIn(q, asker, { loadId: load, refresh: true, turnId: null }, now));
    const row = (id: string) =>
      asApp(B, (q) =>
        q.query<{ status: string; ended_reason: string | null; finished: string | null; claim_token: string | null }>(
          `SELECT status, ended_reason, ${iso("finished_at", "finished")}, claim_token FROM portal_runs WHERE id = CAST($1 AS uuid)`,
          [id],
        ),
      ).then((r) => r[0]);

    // Queued and never claimed (a failed kick, a killed process): live until the stated age.
    const first = await ask(at(0));
    expect(first.kind).toBe("queued");
    const firstId = (first as { runId: string }).runId;
    expect(await ask(at(UNCLAIMED_AFTER_MS - 1_000))).toEqual({ kind: "live", runId: firstId, status: "queued" });
    const second = await ask(at(UNCLAIMED_AFTER_MS + 1_000));
    expect(second.kind).toBe("queued");
    const secondId = (second as { runId: string }).runId;
    expect(secondId).not.toBe(firstId);
    expect(await row(firstId)).toEqual({
      status: "failed",
      ended_reason: "runner_error",
      finished: at(UNCLAIMED_AFTER_MS + 1_000).toISOString(),
      claim_token: null,
    });

    // Claimed, then its worker went quiet: live until STALLED_AFTER_MS after the claim.
    const store = dbRunStore(B, app);
    const token = randomUUID();
    const claimedAt = at(UNCLAIMED_AFTER_MS + 2_000);
    expect(await store.claim(secondId, token, claimedAt)).toMatchObject({ kind: "claimed" });
    const fromClaim = (ms: number) => new Date(claimedAt.getTime() + ms);
    expect(await ask(fromClaim(STALLED_AFTER_MS - 1_000))).toEqual({ kind: "live", runId: secondId, status: "running" });
    const third = await ask(fromClaim(STALLED_AFTER_MS + 1_000));
    expect(third.kind).toBe("queued");
    const thirdId = (third as { runId: string }).runId;
    expect(await row(secondId)).toMatchObject({ status: "failed", ended_reason: "runner_error", claim_token: null });

    // The lost worker coming back is refused and writes nothing: its claim is gone.
    await expect(
      store.finish(secondId, token, { status: "done", reason: "ok" }, null, fromClaim(STALLED_AFTER_MS + 2_000)),
    ).rejects.toBeInstanceOf(LostClaimError);
    expect(await row(secondId)).toMatchObject({ status: "failed", ended_reason: "runner_error" });

    // A run waiting on a person is never ended here, however old.
    await asApp(B, (q) =>
      q.execute("UPDATE portal_runs SET status = 'waiting_approval' WHERE id = CAST($1 AS uuid) AND status = 'queued'", [thirdId]),
    );
    const later = fromClaim(2 * STALLED_AFTER_MS + 2_000);
    expect(await ask(later)).toEqual({ kind: "live", runId: thirdId, status: "waiting_approval" });
    clock = later.getTime();
  });

  it("refuses every sign-in after ten misses in a minute, for that tenant only", async () => {
    // Past any minute an earlier test's miss opened.
    clock += 120_000;
    const minted = await asApp(B, (q) => mintSession(q, { runId: null, createdBy: "limit-test", now: tick() }));
    const wrong = minted.code === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ";
    const countOf = (tenantId: string) =>
      asApp(tenantId, (q) => q.query<{ failed_sign_ins: number }>("SELECT failed_sign_ins FROM portal_accounts"));
    const aBefore = await countOf(A);
    for (let i = 0; i < SIGN_IN_FAILURE_LIMIT; i++) {
      expect(await asApp(B, (q) => signIn(q, { carrierNumber: CARRIER_B, code: wrong, now: tick() }))).toBeNull();
    }
    expect(await countOf(B)).toEqual([{ failed_sign_ins: SIGN_IN_FAILURE_LIMIT }]);
    // Locked: even the right code is refused, and it stays unused.
    expect(await asApp(B, (q) => signIn(q, { carrierNumber: CARRIER_B, code: minted.code, now: tick() }))).toBeNull();
    const unused = await asApp(B, (q) =>
      q.query<{ signed_in_at: Date | null }>("SELECT signed_in_at FROM portal_sessions WHERE id = CAST($1 AS uuid)", [
        minted.sessionId,
      ]),
    );
    expect(unused).toEqual([{ signed_in_at: null }]);
    // The other tenant counted nothing.
    expect(await countOf(A)).toEqual(aBefore);
    // Once the minute is over, the right code signs in, and the next miss starts a new count.
    clock += 61_000;
    expect(await asApp(B, (q) => signIn(q, { carrierNumber: CARRIER_B, code: minted.code, now: tick() }))).toBe(
      minted.sessionId,
    );
    expect(await asApp(B, (q) => signIn(q, { carrierNumber: CARRIER_B, code: wrong, now: tick() }))).toBeNull();
    expect(await countOf(B)).toEqual([{ failed_sign_ins: 1 }]);
  });

  it("keeps every portal table inside its tenant and the app login inside its grants", async () => {
    for (const table of PORTAL_TABLES) {
      const own = await asApp(A, (q) => q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${table}`));
      expect(own[0].n, table).toBeGreaterThan(0);
      const seen = await asApp(B, (q) =>
        q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${table} WHERE tenant_id = CAST($1 AS uuid)`, [A]),
      );
      expect(seen[0].n, table).toBe(0);
    }

    // Another tenant's id is refused by the policy; another tenant's load by the composite key.
    expect(
      await sqlStateOf(
        asApp(B, (q) =>
          q.execute(
            "INSERT INTO portal_runs (id, tenant_id, load_id, reference, requested_by, trace_id, model, status)" +
              " VALUES (CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid), $4, 'x', 'trace', 'wonder', 'queued')",
            [randomUUID(), A, setup[A].pendingLoad, REF_PENDING],
          ),
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlStateOf(
        asApp(B, (q) =>
          q.execute(
            "INSERT INTO portal_runs (id, tenant_id, load_id, reference, requested_by, trace_id, model, status)" +
              " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'x', 'trace', 'wonder', 'queued')",
            [randomUUID(), setup[A].pendingLoad, REF_PENDING],
          ),
        ),
      ),
    ).toBe("23503");

    // No deletes, no writes to the portal's own records, only the named columns.
    expect(await sqlStateOf(asApp(A, (q) => q.execute("DELETE FROM portal_runs")))).toBe("42501");
    expect(await sqlStateOf(asApp(A, (q) => q.execute("UPDATE portal_loads SET notes = 'x'")))).toBe("42501");
    expect(await sqlStateOf(asApp(A, (q) => q.execute("UPDATE portal_runs SET reference = 'FFE-999999'")))).toBe("42501");
    expect(await sqlStateOf(asApp(A, (q) => q.execute("UPDATE portal_run_checks SET code = 'other'")))).toBe("42501");
    expect(await sqlStateOf(asApp(A, (q) => q.execute("UPDATE portal_accounts SET carrier_number = 'MC-000001'")))).toBe(
      "42501",
    );

    // The portal cookie names a tenant; a session from another tenant opens nothing.
    expect(await withPortalTenant(cookieValue(B, sessionA), tick(), async () => "open", app)).toBeNull();
    expect(await withPortalTenant(cookieValue(A, sessionA), tick(), async () => "open", app)).toBe("open");
  });

  it("clears one tenant's portal rows in an order the keys allow, then seeds them again", async () => {
    const before = await asApp(B, (q) => q.query<{ n: number }>("SELECT CAST(count(*) AS integer) AS n FROM portal_loads"));
    // Evidence 3, checks 3, steps 10, sessions 2, runs 4, loads 2, account 1.
    expect(await clearTenantPortal(admin, A)).toBe(25);
    for (const table of PORTAL_TABLES) {
      const left = await asApp(A, (q) => q.query<{ n: number }>(`SELECT CAST(count(*) AS integer) AS n FROM ${table}`));
      expect(left[0].n, table).toBe(0);
    }
    const after = await asApp(B, (q) => q.query<{ n: number }>("SELECT CAST(count(*) AS integer) AS n FROM portal_loads"));
    expect(after).toEqual(before);
    expect(await seedTenantPortal(admin, A, planFor(A, CARRIER_A))).toBe(2);
  });
});
