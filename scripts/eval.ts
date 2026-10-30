import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { flags } from "../src/config/flags";
import { capNanocents, NANOCENTS_PER_CENT } from "../src/lib/ai/prices";
import { readSpend } from "../src/lib/ai/spend";
import { modelIdFor } from "../src/lib/ai/targets";
import type { Session } from "../src/lib/auth/claims";
import { createPgDb } from "../src/lib/db/pg";
import { DEFAULT_CACHE_DIR } from "../src/lib/eval/cache";
import { buildCases, selectCases } from "../src/lib/eval/cases";
import { renderResults, replaceReadmeSection, RESULTS_FILE, writeResults } from "../src/lib/eval/report";
import { notRunScore, overCapScore, unknownScore } from "../src/lib/eval/run";
import type { Arm, CaseResult, EvalResults, SparkOpenResults } from "../src/lib/eval/types";
import { DEMO_ANCHOR } from "../src/lib/seed/anchor";
import type { ArmInput, ArmOutput } from "./eval-arm";
import { evalRefusal, parseEvalArgs, type EvalArgs } from "./lib/eval-args";
import { dropDatabase, freshSeededDatabase, SEED_ANCHOR } from "./lib/fresh-seeded-db";
import { localDatabaseUrl } from "./lib/local-db";

// npm run eval -- [--arms spark,wonder,spark_open] [--cases all|10] [--fresh] [--max-cents N]
// npm run eval:readme
//
// The model eval (design 4.5). Each arm gets its own fresh local database, built from every
// migration and seeded for both invented carriers, and runs in its own process; the database is
// dropped after, failures included. Every case goes through the real operator turn and the real
// second check, scored from the tables with fixed rules. The results go to
// src/lib/eval/results/latest.json (counts, cents, milliseconds and model ids only); eval:readme
// copies the table into the README between its markers.
//
// Spend: refused unless the switch is on, the database is local, and the developer's own ledger
// has room for this run's limit plus the reserve. Each arm's process gets the run's remaining
// cents as its hard spend cap, so the run stops at its limit even if every turn runs to its caps.

// The model each arm sends the operator's calls to.
const ARM_TARGET: Record<Arm, "spark" | "wonder" | "spark_open"> = { spark: "spark", wonder: "wonder", spark_open: "spark_open" };

function readme(): number {
  const raw: unknown = JSON.parse(readFileSync(RESULTS_FILE, "utf8"));
  const results = raw as EvalResults;
  if (results.version !== 1 || !results.run) throw new Error("no eval run is recorded yet: run npm run eval first");
  const file = "README.md";
  // Refused unless the README has its two markers; nothing else in it is rewritten.
  writeFileSync(file, replaceReadmeSection(readFileSync(file, "utf8"), renderResults(results)));
  console.log("eval:readme: README section updated");
  return 0;
}

type Room = { cap: number; free: number };

async function ledgerRoom(server: URL): Promise<Room> {
  const cap = capNanocents(process.env.AI_SPEND_CAP_CENTS);
  if (cap === null) throw new Error("AI_SPEND_CAP_CENTS is not set to a whole number of cents");
  const db = createPgDb({ connectionString: server.toString(), max: 1 });
  try {
    const spend = await db.withoutTenant((q) => readSpend(q));
    return { cap, free: cap - spend.spentNanocents - spend.reservedNanocents };
  } finally {
    await db.close();
  }
}

// The two staff sessions the fresh database was built with (fresh-seeded-db.ts).
async function sessionsOf(url: URL): Promise<Record<string, Session>> {
  const db = createPgDb({ connectionString: url.toString(), max: 1 });
  try {
    const rows = await db.withoutTenant((q) =>
      q.query<{ tenant_id: string; slug: string; sub: string; email: string }>(
        "SELECT CAST(t.id AS text) AS tenant_id, t.slug, m.cognito_sub AS sub, m.email FROM tenants t" +
          " JOIN memberships m ON m.tenant_id = t.id AND m.cognito_sub = 'invariants-' || t.slug ORDER BY t.slug",
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.slug, { sub: r.sub, email: r.email, tenantId: r.tenant_id }]));
  } finally {
    await db.close();
  }
}

// What the arm's database spent: its own ledger, read before it is dropped. A reservation still
// open counts, so unknown is never zero.
async function spentOn(url: URL): Promise<number> {
  const db = createPgDb({ connectionString: url.toString(), max: 1 });
  try {
    const s = await db.withoutTenant((q) => readSpend(q));
    return s.spentNanocents + s.reservedNanocents;
  } finally {
    await db.close();
  }
}

function appLogin(url: URL): string {
  const app = new URL(url);
  app.username = "payday_app";
  app.password = "";
  return app.toString();
}

const allCases = (args: EvalArgs) => selectCases(buildCases(DEMO_ANCHOR), args.cases);

// An arm that never ran: its skipped cases are not run, the rest take the given status.
const filled = (arm: Arm, args: EvalArgs, score: () => CaseResult["score"]): CaseResult[] =>
  allCases(args).map((c) => ({ arm, caseKey: c.key, kind: c.kind, cached: false, score: c.skip !== null ? notRunScore() : score() }));

async function runArmProcess(
  server: URL,
  arm: Arm,
  args: EvalArgs,
  leftCents: number,
  models: { modelId: string; auditorModelId: string },
): Promise<{ out: ArmOutput | null; spent: number }> {
  const name = `payday_eval_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}_${arm}`;
  const dir = mkdtempSync(path.join(tmpdir(), "payday-eval-"));
  let url: URL | null = null;
  let out: ArmOutput | null = null;
  let spent = 0;
  try {
    url = await freshSeededDatabase(server, name);
    const input: ArmInput = {
      arm,
      cases: args.cases,
      fresh: args.fresh,
      cacheDir: path.resolve(DEFAULT_CACHE_DIR),
      anchor: DEMO_ANCHOR,
      sessions: await sessionsOf(url),
      modelId: models.modelId,
      auditorModelId: models.auditorModelId,
      sparkOpen: arm === "spark_open",
      outFile: path.join(dir, "out.json"),
    };
    const inputFile = path.join(dir, "in.json");
    writeFileSync(inputFile, JSON.stringify(input));
    const cents = String(leftCents);
    const child = spawnSync("npx", ["tsx", "scripts/eval-arm.ts"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        DATABASE_URL: appLogin(url),
        AI_SPEND_CAP_CENTS: cents,
        AI_WONDER_CAP_CENTS: cents,
        EVAL_ARM_INPUT: inputFile,
      },
    });
    if (child.status !== 0) console.error(`eval: the ${arm} arm stopped early`);
    out = existsSync(input.outFile) ? (JSON.parse(readFileSync(input.outFile, "utf8")) as ArmOutput) : null;
  } catch (err) {
    console.error(`eval: the ${arm} arm failed: ${err instanceof Error ? err.message : "unknown"}`);
  } finally {
    // The arm's own ledger, read before the drop; unreadable counts the whole allowance as spent.
    if (url) spent = await spentOn(url).catch(() => leftCents * NANOCENTS_PER_CENT);
    await dropDatabase(server, name);
    rmSync(dir, { recursive: true, force: true });
  }
  return { out, spent };
}

async function run(args: EvalArgs): Promise<number> {
  const refusal = evalRefusal();
  if (refusal) throw new Error(refusal);
  if (SEED_ANCHOR !== DEMO_ANCHOR) throw new Error("the fresh database's seed anchor is not the cases' anchor");
  const server = localDatabaseUrl();

  const auditorModelId = modelIdFor("wonder");
  const screenModelId = modelIdFor("spark_open");
  if (!auditorModelId || !screenModelId) throw new Error("the Muse Wonder and Muse Spark Open model ids must be set");
  const armModels = args.arms.map((arm) => ({ arm, modelId: modelIdFor(ARM_TARGET[arm]) }));
  if (armModels.some((m) => !m.modelId)) throw new Error("every arm's model id must be set");

  const maxNanocents = args.maxCents * NANOCENTS_PER_CENT;
  const room = await ledgerRoom(server);
  if (room.free < maxNanocents + flags.evalRun.reserveCents * NANOCENTS_PER_CENT) {
    throw new Error(`the model ledger has no room for ${args.maxCents} cents plus the ${flags.evalRun.reserveCents} cent reserve`);
  }

  let spent = 0;
  let stoppedAtCap = false;
  let sparkOpen: SparkOpenResults | null = null;
  const cases: CaseResult[] = [];
  for (const { arm, modelId } of armModels) {
    const leftCents = Math.floor((maxNanocents - spent) / NANOCENTS_PER_CENT);
    if (leftCents <= 0) {
      stoppedAtCap = true;
      cases.push(...filled(arm, args, overCapScore));
      continue;
    }
    console.log(`eval: ${arm} arm, up to ${leftCents} cents`);
    const r = await runArmProcess(server, arm, args, leftCents, { modelId: modelId ?? "", auditorModelId });
    spent += r.spent;
    if (r.out) {
      cases.push(...r.out.results);
      stoppedAtCap ||= r.out.stoppedAtCap;
      if (r.out.sparkOpen) sparkOpen = r.out.sparkOpen;
    } else {
      cases.push(...filled(arm, args, unknownScore));
    }
  }

  const results: EvalResults = {
    version: 1,
    run: {
      anchor: DEMO_ANCHOR,
      finishedAt: new Date().toISOString(),
      caseSet: args.cases,
      models: armModels,
      auditorModelId,
      cases,
      sparkOpen,
      spentNanocents: spent,
      stoppedAtCap,
    },
  };
  writeResults(results);
  console.log(renderResults(results));
  console.log(`eval: spent ${(spent / NANOCENTS_PER_CENT).toFixed(2)} cents; results in ${RESULTS_FILE}`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseEvalArgs(process.argv.slice(2));
  return args.readme ? readme() : run(args);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const plain = err instanceof Error && err.name === "Error";
    console.error(`eval: ${plain ? (err as Error).message : err instanceof Error ? err.name : "failed"}`);
    process.exit(1);
  },
);
