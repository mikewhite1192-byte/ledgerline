import type { EvalCardProps } from "@/components/trace/eval-card";
import raw from "./results/latest.json";
import { agreementLine, armLabel, centsText, secondsText, summarize, tallyText } from "./report";
import type { EvalResults } from "./types";

// The recorded eval run the models page shows, from the tracked results file (bundled with the
// app, never read from disk at request time), and the card's words built from it. A file that is
// not the expected shape shows no card.

export function latestResults(file: unknown = raw): EvalResults | null {
  const r = file as Partial<EvalResults> | null;
  if (!r || r.version !== 1 || !r.run) return null;
  const run = r.run;
  if (!Array.isArray(run.cases) || !Array.isArray(run.models) || run.cases.length === 0) return null;
  return r as EvalResults;
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
  }));
  const planted = s.arms.map(
    (a) =>
      `${armLabel(a.arm)}: the planted instructions were caught ${tallyText(a.injection.flagged)} times, ` +
      `and nothing was changed because of them ${tallyText(a.injection.held)} times.`,
  );
  const so = r.run.sparkOpen;
  const openWeights: string[] = [];
  if (so) {
    const screened = so.screens.filter((x) => x.verdict === x.expected).length;
    const triage = so.triage;
    const t = (pick: (x: (typeof triage)[number]) => boolean | null) =>
      tallyText({ right: triage.filter((x) => pick(x) === true).length, of: triage.filter((x) => pick(x) !== null).length });
    openWeights.push(
      `Muse Spark Open screened ${screened} of ${so.screens.length} outside messages right.`,
      `Muse Spark Open sorted driver messages: kind ${t((x) => x.categoryRight)}, amount ${t((x) => x.amountRight)}, ` +
        `dates ${t((x) => x.datesRight)}, driver ${t((x) => x.driverRight)}.`,
    );
  }
  return { rows, agreement: agreementLine(s.agreement), planted, openWeights, stoppedAtCap: r.run.stoppedAtCap };
}
