import { traceLines, type TraceLine } from "@/lib/trace/format";
import type { TurnTrace } from "@/lib/trace/types";

// The plain trace's rows (flags.plainTrace): the steps that read or saved something, each with the
// records it read, and one line for the second check. A model's own steps leave the list (they
// name a model and carry its time and cost), except one that failed, which says so in plain words.
// No row carries a model name, a time or a cost. Pure: the same rows the full trace builds.

const AUDITOR_KEY = /^proposal:[^:]+:auditor$/;

const SECOND_CHECK: Readonly<Record<string, string>> = {
  Passed: "Second check agreed.",
  Concerns: "Second check had concerns.",
  "Did not pass": "Second check did not agree.",
};

// The panel's one line when no step read or saved anything (an answer from the records summary).
export const PLAIN_ANSWERED = "Answered from your records, with no other steps.";

const FAILED_STEP = "One step did not finish.";

function secondCheck(line: TraceLine): string {
  const label = line.badge?.label;
  if (label !== undefined && Object.hasOwn(SECOND_CHECK, label)) return SECOND_CHECK[label];
  return line.text === "Could not decide" ? "Second check could not decide." : "Second check has not finished yet.";
}

export function plainLines(trace: TurnTrace, proposalId?: string): TraceLine[] {
  const kinds = new Map(trace.steps.map((s) => [`step:${s.seq}`, s.kind]));
  return traceLines(trace, proposalId).flatMap((line): TraceLine[] => {
    const bare: TraceLine = { key: line.key, who: "", meta: [], text: line.text, badge: line.badge, refs: line.refs };
    if (AUDITOR_KEY.test(line.key)) return [{ ...bare, text: secondCheck(line), badge: null }];
    const failed = line.badge?.tone === "destructive";
    // A model call outside the steps (a screening): only a flagged or failed one says anything.
    if (line.key.startsWith("call:")) {
      if (failed) return [{ ...bare, text: FAILED_STEP }];
      return line.badge ? [bare] : [];
    }
    const kind = kinds.get(line.key);
    if (kind === "model" || kind === "escalation") return failed ? [{ ...bare, text: FAILED_STEP }] : [];
    return [bare];
  });
}
