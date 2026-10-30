import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { centsToDisplay } from "../ai/prices";
import { agreementOf, type Agreement } from "./score";
import { ARMS, type Arm, type CaseResult, type EvalResults, type ScreenResult } from "./types";

// The results: one JSON file the models page reads, and the README table. Both are built from
// counts, cents, milliseconds and model ids only; no message and no model text is ever written.

export const RESULTS_FILE = path.join("src", "lib", "eval", "results", "latest.json");
export const README_START = "<!-- eval:start -->";
export const README_END = "<!-- eval:end -->";

export type Tally = { right: number; of: number };

export type ArmSummary = {
  arm: Arm;
  modelId: string | null;
  cases: number;
  scored: number;
  notRun: number;
  unknown: number;
  overCap: number;
  // Right answer: the planted problem was named (the proposal cites the record at fault, or the
  // answer names it). Right amount: the engine's figure. Right fix: the right kind and number of
  // proposals and nothing else (none at all for an answer-only case).
  rightAnswer: Tally;
  rightAmount: Tally;
  rightFix: Tally;
  passed: Tally;
  injection: { flagged: Tally; held: Tally };
  // Per scored case; null with none scored. Cents include the second check's call.
  msPerCase: number | null;
  nanocentsPerCase: number | null;
  // What the arm spent on every case it ran, scored or not (an unknown or cut case spent too),
  // shown next to the per-case figure so no spend is left out. A case read from the cache spent
  // nothing this run, so its earlier cost is left out here (the per-case figure still uses it).
  spentNanocents: number;
};

function tally(results: readonly CaseResult[], pick: (r: CaseResult) => boolean | null): Tally {
  let right = 0;
  let of = 0;
  for (const r of results) {
    if (r.score.status !== "scored") continue;
    const v = pick(r);
    if (v === null) continue;
    of += 1;
    if (v) right += 1;
  }
  return { right, of };
}

export function summarizeArm(arm: Arm, modelId: string | null, all: readonly CaseResult[]): ArmSummary {
  const results = all.filter((r) => r.arm === arm);
  const scored = results.filter((r) => r.score.status === "scored");
  const count = (s: string) => results.filter((r) => r.score.status === s).length;
  const ms = scored.reduce((a, r) => a + r.score.latencyMs, 0);
  const costOf = (r: CaseResult) => r.score.costNanocents + r.score.auditorNanocents;
  const cost = scored.reduce((a, r) => a + costOf(r), 0);
  const nonInjection = results.filter((r) => r.kind !== "injection");
  const injections = results.filter((r) => r.kind === "injection");
  return {
    arm,
    modelId,
    cases: results.length,
    scored: scored.length,
    notRun: count("not_run"),
    unknown: count("unknown"),
    overCap: count("over_cap"),
    rightAnswer: tally(nonInjection, (r) => r.score.causeRight),
    rightAmount: tally(nonInjection, (r) => r.score.amountRight),
    rightFix: tally(nonInjection, (r) => r.score.fixRight),
    passed: tally(results, (r) => r.score.pass),
    injection: {
      flagged: tally(injections, (r) => r.score.injection?.screenFlagged ?? null),
      held: tally(injections, (r) => {
        const i = r.score.injection;
        if (!i || i.noUnflaggedProposal === null) return null;
        return i.noUnflaggedProposal && i.limitEnforced !== false;
      }),
    },
    // Rounded up: a cost is never shown smaller than it was.
    msPerCase: scored.length === 0 ? null : Math.round(ms / scored.length),
    nanocentsPerCase: scored.length === 0 ? null : Math.ceil(cost / scored.length),
    spentNanocents: results.reduce((a, r) => a + (r.cached ? 0 : costOf(r)), 0),
  };
}

export type Summary = { arms: ArmSummary[]; agreement: Agreement };

export function summarize(r: EvalResults): Summary | null {
  if (!r.run) return null;
  const run = r.run;
  const arms = ARMS.filter((a) => run.models.some((m) => m.arm === a)).map((a) =>
    summarizeArm(a, run.models.find((m) => m.arm === a)?.modelId ?? null, run.cases),
  );
  return { arms, agreement: agreementOf(run.cases) };
}

const ARM_LABEL: Record<Arm, string> = {
  spark: "Muse Spark (as shipped)",
  wonder: "Muse Wonder",
  spark_open: "Muse Spark Open",
};

export const armLabel = (arm: Arm) => ARM_LABEL[arm];
export const tallyText = (t: Tally) => (t.of === 0 ? "n/a" : `${t.right} of ${t.of}`);
export const secondsText = (ms: number | null) => (ms === null ? "n/a" : (ms / 1000).toFixed(1));
export const centsText = (nanocents: number | null) => (nanocents === null ? "n/a" : centsToDisplay(nanocents, 2));

// Muse Spark Open's screens: right of those that gave a verdict, and how many gave none (a
// screen that could not finish is not known, never counted wrong).
export function screenTally(screens: readonly ScreenResult[]): { sorted: Tally; unknown: number } {
  const answered = screens.filter((x) => x.verdict !== null);
  return {
    sorted: { right: answered.filter((x) => x.verdict === x.expected).length, of: answered.length },
    unknown: screens.length - answered.length,
  };
}

export function agreementLine(a: Agreement): string {
  return (
    `When the operator and the second check agreed they were right ${a.agreedRight} of ${a.agreed} times; ` +
    `when they disagreed the second check was right ${a.disagreedCheckRight} of ${a.disagreed} times.`
  );
}

// The README section: one row per arm, the agreement line, the injection lines and the Spark
// Open numbers. Only counts, seconds, cents and model ids.
export function renderResults(r: EvalResults): string {
  const s = summarize(r);
  if (!r.run || !s) return "No eval run is recorded yet.";
  const rows = s.arms.map((a) =>
    [
      `${armLabel(a.arm)}${a.modelId ? ` (\`${a.modelId}\`)` : ""}`,
      `${a.scored} of ${a.cases}`,
      tallyText(a.rightAnswer),
      tallyText(a.rightAmount),
      tallyText(a.rightFix),
      secondsText(a.msPerCase),
      centsText(a.nanocentsPerCase),
      centsText(a.spentNanocents),
    ].join(" | "),
  );
  const lines = [
    `Run on the seed of ${r.run.anchor}, ${r.run.caseSet === "10" ? "the ten-case set" : "every case"}. ` +
      `The second check runs on ${r.run.auditorModelId ? `\`${r.run.auditorModelId}\`` : "Muse Wonder"} in every row.`,
    "",
    "| Operator model | Cases scored | Right answer | Right amount | Right fix | Seconds per case | Cents per case | Cents in all |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    "",
    agreementLine(s.agreement),
    "",
    ...s.arms.map(
      (a) =>
        `${armLabel(a.arm)}: the screen flagged the planted messages ${tallyText(a.injection.flagged)} times; ` +
        `no change was proposed from them ${tallyText(a.injection.held)} times.`,
    ),
  ];
  const so = r.run.sparkOpen;
  if (so) {
    const screens = screenTally(so.screens);
    const triage = so.triage;
    const t = (pick: (x: (typeof triage)[number]) => boolean | null) =>
      tallyText({ right: triage.filter((x) => pick(x) === true).length, of: triage.filter((x) => pick(x) !== null).length });
    lines.push(
      "",
      `Muse Spark Open screening (\`${so.screenTarget}\`): ${tallyText(screens.sorted)} inputs sorted right ` +
        `(flagged or clean as planted)${screens.unknown > 0 ? `, and ${screens.unknown} could not be screened` : ""}.`,
      `Muse Spark Open triage (\`${so.triageTarget}\`): category ${t((x) => x.categoryRight)}, amount ${t((x) => x.amountRight)}, ` +
        `dates ${t((x) => x.datesRight)}, driver ${t((x) => x.driverRight)}.`,
    );
  }
  if (r.run.stoppedAtCap) lines.push("", "The run stopped at its own spend limit; the cases it did not reach are counted as not scored.");
  return lines.join("\n");
}

// Written whole through a temporary file, so the page never reads half a file.
export function writeResults(r: EvalResults, file: string = RESULTS_FILE): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
  renameSync(tmp, file);
}

// The README with the section between the markers replaced. Refuses without both markers, in
// order, each once: nothing else in the README is ever rewritten.
export function replaceReadmeSection(readme: string, body: string): string {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (
    start === -1 ||
    end === -1 ||
    end < start ||
    readme.indexOf(README_START, start + 1) !== -1 ||
    readme.indexOf(README_END, end + 1) !== -1
  ) {
    throw new Error("the README needs one eval:start marker and one eval:end marker after it");
  }
  return `${readme.slice(0, start + README_START.length)}\n${body}\n${readme.slice(end)}`;
}
