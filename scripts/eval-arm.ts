import { readFileSync, writeFileSync } from "node:fs";
import { flags } from "../src/config/flags";
import { complete } from "../src/lib/ai";
import type { Session } from "../src/lib/auth/claims";
import { getDb } from "../src/lib/db";
import { buildCases, selectCases } from "../src/lib/eval/cases";
import { evalClock, runArm } from "../src/lib/eval/run";
import { runSparkOpen } from "../src/lib/eval/spark-open";
import { ARMS, type Arm, type CaseResult, type SparkOpenResults } from "../src/lib/eval/types";
import { DEMO_CARRIERS } from "../src/lib/seed/carriers";
import { buildCarrierPlan } from "../src/lib/seed/plan";
import { evalRefusal } from "./lib/eval-args";

// One arm of npm run eval, started by scripts/eval.ts in its own process (the app's database
// handle is made once per process) with DATABASE_URL set to the app login of that arm's fresh
// database and AI_SPEND_CAP_CENTS set to what the run has left. Never started by hand. Reads its
// input file, writes its results file; the parent removes both.

export type ArmInput = {
  arm: Arm;
  cases: "all" | "10";
  fresh: boolean;
  cacheDir: string;
  anchor: string;
  sessions: Record<string, Session>;
  modelId: string | null;
  auditorModelId: string | null;
  screenModelId: string | null;
  sparkOpen: boolean;
  outFile: string;
};

export type ArmOutput = { results: CaseResult[]; stoppedAtCap: boolean; sparkOpen: SparkOpenResults | null };

// The product's switches a case needs, set here in this process only (never through env, never
// on a deployed app). The pay correction executor and every payout switch stay as they ship: the
// eval proposes, nothing approves.
function turnOn(): void {
  flags.aiEnabled = true;
  flags.agentEnabled = true;
  flags.auditorEnabled = true;
  flags.detentionEnabled = true;
  flags.customerPaymentsEnabled = true;
  flags.invoicesEnabled = true;
  flags.reportsEnabled = true;
  flags.fuelAnomalyEnabled = true;
  flags.inboxEnabled = true;
}

async function main(): Promise<number> {
  const refusal = evalRefusal();
  if (refusal) throw new Error(refusal);
  if (!/^\/payday_eval_[a-z0-9_]{1,40}$/.test(new URL(process.env.DATABASE_URL ?? "").pathname)) {
    throw new Error("an eval arm runs only on a database the eval made");
  }
  const file = process.env.EVAL_ARM_INPUT;
  if (!file) throw new Error("EVAL_ARM_INPUT is not set");
  const input = JSON.parse(readFileSync(file, "utf8")) as ArmInput;
  if (!(ARMS as readonly string[]).includes(input.arm)) throw new Error("unknown arm");
  turnOn();

  const db = getDb();
  const clock = evalClock(input.anchor);
  const base = (target: Parameters<typeof complete>[0], request: Parameters<typeof complete>[1], session: Session) =>
    complete(target, request, session);

  let sparkOpen: SparkOpenResults | null = null;
  if (input.sparkOpen) {
    const carriers = DEMO_CARRIERS.flatMap((c) => {
      const session = input.sessions[c.slug];
      return session ? [{ slug: c.slug, session, rows: buildCarrierPlan(c, input.anchor).rows }] : [];
    });
    sparkOpen = await runSparkOpen({ carriers, db, complete: base, clock });
  }

  const cases = selectCases(buildCases(input.anchor), input.cases);
  const { results, stoppedAtCap } = await runArm({
    arm: input.arm,
    cases,
    sessions: input.sessions,
    deps: { db, complete: base, clock },
    anchor: input.anchor,
    modelId: input.modelId,
    auditorModelId: input.auditorModelId,
    screenModelId: input.screenModelId,
    cacheDir: input.cacheDir,
    fresh: input.fresh,
  });
  const out: ArmOutput = { results, stoppedAtCap, sparkOpen };
  writeFileSync(input.outFile, JSON.stringify(out));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const plain = err instanceof Error && err.name === "Error";
    console.error(`eval arm: ${plain ? (err as Error).message : err instanceof Error ? err.name : "failed"}`);
    process.exit(1);
  },
);
