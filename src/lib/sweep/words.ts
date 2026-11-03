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
