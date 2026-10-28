import { reasonSentence } from "../agent/reasons";
import { formatLocalDate } from "../format/dates";
import { formatCents } from "../format/money";
import { addDays, dayOfWeek, localDateOf, periodContaining, type LocalDate } from "../time/local-date";
import type { RuleChangeRefusal } from "./change";
import { labelFor, RULES, shortValue, unitSuffix, type RuleKey, type RuleValue } from "./rules";

// Every word the screen and the chat say about a pay rule change. Fixed text only: no sentence
// here is ever written by a model, and the figures come from the engine's stored numbers. Pure,
// so the card mapper (client) and the tools (server) share it.

// The one question back when a sentence cannot become a change, per refusal. The model passes it
// on as written and asks nothing else.
export const REFUSAL_LINES: Readonly<Record<RuleChangeRefusal, string>> = {
  unknown_rule:
    "Which rule do you mean? I can change: insurance per day, who pays insurance, escrow target, escrow per week, the net pay floor, advance fee, advance limit, advance cap, the share of pay an advance may take, the smallest advance, empty miles paid, the drivers' share of extra charges, and what the percentage is paid on.",
  bad_value: "What should it change to? I did not see that amount in your message.",
  value_not_in_message: "What should it change to? I did not see that amount in your message.",
  value_out_of_range: "That amount is outside what this rule allows. What should it change to?",
  bad_date: "When should it start? Give me a date.",
  effective_in_past: "That date is already past or in the current week; pay rules start with a future week.",
  too_far_ahead: "That date is more than a year away. When should it start? Pick a date within the next year.",
  later_version:
    "A later change to the pay rules is already saved, so this one would be undone when it starts. When should it start? Pick a date on or after the last saved change.",
  no_change: "That is the same as today's rule, so nothing to change.",
  escrow_on_driver_schedules: reasonSentence("escrow_on_driver_schedules"),
  locked_version: "Pay for that week is already approved, so its rules cannot change. When should it start? Pick a later week.",
  no_pay_config: "The pay rules for that date could not be read. Nothing was changed.",
  week_shape: "The pay rules for that date could not be read. Nothing was changed.",
};

// What the model is told for a refusal: the category and the line to pass on.
export function refusalLine(category: RuleChangeRefusal): string {
  return REFUSAL_LINES[category];
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// "2026-11-02" is "Nov 2": the year is left out, as the card says a date this close.
export function monthDay(date: LocalDate): string {
  return formatLocalDate(date).replace(/, \d{4}$/, "");
}

// "Oct 19 to 25" in one month, "Oct 26 to Nov 1" across two.
export function shortPeriod(start: LocalDate, end: LocalDate): string {
  const a = monthDay(start);
  const b = monthDay(end);
  return a.split(" ")[0] === b.split(" ")[0] ? `${a} to ${b.split(" ")[1]}` : `${a} to ${b}`;
}

// The card's title: "Owner-operator insurance: $11.00 to $12.00 per day".
export function ruleTitle(c: {
  ruleKey: RuleKey;
  oldValue: RuleValue;
  newValue: RuleValue;
  appliesTo: string;
}): string {
  const spec = RULES[c.ruleKey];
  const numeric = typeof c.oldValue === "number" && typeof c.newValue === "number";
  const suffix = numeric ? unitSuffix(spec) : "";
  return `${labelFor(c.ruleKey, c.appliesTo)}: ${shortValue(spec, c.oldValue)} to ${shortValue(spec, c.newValue)}${suffix}`;
}

// Line 1: "Starts Monday, Nov 2", or when the asked date fell inside a week, why it moved.
export function startsLine(c: { effectiveFrom: LocalDate; askedFrom: LocalDate; snapped: boolean }): string {
  const starts = `Starts ${WEEKDAYS[dayOfWeek(c.effectiveFrom)]}, ${monthDay(c.effectiveFrom)}`;
  if (!c.snapped) return starts;
  return `${starts} (the week of ${monthDay(c.askedFrom)} had already begun, so the change starts with the next full week)`;
}

export type ImpactWords = {
  basis: "settled_week" | "no_settled_week" | "advances_only";
  periodStart: LocalDate | null;
  periodEnd: LocalDate | null;
  driversChanged: number;
  netDeltaCents: number;
  ownerOperatorsOnly: boolean;
  top: readonly { code: string; deltaCents: number }[];
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Line 2: what the change would have done to last week's pay, from the engine's figures.
export function impactLine(i: ImpactWords): string {
  if (i.basis === "advances_only") return "This changes what drivers may borrow; last week's pay is unchanged.";
  if (i.basis === "no_settled_week" || i.periodStart === null || i.periodEnd === null) {
    return "No week has been paid yet, so there is no past pay to compare this with.";
  }
  const week = `On last week's pay (${shortPeriod(i.periodStart, i.periodEnd)})`;
  if (i.driversChanged === 0) {
    return `${week} this would not have changed anyone's pay.`;
  }
  const who = i.ownerOperatorsOnly
    ? plural(i.driversChanged, "owner-operator", "owner-operators")
    : plural(i.driversChanged, "driver", "drivers");
  const total =
    i.netDeltaCents === 0
      ? "the same in total"
      : `${formatCents(Math.abs(i.netDeltaCents))} ${i.netDeltaCents > 0 ? "more" : "less"} in total`;
  const top = i.top[0];
  const largest = top ? `; the largest change is ${formatCents(Math.abs(top.deltaCents))} (Driver ${top.code})` : "";
  return `${week} this would have paid ${who} ${total}${largest}.`;
}

// The amount line above the figure.
export function impactLabel(netDeltaCents: number): string {
  if (netDeltaCents > 0) return "Would pay out more per week";
  if (netDeltaCents < 0) return "Would pay out less per week";
  return "No change to weekly pay";
}

// Line 3, the double-check, by the auditor's state.
export const AUDIT_LINES = {
  pass: "Double-checked: the numbers match.",
  checking: "Double-check still running",
  block:
    "Double-check found a difference; this change cannot be saved. Nothing was changed or sent. Ask again and the numbers are sized fresh.",
  concerns: "Double-check raised a question. Read it before you save.",
  unknown: "Not double-checked yet.",
  budget: "Not double-checked: the checking budget is used up.",
  off: "Not double-checked: the double-check is switched off.",
} as const;

// What the chat says under a card when a save does not go through, per refusal category. A
// category with an empty line says nothing more: the card's own line already says it (a change
// that went stale reads FAILED_LINE).
export const SAVE_NOTICES: Readonly<Record<string, string>> = {
  not_executable: "Pay rule changes are switched off right now. Nothing changed.",
  already_decided: "This change was already saved or set aside.",
  expired: "This change waited too long and expired. Ask again for a fresh one.",
  role: "Only an admin can save a change this size. Nothing changed.",
  auditor_required: "This waits for the double-check before anyone can save it.",
  not_auditable: "This change was sized before the double-check started. Ask again for a fresh one.",
  override_required:
    "Double-check found a difference; this change cannot be saved. Nothing was changed or sent. Ask again and the numbers are sized fresh.",
  stale: "",
  bad_request: "The save did not go through. Nothing changed.",
  needs_confirm: "Confirm on the card first.",
  not_found: "That change is not here.",
  // The reply was lost after the request went out: the save may have run. The card reads back.
  unknown: "The answer to the save did not come back. The card shows whether it was saved.",
};
export const SAVE_FAILED = "The save did not go through. Nothing changed.";
export const NOT_NOW_FAILED = "That did not go through. Try again.";

// Line 4, on every card.
export const NOTHING_CHANGES = "Nothing changes until you save it. Past weeks never change.";

// The second question before a save, when the double-check did not pass or the message behind it
// was flagged.
export const CONCERNS_QUESTION = "Double-check raised a question. Save this pay rule anyway?";
export const UNCHECKED_QUESTION = "Not double-checked. Save this pay rule anyway?";
export const FLAGGED_QUESTION = "This came from a message that failed screening. Save this pay rule anyway?";

// While a save runs, or after a stop before it finished (Resume picks it up).
export const SAVING_LINE = "Saving now.";

export const SAVE_LABEL = "Save this pay rule";
export const SAVING_LABEL = "Saving";
export const SAVE_QUESTION = "Save this pay rule?";
export const NOT_NOW_LABEL = "Not now";

// The main button for a person below the admin amount: "Ask an admin to save this (over $2,000
// a week)". Whole dollars when the amount is.
export function adminOnlyLabel(adminAboveCents: number): string {
  const amount = formatCents(adminAboveCents).replace(/\.00$/, "");
  return `Ask an admin to save this (over ${amount} a week)`;
}

export function savedLine(effectiveFrom: LocalDate): string {
  return `Saved. Starts with the week of ${monthDay(effectiveFrom)}. See it under Pay rules.`;
}

export const SAVED_LINK = "Pay rules";
export const PAY_RULES_PATH = "/settings/pay-rules";

export const FAILED_LINE =
  "This change could not be saved because the rules moved since it was sized (for example, another change was saved first). Nothing was changed. Ask again and it is sized fresh.";

export const REJECTED_LINE = "Not saved. Nothing changed.";

// The home chip and the help under the question box when it is used. The example names a rule a
// carrier can change while its drivers' escrow schedules run (escrow per week cannot), dated the
// first week a change can start, like the chip's sentence, so it never names a week that has begun.
export const CHIP_LABEL = "Change a pay rule";

export function helpExample(nextStart: LocalDate): string {
  return `From ${monthDay(nextStart)}, the net pay floor is $350 a week.`;
}

export function composerHelp(nextStart: LocalDate): string {
  return `Say the rule, the new amount and the date it starts. Example: '${helpExample(nextStart)}'`;
}

// The first week start after the week that holds now, in the carrier's zone and week shape: the
// earliest date a change may start.
export function nextWeekStart(now: Date, timeZone: string, weekStartDow: number): LocalDate {
  const today = localDateOf(now.toISOString(), timeZone);
  return addDays(periodContaining(today, weekStartDow).start, 7);
}

// The sentence the chip puts in the box, dated the first week a change can start, so it never
// asks for a week that has begun.
export function exampleSentence(nextStart: LocalDate): string {
  return `Starting ${monthDay(nextStart)}, owner-operator insurance goes to $12 a day`;
}

// The Pay rules page.
export const PAGE_TITLE = "Pay rules";
export const PAGE_SUBTITLE =
  "What the carrier pays and deducts, by the week it started. Past weeks keep the rules they were paid under.";
export const VERSIONS_TITLE = "Rules by start date";
// Only the rules a sentence can change are listed, so the title says so.
export const IN_FORCE_TITLE = "Rules you can change, in force this week";
export const WAITING_TITLE = "Waiting for you";
// The empty and error states show their sentences as a title and the rest below it.
export const WAITING_EMPTY_TITLE = "No changes waiting.";
export const WAITING_EMPTY_BODY = "When you ask the agent to change a rule, it appears here for you to save.";
export const WAITING_EMPTY = `${WAITING_EMPTY_TITLE} ${WAITING_EMPTY_BODY}`;
export const SWITCHED_OFF =
  "Pay rule changes are switched off for this carrier. Rules still apply as listed. Turn them on in release settings.";
export const LOAD_FAILED_TITLE = "The rules could not be loaded.";
export const LOAD_FAILED_BODY = "Nothing was changed. Reload the page; if it keeps happening, tell the owner.";
export const LOAD_FAILED = `${LOAD_FAILED_TITLE} ${LOAD_FAILED_BODY}`;
export const STARTING_RULES = "Starting rules";
// A version a later one replaced before its first week began: it never ran.
export const NEVER_RAN = "Never ran: replaced before its first week";
export const CURRENT_BADGE = "Current";

// Who set a version, by its source.
export const SET_BY: Readonly<Record<string, string>> = {
  seed: "Starting rules",
  ui: "In the app",
  proposal: "Saved from a chat",
};

// The paystub's line: "Paid under rules from Oct 19".
export function paidUnderLine(effectiveFrom: LocalDate): string {
  return `Paid under rules from ${monthDay(effectiveFrom)}`;
}
