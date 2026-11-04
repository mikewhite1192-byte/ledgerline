import { plainAnswer } from "../agent/operator/plain";
import { formatLocalDate } from "../format/dates";
import type { SweepRunView } from "./view";

// One line that says how the last pay check came out, in the office's words: no "sweep", no
// counters. Pure: every number comes from the run's own counts.

type Run = Pick<SweepRunView, "status" | "trigger" | "periodStart" | "periodEnd" | "counts">;

// "Oct 26" from "2026-10-26": the line already sits on this year's page.
function short(day: string): string {
  return formatLocalDate(day).replace(/, \d{4}$/, "");
}

function week(run: Run): string {
  try {
    return `the week of ${short(run.periodStart)} to ${short(run.periodEnd)}`;
  } catch {
    return "this week";
  }
}

const count = (n: number) => (Number.isInteger(n) && n > 0 ? n : 0);

function fixes(drafted: number): string {
  return drafted === 1 ? "drafted a fix for 1" : `drafted fixes for ${drafted}`;
}

// where "home": the first line of "What I did today", which says what was checked, then what it
// found. where "page": the pay check page's top line, which leads with what it found.
export function sweepOutcome(run: Run, where: "home" | "page"): string {
  const checked = `Checked every driver's pay for ${week(run)}.`;
  if (run.status === "running") return `Checking every driver's pay for ${week(run)} now.`;
  if (run.status === "failed") {
    return where === "home" ? "The pay check stopped before it finished." : "The last check stopped early. Run it again.";
  }
  const found = count(run.counts.found ?? 0);
  const drafted = count(run.counts.fixes_drafted ?? 0);
  if (found === 0) return `${checked} No mistakes.`;
  if (where === "home") {
    const mistakes = `Found ${found} ${found === 1 ? "mistake" : "mistakes"}`;
    return drafted > 0 ? `${checked} ${mistakes} and ${fixes(drafted)}.` : `${checked} ${mistakes}.`;
  }
  const needs = count(run.counts.needs_person ?? 0);
  let line = `Found ${found} pay ${found === 1 ? "mistake" : "mistakes"} before payday`;
  if (drafted > 0) line += ` and ${fixes(drafted)}`;
  if (run.trigger === "schedule") line += ", before anyone logged in";
  line += ".";
  if (needs > 0) line += ` ${needs} ${needs === 1 ? "needs" : "need"} you.`;
  return line;
}

// A fix card's "Why" as a person reads it. The explanation is model text, so code sets it right:
// dates as a month and day (the agent's own answer rule, src/lib/agent/operator/plain.ts), a week
// within one year said once ("Oct 26 to Nov 1, 2026"), and the item's driver code, as a whole
// token, replaced by the name already on the item. A name is never built: no name on the item, or
// the name already in the text, leaves the code as written.
const SAME_YEAR_RANGE = /\b([A-Z][a-z]{2} \d{1,2}), (\d{4}) to ([A-Z][a-z]{2} \d{1,2}), \2\b/g;

export function plainWhy(text: string, driver: { code: string | null; name: string | null }): string {
  let out = plainAnswer(text).replace(SAME_YEAR_RANGE, "$1 to $3, $2");
  const { code, name } = driver;
  if (code && name && !out.includes(name)) {
    // Each run of letters, digits and dashes is one token, compared whole against the code.
    out = out.replace(/[\w-]+/g, (token) => (token === code ? name : token));
  }
  return out;
}
