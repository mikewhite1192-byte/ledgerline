import { createHash, randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import type {
  ComputerAction,
  ComputerPair,
  ComputerRequest,
  ComputerResult,
  ComputerScreenshot,
  SafetyCheck,
} from "../../ai";
import type { Session } from "../../auth/claims";
import { cookieValue } from "../session";
import { summarize, validateBatch } from "./actions";
import { readAnswer, readbackOf } from "./answer";
import { PORTAL_COOKIE, sameOrigin, type CapturedPod, type DriverFactory, type PortalDriver } from "./driver";
import { PORTAL_INSTRUCTIONS, taskText } from "./prompt";
import {
  LostClaimError,
  type Ending,
  type EvidenceRow,
  type Progress,
  type RunRow,
  type RunStore,
  type StoredStep,
} from "./store";

// One portal run (design 3.3): claim it, open the portal, then screenshot, ask the model, act,
// until the model answers or a cap ends the run. The browser and the model call are injected,
// so the same loop runs locally, in tests and in the production worker.
//
// Binding (design 3.4): a call that carries any pending safety check pauses the run before any of
// its actions runs. The only checks ever sent back as acknowledged are the raw check objects of
// that step whose rows a person set to approved; this file never sets a check's status.

export type StepFn = (
  target: "wonder" | "spark",
  request: ComputerRequest,
  session: Session,
) => Promise<ComputerResult>;

export type ScreenFn = (input: {
  session: Session;
  traceId: string;
  turnId: string | null;
  inputId: string;
  now: Date;
}) => Promise<"clean" | "flagged" | "error">;

export type RunDeps = {
  store: RunStore;
  openDriver: DriverFactory;
  step: StepFn;
  screen: ScreenFn;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  origin: string;
  recordDir: string | null;
};

export type RunOutcome =
  | { kind: "skipped" }
  | { kind: "lost" }
  | { kind: "paused" }
  | { kind: "ended"; status: Ending["status"]; reason: string };

// The run row may not be visible yet when the worker starts (the request that made it commits
// just after the kick), so a missing row is retried briefly.
const CLAIM_TRIES = 10;
const CLAIM_WAIT_MS = 500;
const MAX_CHECKS = 8;
const STEP_OUTPUT_TOKENS = 1024;
const RETRY_OUTPUT_TOKENS = 2048;
const STEP_TIMEOUT_MS = 60_000;

// The worker has no signed-in request: it acts as the person who started the run, by their subject
// and tenant, the only two fields the wrapper and the screener read. It has no email to give.
const WORKER_EMAIL = "";
const workerSession = (requestedBy: string, tenantId: string): Session => ({
  sub: requestedBy,
  email: WORKER_EMAIL,
  tenantId,
});

class BrowserError extends Error {
  constructor() {
    super("browser error");
    this.name = "BrowserError";
  }
}

async function browser<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new BrowserError();
  }
}

// An ended run for a model call that threw. Categories only; the wrapper logged the rest.
function callFailure(err: unknown, atCallCap: boolean): string {
  if (err instanceof Error && err.name === "ForbiddenError") return "forbidden";
  const category = err instanceof Error && "category" in err ? (err as { category: unknown }).category : null;
  if (category === "too_expensive") return atCallCap ? "call_cents" : "run_cents";
  if (category === "cap") return "spend_cap";
  if (category === "disabled") return "disabled";
  return "model_error";
}

// The checks as rows will hold them, or null when there are more than a card can carry or two
// share an id.
function checksToStore(checks: readonly SafetyCheck[]): SafetyCheck[] | null {
  if (checks.length > MAX_CHECKS) return null;
  if (new Set(checks.map((c) => c.id)).size !== checks.length) return null;
  return checks.map((c) => ({ id: c.id, code: c.code, message: c.message.slice(0, 500) }));
}

// The raw check objects of a stored call whose ids a person approved, exactly as received.
function acknowledgedOf(callItem: Record<string, unknown>, approvedIds: ReadonlySet<string>): Record<string, unknown>[] {
  const raw = callItem.pending_safety_checks;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is Record<string, unknown> =>
      typeof c === "object" && c !== null && typeof (c as { id?: unknown }).id === "string" && approvedIds.has((c as { id: string }).id),
  );
}

type Pod = NonNullable<EvidenceRow["pod"]>;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const pathOf = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};

export async function runPortalRun(
  payload: { tenantId: string; runId: string },
  deps: RunDeps,
): Promise<RunOutcome> {
  const { store } = deps;
  const limits = flags.portalRunLimits;
  const token = randomUUID();

  let claimed = await store.claim(payload.runId, token, deps.now());
  for (let i = 1; i < CLAIM_TRIES && claimed.kind === "missing"; i++) {
    await deps.sleep(CLAIM_WAIT_MS);
    claimed = await store.claim(payload.runId, token, deps.now());
  }
  if (claimed.kind !== "claimed") return { kind: "skipped" };
  const run: RunRow = claimed.run;
  const startedMs = deps.now().getTime();
  const session = workerSession(run.requestedBy, payload.tenantId);
  const state = {
    cost: run.costNanocents,
    calls: run.modelCallCount,
    steps: run.stepCount,
    lastUrl: run.lastUrl,
  };
  const progress = (): Progress => ({
    costNanocents: state.cost,
    modelCallCount: state.calls,
    stepCount: state.steps,
    lastUrl: state.lastUrl,
  });
  const end = async (status: Ending["status"], reason: string, result?: unknown): Promise<RunOutcome> => {
    await store.finish(run.id, token, { status, reason, result }, progress(), deps.now());
    return { kind: "ended", status, reason };
  };

  let driver: PortalDriver | null = null;
  try {
    if (!flags.portalRunnerEnabled) return await end("failed", "disabled");
    if (!claimed.member) return await end("failed", "forbidden");
    const context = await store.context(run);
    if (!context) return await end("failed", "no_portal_account");

    // 1. Context: a new run mints its access code, which only the driver ever types; a resumed one
    // needs its session alive.
    let code: string | null = null;
    let sessionId = run.sessionId;
    const resuming = sessionId !== null;
    if (!sessionId) {
      const minted = await store.mintSession(run, token, deps.now());
      if (!minted) return await end("failed", "session_error");
      code = minted.code;
      sessionId = minted.sessionId;
    } else if ((await store.sessionState(sessionId, deps.now())) !== "alive") {
      return await end("failed", "session_expired");
    }
    const task = taskText({
      loadNumber: context.loadNumber,
      reference: run.reference,
      portalUrl: `${deps.origin}/portal`,
    });

    // What a resumed run picks up: its stored steps, the approved checks, the paused step.
    let stored: StoredStep[] = [];
    let paused: StoredStep | null = null;
    let approvedIds = new Set<string>();
    const ackByStep = new Map<string, Set<string>>();
    if (resuming) {
      stored = await store.steps(run.id);
      const checks = await store.checks(run.id);
      for (const c of checks) {
        if (c.status !== "approved") continue;
        if (!ackByStep.has(c.stepId)) ackByStep.set(c.stepId, new Set());
        ackByStep.get(c.stepId)!.add(c.checkId);
      }
      paused = stored.find((s) => s.seq === run.resumeStep && !s.executed && s.callItem !== null) ?? null;
      if (!paused) return await end("failed", "not_resumable");
      const own = checks.filter((c) => c.stepId === paused!.id);
      if (own.length === 0 || own.some((c) => c.status !== "approved")) return await end("failed", "not_resumable");
      const oldest = Math.min(...own.map((c) => Date.parse(c.createdAt)));
      if (deps.now().getTime() - oldest > limits.approvalWaitMinutes * 60_000) {
        return await end("stopped", "approval_expired");
      }
      approvedIds = ackByStep.get(paused.id) ?? new Set();
    }

    // 2. Open.
    const opened = await browser(() =>
      deps.openDriver({ origin: deps.origin, podMaxBytes: limits.podMaxBytes, recordDir: deps.recordDir }),
    );
    driver = opened;
    const shoot = async (): Promise<ComputerScreenshot | null> => {
      await opened.settle();
      const shot = await browser(() => opened.screenshot());
      return shot.bytes.length > limits.screenshotMaxBytes ? null : shot;
    };

    let first: ComputerScreenshot;
    const history: ComputerPair[] = [];
    const urls = new Map<number, string | null>();
    let nextSeq: number;
    if (!resuming) {
      // The driver signs in itself, before the first screenshot, so the code never reaches the
      // model, a screenshot or a stored step. Anything but the loads page after it is a failure.
      if (!code) return await end("failed", "session_error");
      const signInCode = code;
      await browser(() =>
        opened.signIn(`${deps.origin}/portal?t=${encodeURIComponent(payload.tenantId)}`, {
          carrierNumber: context.carrierNumber,
          code: signInCode,
        }),
      );
      const landed = opened.url();
      if (!sameOrigin(landed, deps.origin) || pathOf(landed) !== "/portal/loads") {
        return await end("failed", "sign_in_failed");
      }
      const shot = await shoot();
      if (!shot) return await end("failed", "screenshot_too_large");
      first = shot;
      state.lastUrl = opened.url();
      await store.insertStep(run.id, token, {
        seq: 0,
        modelCallId: null,
        call: null,
        summary: [],
        executed: true,
        stoppedEarly: false,
        screenshot: shot,
        urlAfter: state.lastUrl,
        costNanocents: 0,
        pendingCheckCount: 0,
      });
      urls.set(0, state.lastUrl);
      nextSeq = 1;
    } else {
      const opening = await store.screenshot(run.id, 0);
      if (!opening) return await end("failed", "not_resumable");
      first = opening;
      // The history, one screenshot read at a time (a response carries at most one image).
      for (const s of stored) {
        urls.set(s.seq, s.urlAfter);
        if (s.seq === 0 || !s.callItem || !s.executed || !s.upstreamCallId) continue;
        const shot = await store.screenshot(run.id, s.seq);
        if (!shot) return await end("failed", "not_resumable");
        history.push({
          call: s.callItem,
          output: { callId: s.upstreamCallId, screenshot: shot, acknowledged: acknowledgedOf(s.callItem, ackByStep.get(s.id) ?? new Set()) },
        });
      }
      nextSeq = Math.max(...stored.map((s) => s.seq)) + 1;
      const back = run.lastUrl && sameOrigin(run.lastUrl, deps.origin) ? run.lastUrl : `${deps.origin}/portal/loads`;
      await browser(() => opened.open(back, { name: PORTAL_COOKIE, value: cookieValue(payload.tenantId, sessionId!) }));
    }

    // Runs one validated batch in order, stopping early on a browser error, then screenshots.
    const execute = async (actions: ComputerAction[]) => {
      let stoppedEarly = false;
      for (const action of actions) {
        try {
          await opened.run(action);
        } catch {
          stoppedEarly = true;
          break;
        }
      }
      const shot = await shoot();
      return { stoppedEarly, shot };
    };

    let pod: Pod | null = null;
    // The hash of a POD this run captured before a pause and no longer holds. Unknown is not
    // zero: such a run never stores evidence that says it found no POD.
    let lostPod: string | null = null;
    // A resumed run picks up the POD it had when it paused, only when the held bytes hash to it.
    if (resuming) {
      const kept = await store.heldPod(run.id, token);
      if (kept.pausedHash !== null) {
        if (kept.held && sha256(kept.held.bytes) === kept.pausedHash) {
          pod = { bytes: kept.held.bytes, hash: kept.pausedHash, stepSeq: kept.held.stepSeq };
        } else {
          lostPod = kept.pausedHash;
          console.warn(`portal run ${run.id}: the POD captured before the pause was not held`);
        }
      }
    }
    let seenPod: CapturedPod | null = opened.pod();
    // Only this run's own load's POD counts: the whole path, compared whole. A POD the browser
    // opened for any other load (a misclick, or page text steering the model) is never stored as
    // this load's; it is counted on the run's result instead.
    const ownPod = `/portal/loads/${run.reference}/pod`;
    let otherPods = 0;
    const notePod = (seq: number) => {
      const captured = opened.pod();
      if (!captured || captured === seenPod) return;
      seenPod = captured;
      if (!sameOrigin(captured.url, deps.origin) || pathOf(captured.url) !== ownPod) {
        otherPods += 1;
        console.warn("portal run: ignored a POD that is not this load's");
        return;
      }
      pod = { bytes: captured.bytes, hash: sha256(captured.bytes), stepSeq: seq };
      lostPod = null;
    };

    // Holds the POD on the run for its resume, in its own write before the pause, failing safe:
    // a POD over the cap is never sent, and a write that fails is logged by category and leaves
    // the pause to go ahead. The pause records the POD's hash either way, so the resume takes the
    // held bytes only when they are this POD. Only a lost claim stops the run here.
    const holdPod = async (p: Pod) => {
      if (p.bytes.length > limits.podMaxBytes) {
        console.warn(`portal run ${run.id}: POD over the cap, not held for the resume`);
        return;
      }
      try {
        await store.holdPod(run.id, token, { bytes: p.bytes, stepSeq: p.stepSeq });
      } catch (err) {
        if (err instanceof LostClaimError) throw err;
        console.warn(`portal run ${run.id}: POD not held for the resume`);
      }
    };

    // 10. Resume: the approved step's actions run now, and its answer carries the approvals.
    if (paused && paused.callItem && paused.upstreamCallId) {
      const raw = Array.isArray(paused.callItem.actions) ? (paused.callItem.actions as Record<string, unknown>[]) : [];
      const batch = validateBatch(raw, limits.maxActionsPerStep);
      if (!batch.ok) return await end("failed", "invalid_action", { detail: batch.reason });
      const { stoppedEarly, shot } = await execute(batch.actions);
      if (!shot) return await end("failed", "screenshot_too_large");
      state.lastUrl = opened.url();
      await store.completeStep(run.id, token, paused.seq, { screenshot: shot, urlAfter: state.lastUrl, stoppedEarly });
      await store.progress(run.id, token, progress());
      urls.set(paused.seq, state.lastUrl);
      notePod(paused.seq);
      history.push({
        call: paused.callItem,
        output: { callId: paused.upstreamCallId, screenshot: shot, acknowledged: acknowledgedOf(paused.callItem, approvedIds) },
      });
    }

    let retried = false;
    for (;;) {
      // 4. Budget gate, before every model call.
      if (state.calls >= limits.maxSteps) return await end("failed", "step_budget");
      if (deps.now().getTime() - startedMs >= limits.maxWallMs) return await end("failed", "wall_time");
      const remainingCents = limits.maxRunCents - state.cost / 1_000_000_000;
      const maxCostCents = Math.min(limits.maxCallCents, Math.floor(remainingCents));
      if (maxCostCents < 1) return await end("failed", "run_cents");

      // 5. Call.
      let result: ComputerResult;
      try {
        result = await deps.step(
          run.model,
          {
            purpose: "portal_runner_step",
            instructions: PORTAL_INSTRUCTIONS,
            task,
            screenshot: first,
            history,
            maxOutputTokens: retried ? RETRY_OUTPUT_TOKENS : STEP_OUTPUT_TOKENS,
            reasoningEffort: "medium",
            maxCostCents,
            timeoutMs: STEP_TIMEOUT_MS,
            traceId: run.traceId,
          },
          session,
        );
      } catch (err) {
        return await end("failed", callFailure(err, maxCostCents === limits.maxCallCents));
      }
      state.calls += 1;
      state.cost += result.costNanocents;

      // 6. Out of output budget: once more with a larger one, from the same state.
      if (result.status === "incomplete") {
        if (retried) return await end("failed", "incomplete");
        retried = true;
        await store.progress(run.id, token, progress());
        continue;
      }
      retried = false;
      const seq = nextSeq++;
      const call = result.call;

      // 11. The answer.
      if (!call) {
        state.steps += 1;
        await store.insertStep(run.id, token, {
          seq,
          modelCallId: result.callId,
          call: null,
          summary: [],
          executed: false,
          stoppedEarly: false,
          screenshot: null,
          urlAfter: null,
          costNanocents: result.costNanocents,
          pendingCheckCount: 0,
        });
        // A POD captured before a pause that the resume did not get back and no later step
        // downloaded again: the run ends without evidence rather than storing it as no POD.
        if (lostPod !== null) return await end("failed", "pod_not_kept");
        const read = readAnswer(result.text, run.reference);
        if (!read.ok) return await end("failed", "no_evidence");
        const inputId = await store.storeAnswer(result.text, deps.now());
        const verdict = await deps.screen({ session, traceId: run.traceId, turnId: run.turnId, inputId, now: deps.now() });
        if (verdict === "error") return await end("failed", "screen_error");
        const record = await store.portalRecord(run.loadId);
        if (!record) return await end("failed", "no_portal_load");
        const captured = pod as Pod | null;
        const readback = readbackOf(
          { checkedIn: read.checkedIn, checkedOut: read.checkedOut, zone: read.zone, podHash: captured?.hash ?? null },
          record,
        );
        // The step whose screenshot shows the times: the last one on the load's own page.
        const detail = `/portal/loads/${run.reference}`;
        const onDetail = [...urls.entries()].filter(([, url]) => pathOf(url) === detail).map(([s]) => s);
        const timesStepSeq = read.checkedIn && onDetail.length > 0 ? Math.max(...onDetail) : null;
        const found = read.answer.found;
        await store.finishWithEvidence(
          run.id,
          token,
          run.loadId,
          {
            checkedIn: read.checkedIn,
            checkedOut: read.checkedOut,
            zone: read.zone,
            timesStepSeq,
            pod: captured,
            answer: read.answer,
            untrustedInputId: inputId,
            screenVerdict: verdict,
            readback,
          },
          {
            status: "done",
            reason: found ? "ok" : "not_found",
            result: { readback, screen: verdict, ...(otherPods > 0 ? { ignoredPods: otherPods } : {}) },
          },
          progress(),
          deps.now(),
        );
        return { kind: "ended", status: "done", reason: found ? "ok" : "not_found" };
      }

      const summary = summarize(call.actions);
      const base = {
        seq,
        modelCallId: result.callId,
        call: { callId: call.callId, raw: call.raw },
        summary,
        costNanocents: result.costNanocents,
      };

      // 7. Safety checks: stop here; nothing in this call runs until a person decides.
      if (call.pendingSafetyChecks.length > 0) {
        const checks = checksToStore(call.pendingSafetyChecks);
        state.steps += 1;
        const stepId = await store.insertStep(run.id, token, {
          ...base,
          executed: false,
          stoppedEarly: false,
          screenshot: null,
          urlAfter: null,
          pendingCheckCount: checks ? checks.length : 0,
        });
        if (!checks) return await end("failed", "too_many_checks");
        const held = pod as Pod | null;
        if (held) await holdPod(held);
        await store.pause(run.id, token, stepId, checks, progress(), held?.hash ?? lostPod, deps.now());
        return { kind: "paused" };
      }

      // 8. Validate the whole batch, then run it.
      const batch = validateBatch(call.actions, limits.maxActionsPerStep);
      if (!batch.ok) {
        state.steps += 1;
        await store.insertStep(run.id, token, {
          ...base,
          executed: false,
          stoppedEarly: false,
          screenshot: null,
          urlAfter: null,
          pendingCheckCount: 0,
        });
        return await end("failed", "invalid_action", { detail: batch.reason });
      }
      const { stoppedEarly, shot } = await execute(batch.actions);
      if (!shot) return await end("failed", "screenshot_too_large");
      state.lastUrl = opened.url();
      state.steps += 1;
      await store.insertStep(run.id, token, {
        ...base,
        executed: true,
        stoppedEarly,
        screenshot: shot,
        urlAfter: state.lastUrl,
        pendingCheckCount: 0,
      });
      await store.progress(run.id, token, progress());
      urls.set(seq, state.lastUrl);
      // 9. A POD downloaded by this step.
      notePod(seq);
      history.push({ call: call.raw, output: { callId: call.callId, screenshot: shot, acknowledged: [] } });
    }
  } catch (err) {
    if (err instanceof LostClaimError) return { kind: "lost" };
    const reason = err instanceof BrowserError ? "browser_error" : err instanceof Error && err.name === "DbError" ? "db_error" : "runner_error";
    console.error(`portal run ${run.id}: ended ${reason}`);
    try {
      return await end("failed", reason);
    } catch {
      return { kind: "lost" };
    }
  } finally {
    if (driver) await driver.close().catch(() => undefined);
  }
}
