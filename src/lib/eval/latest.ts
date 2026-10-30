import type { EvalCardProps } from "@/components/trace/eval-card";
import raw from "./results/latest.json";
import { agreementLine, armLabel, centsText, screenTally, secondsText, summarize, tallyText } from "./report";
import { ARMS, CASE_KINDS, isCaseScore, isCount, isNullableBool, type EvalResults } from "./types";

// The recorded eval run the models page shows, from the tracked results file (bundled with the
// app, never read from disk at request time), and the card's words built from it. A file that is
// not the expected shape shows no card.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown) => typeof v === "string";
const isNullableText = (v: unknown) => v === null || typeof v === "string";
const isNullableCount = (v: unknown) => v === null || isCount(v);
const isArm = (v: unknown) => (ARMS as readonly unknown[]).includes(v);
const everyOf = (v: unknown, ok: (x: unknown) => boolean) => Array.isArray(v) && v.every(ok);

const isArmModel = (v: unknown) => isObj(v) && isArm(v.arm) && isNullableText(v.modelId);
const isCaseResult = (v: unknown) =>
  isObj(v) &&
  isArm(v.arm) &&
  isText(v.caseKey) &&
  (CASE_KINDS as readonly unknown[]).includes(v.kind) &&
  typeof v.cached === "boolean" &&
  isCaseScore(v.score);
const isScreen = (v: unknown) =>
  isObj(v) &&
  isText(v.key) &&
  (v.expected === "clean" || v.expected === "flagged") &&
  (v.verdict === null || v.verdict === "clean" || v.verdict === "flagged") &&
  isNullableCount(v.latencyMs) &&
  isCount(v.costNanocents);
const isTriage = (v: unknown) =>
  isObj(v) &&
  isText(v.key) &&
  ["categoryRight", "amountRight", "datesRight", "driverRight"].every((k) => isNullableBool(v[k])) &&
  isNullableCount(v.latencyMs) &&
  isCount(v.costNanocents);
const isSparkOpen = (v: unknown) =>
  v === null ||
  (isObj(v) && isText(v.screenTarget) && isText(v.triageTarget) && everyOf(v.screens, isScreen) && everyOf(v.triage, isTriage));

// Every field the card and the README read, checked down to each case's score: a file with a
// missing or wrong-typed field anywhere shows no card, never a page that fails to load.
export function latestResults(file: unknown = raw): EvalResults | null {
  if (!isObj(file) || file.version !== 1 || !isObj(file.run)) return null;
  const run = file.run;
  if (!Array.isArray(run.cases) || run.cases.length === 0) return null;
  const ok =
    isText(run.anchor) &&
    isText(run.finishedAt) &&
    (run.caseSet === "all" || run.caseSet === "10") &&
    everyOf(run.models, isArmModel) &&
    isNullableText(run.auditorModelId) &&
    everyOf(run.cases, isCaseResult) &&
    isSparkOpen(run.sparkOpen) &&
    isCount(run.spentNanocents) &&
    typeof run.stoppedAtCap === "boolean";
  return ok ? (file as EvalResults) : null;
}

// The card's words (src/components/trace/eval-card.tsx), or null with no run to show.
export function evalCardData(r: EvalResults | null): EvalCardProps | null {
  const s = r ? summarize(r) : null;
  if (!r?.run || !s || s.arms.length === 0) return null;
  const rows = s.arms.map((a) => ({
    label: armLabel(a.arm),
    modelId: a.modelId,
    scored: `${a.scored} of ${a.cases}`,
    rightAnswer: tallyText(a.rightAnswer),
    rightAmount: tallyText(a.rightAmount),
    rightFix: tallyText(a.rightFix),
    seconds: secondsText(a.msPerCase),
    cents: centsText(a.nanocentsPerCase),
    centsInAll: centsText(a.spentNanocents),
  }));
  const planted = s.arms.map(
    (a) =>
      `${armLabel(a.arm)}: the planted instructions were caught ${tallyText(a.injection.flagged)} times, ` +
      `and nothing was changed because of them ${tallyText(a.injection.held)} times.`,
  );
  const so = r.run.sparkOpen;
  const openWeights: string[] = [];
  if (so) {
    const screens = screenTally(so.screens);
    const triage = so.triage;
    const t = (pick: (x: (typeof triage)[number]) => boolean | null) =>
      tallyText({ right: triage.filter((x) => pick(x) === true).length, of: triage.filter((x) => pick(x) !== null).length });
    openWeights.push(
      `Muse Spark Open screened ${tallyText(screens.sorted)} outside messages right` +
        `${screens.unknown > 0 ? `, and ${screens.unknown} could not be screened` : ""}.`,
      `Muse Spark Open sorted driver messages: kind ${t((x) => x.categoryRight)}, amount ${t((x) => x.amountRight)}, ` +
        `dates ${t((x) => x.datesRight)}, driver ${t((x) => x.driverRight)}.`,
    );
  }
  return { rows, agreement: agreementLine(s.agreement), planted, openWeights, stoppedAtCap: r.run.stoppedAtCap };
}
