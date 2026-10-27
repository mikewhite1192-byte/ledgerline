import { after } from "next/server";
import { screenUntrustedInput } from "../../agent/gateway/screen";
import { computerStep } from "../../ai";
import { portalOrigin, recordDir, runnerMode } from "../config";
import { openPlaywrightDriver } from "./playwright-driver";
import { runPortalRun, type RunDeps, type ScreenFn } from "./run";
import { dbRunStore } from "./store";

// Starts the worker for a run (design 3.6). Inline: the loop runs in this process once the
// response has gone (Next's after()), local development only. Lambda, the production runner, is
// wired by a later change; until then a deployed app has no runner and starts nothing.

export type KickPayload = { tenantId: string; runId: string };
// True when a worker was started.
export type Kick = (payload: KickPayload) => boolean;

// The screener for the model's answer: the gateway's own, on Muse Spark Open, logged as the
// operator's decision on the run's trace.
const screenAnswer: ScreenFn = async ({ session, traceId, turnId, inputId, now }) => {
  try {
    const outcome = await screenUntrustedInput(
      {
        session,
        role: "operator",
        model: "spark_open",
        turnId,
        traceId,
        now,
        deadlineAt: now.getTime() + 30_000,
        timeZone: "UTC",
      },
      inputId,
    );
    return outcome.verdict.via === "error" ? "error" : outcome.verdict.verdict;
  } catch {
    return "error";
  }
};

export function inlineDeps(tenantId: string, origin: string): RunDeps {
  return {
    store: dbRunStore(tenantId),
    openDriver: openPlaywrightDriver,
    step: (target, request, session) => computerStep(target, request, session),
    screen: screenAnswer,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    origin,
    recordDir: recordDir(),
  };
}

export const kickPortalRun: Kick = (payload) => {
  if (runnerMode() !== "inline") return false;
  const origin = portalOrigin();
  if (!origin) return false;
  const job = async () => {
    try {
      await runPortalRun(payload, inlineDeps(payload.tenantId, origin));
    } catch (err) {
      console.error("portal run: worker failed", err instanceof Error ? err.name : "unknown");
    }
  };
  try {
    after(job);
  } catch {
    // Outside a request (a script): run detached.
    void job();
  }
  return true;
};

// Whether a run can start here at all: a runner and a portal origin.
export function runnerReady(): boolean {
  return runnerMode() !== null && portalOrigin() !== null;
}
