import { flags } from "../../src/config/flags";
import { ARMS, type Arm } from "../../src/lib/eval/types";
import { localDatabaseUrl } from "./local-db";

// The arguments of npm run eval, and the checks both the run and each arm's worker make before
// anything is built or any model is called. Anything not in the usage is refused, not ignored.

export type EvalArgs = {
  readme: boolean;
  arms: Arm[];
  cases: "all" | "10";
  fresh: boolean;
  maxCents: number;
};

export const EVAL_USAGE =
  "usage: npm run eval -- [--arms spark,wonder,spark_open] [--cases all|10] [--fresh] [--max-cents N]" +
  " | npm run eval:readme";

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  let readme = false;
  let arms: Arm[] | undefined;
  let cases: string | undefined;
  let fresh = false;
  let maxCents: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--readme" && !readme) {
      readme = true;
    } else if (arg === "--fresh" && !fresh) {
      fresh = true;
    } else if (arg === "--arms" && arms === undefined && i + 1 < argv.length) {
      const list = argv[++i].split(",");
      if (list.length === 0 || new Set(list).size !== list.length) throw new Error(EVAL_USAGE);
      if (!list.every((a): a is Arm => (ARMS as readonly string[]).includes(a))) throw new Error(EVAL_USAGE);
      // Always in the table's order.
      arms = ARMS.filter((a) => list.includes(a));
    } else if (arg === "--cases" && cases === undefined && i + 1 < argv.length) {
      cases = argv[++i];
    } else if (arg === "--max-cents" && maxCents === undefined && i + 1 < argv.length) {
      const raw = argv[++i];
      if (!/^[1-9][0-9]{0,5}$/.test(raw)) throw new Error(EVAL_USAGE);
      maxCents = Number(raw);
    } else {
      throw new Error(EVAL_USAGE);
    }
  }
  if (cases !== undefined && cases !== "all" && cases !== "10") throw new Error(EVAL_USAGE);
  if (readme && (arms !== undefined || cases !== undefined || fresh || maxCents !== undefined)) throw new Error(EVAL_USAGE);
  const limit = flags.evalRun.maxRunCents;
  if (maxCents !== undefined && maxCents > limit) throw new Error(`--max-cents is at most ${limit} (flags.evalRun.maxRunCents)`);
  return { readme, arms: arms ?? [...ARMS], cases: cases === "10" ? "10" : "all", fresh, maxCents: maxCents ?? limit };
}

// Why a run may not start here, or null. The run's own switch, then local only: a Postgres on
// this machine and no Aurora cluster configured, so a run can never reach a shared database.
export function evalRefusal(): string | null {
  const env = process.env;
  if (flags.evalRun.enabled !== true) return "the eval run switch is off (flags.evalRun.enabled)";
  if (env.DB_CLUSTER_ARN) return "DB_CLUSTER_ARN is set: the eval runs on a local database only";
  if (env.NODE_ENV === "production") return "the eval never runs with NODE_ENV=production";
  try {
    localDatabaseUrl();
  } catch (err) {
    return err instanceof Error ? err.message : "DATABASE_URL is not usable";
  }
  return null;
}
