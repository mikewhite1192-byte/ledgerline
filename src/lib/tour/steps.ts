import { NEEDS_YOU_ANCHOR, TODAY_ANCHOR } from "@/components/app/anchors";
import { ruleKindLabel } from "@/app/settings/autopilot/words";
import type { Role } from "@/lib/auth/role";
import { formatClock, formatInstant } from "@/lib/format/dates";
import { formatCents } from "@/lib/format/money";
import type { Payday } from "@/lib/home/cards";
import type { Loaded } from "@/lib/home/loaded";
import type { NeedsYouView } from "@/lib/home/needs-you";
import { localDateOf, type LocalDate } from "@/lib/time/local-date";
import type { AutopilotFacts, TourFacts } from "./facts";

// The walkthrough's steps, from the carrier's own numbers: code words around live figures, so they
// are always true and cost nothing. The first step carries the morning digest's stored line as it
// is. A figure that could not be read says so, never 0. A demo visitor's steps never tell them to
// approve anything: in the demo they ask and propose, and the carrier's staff decide.

export type TourStepId = "working" | "waiting" | "pay_week" | "autopilot" | "board" | "ask" | "feed";

// unread: the line says a read failed, so it shows as a notice, never as a figure.
export type TourLine = { text: string; unread?: true };

export type TourStep = {
  id: TourStepId;
  title: string;
  lines: TourLine[];
  link?: { href: string; label: string };
  // The question "Ask about this" puts in the agent's box; nothing is sent until the person sends it.
  ask: string;
};

export type TourInput = {
  role: Role;
  timezone: string;
  facts: TourFacts;
  needs: NeedsYouView;
  // null while the pay run's pages are off, so the pay week step is not shown.
  payday: Loaded<Payday> | null;
  // The first of the agent's suggested questions, for the last step's Ask.
  firstQuestion?: string;
  // The carrier's today, so a check-in from today reads as a time of day alone.
  today?: LocalDate;
  on: {
    activityFeed: boolean;
    adminAboveCents: number;
    judgeTurns: number;
    // The simple Home (flags.simpleShape): three steps, one per block on Home.
    simpleShape?: boolean;
  };
};

export const TOUR_FOOTER = "Written from today's numbers.";

export const TOUR_ASKS: Readonly<Record<Exclude<TourStepId, "ask">, string>> = {
  working: "What has the desk done for us today?",
  waiting: "What is waiting for a person, and why?",
  pay_week: "Who has a problem on this week's paystub?",
  autopilot: "What can the autopilot do on its own?",
  board: "What changed on our loads today?",
  feed: "What money moved today?",
};
const ASK_FALLBACK = "What needs a look today?";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const unread = (text: string): TourLine => ({ text, unread: true });
const line = (text: string): TourLine => ({ text });

// "Last checked the books at 9:00 AM": the time alone when the check-in was today.
function checkedWhen(checkedAt: string, i: TourInput): string {
  try {
    if (i.today !== undefined && localDateOf(checkedAt, i.timezone) === i.today) return `at ${formatClock(checkedAt, i.timezone)}`;
  } catch {
    // An instant that does not read falls through to the full form, which throws the same way.
  }
  return `on ${formatInstant(checkedAt, i.timezone)}`;
}

function simpleWorking(i: TourInput): TourLine[] {
  const { desk } = i.facts;
  if (!desk.ok) return [unread("Could not read when I last checked the books.")];
  if (desk.value.checkedAt === null) return [line("Not checked yet today.")];
  return [
    line(
      `Last checked the books ${checkedWhen(desk.value.checkedAt, i)} and finished ` +
        `${plural(desk.value.doneToday, "thing", "things")} today.`,
    ),
  ];
}

function workingLines(i: TourInput): TourLine[] {
  if (i.on.simpleShape === true) return simpleWorking(i);
  const lines: TourLine[] = [];
  const { digest, desk } = i.facts;
  if (!digest.ok) lines.push(unread("Could not read the agent's latest morning line."));
  else if (digest.value !== null) lines.push(line(digest.value));
  if (!desk.ok) lines.push(unread("Could not read when the desk last checked in."));
  else if (desk.value.checkedAt === null) lines.push(line("The desk has not checked in yet."));
  else {
    lines.push(
      line(
        `The desk last checked in ${formatInstant(desk.value.checkedAt, i.timezone)} and finished ` +
          `${plural(desk.value.doneToday, "thing", "things")} today.`,
      ),
    );
  }
  return lines;
}

function working(i: TourInput): TourStep {
  const lines = workingLines(i);
  return {
    id: "working",
    title: "Your AI accountant is already working",
    lines,
    link: i.on.activityFeed
      ? { href: "/activity", label: "Open the live feed" }
      : { href: `#${TODAY_ANCHOR}`, label: "See today" },
    ask: TOUR_ASKS.working,
  };
}

function waiting(i: TourInput): TourStep {
  const judge = i.role === "judge";
  const how = judge
    ? "Open a card and read why the agent proposed it. In this demo you can ask and propose; the carrier's staff make the call."
    : "Open a card, read why, then approve or reject it.";
  const base = { id: "waiting" as const, link: { href: `#${NEEDS_YOU_ANCHOR}`, label: "Go to Needs you" }, ask: TOUR_ASKS.waiting };
  if (i.needs.unread) {
    return { ...base, title: "Waiting for a person", lines: [unread("Could not read everything that is waiting right now."), line(how)] };
  }
  const n = i.needs.rows.reduce((s, r) => s + r.count, 0);
  if (n === 0) {
    return {
      ...base,
      title: "Waiting for a person: nothing right now",
      lines: [line("New cards show up in Needs you as the desk and the agent find work.")],
    };
  }
  const atLeast = i.needs.rows.some((r) => r.atLeast);
  const lines: TourLine[] = [];
  // The rows' own words name approval, so only the carrier's people read them here.
  if (!judge) {
    for (const r of i.needs.rows) {
      const amounts = r.amounts.map((a) => `${r.atLeast ? "at least " : ""}${formatCents(a.cents)} ${a.label}`);
      lines.push(line([`${r.count.toLocaleString("en-US")}${r.atLeast ? " or more" : ""} ${r.what}`, ...amounts].join(", ")));
    }
  }
  lines.push(line(how));
  if (i.role === "staff") lines.push(line(`Amounts above ${formatCents(i.on.adminAboveCents)} need an admin.`));
  return {
    ...base,
    title: `Waiting for a person: ${n.toLocaleString("en-US")}${atLeast ? " or more" : ""} ${n === 1 ? "item" : "items"}`,
    lines,
  };
}

function payWeek(i: TourInput, payday: Loaded<Payday>): TourStep {
  const base = { id: "pay_week" as const, link: { href: "/settlements", label: "Open Pay" }, ask: TOUR_ASKS.pay_week };
  if (!payday.ok) return { ...base, title: "Paystubs this week", lines: [unread("Could not read this week's paystubs.")] };
  const p = payday.value;
  if (p.period === null) {
    return { ...base, title: "Paystubs this week", lines: [line("No pay week is open yet. The sweep opens one each week.")] };
  }
  return {
    ...base,
    title: `Paystubs this week: ${plural(p.paystubs, "paystub", "paystubs")}, ${formatCents(p.netCents)}`,
    lines: [
      line(`Every line is worked out by ${i.role === "judge" ? "the carrier's" : "your"} pay rules in whole cents, never by the model.`),
      line(
        p.problems === 0
          ? "None is flagged with a problem."
          : `${plural(p.problems, "paystub has", "paystubs have")} a problem worth a look before Friday.`,
      ),
    ],
  };
}

function autopilot(i: TourInput, facts: Loaded<AutopilotFacts>): TourStep {
  const base = { id: "autopilot" as const, link: { href: "/settings/autopilot", label: "Open autopilot rules" }, ask: TOUR_ASKS.autopilot };
  const who =
    i.role === "admin"
      ? "You can change a limit or pause it all in Settings."
      : i.role === "staff"
        ? "You can pause it in Settings; only an admin changes a rule."
        : "Read the rules; only the carrier's admin can change them.";
  if (!facts.ok) return { ...base, title: "Autopilot rules", lines: [unread("Could not read the autopilot rules."), line(who)] };
  const a = facts.value;
  const state = !a.on
    ? "The autopilot is off. A person decides everything."
    : a.paused
      ? `${a.pausedAt ? `Paused since ${formatInstant(a.pausedAt, i.timezone)}` : "Paused"}. A person decides everything until it resumes.`
      : a.auto.length === 0
        ? "Nothing is on Auto. A person decides everything."
        : `On Auto within limits: ${a.auto.map((k) => `${ruleKindLabel(k.kind)} up to ${formatCents(k.maxCents)} each`).join("; ")}. ` +
          "Everything else waits for a person or is off.";
  return { ...base, title: "Autopilot rules", lines: [line(state), line(who)] };
}

function board(facts: Loaded<number | null>): TourStep | null {
  const base = {
    id: "board" as const,
    title: "The dispatch board",
    link: { href: "/tms-demo", label: "Open the dispatch board" },
    ask: TOUR_ASKS.board,
  };
  if (!facts.ok) return { ...base, lines: [unread("Could not read the dispatch board.")] };
  if (facts.value === null) return null;
  return {
    ...base,
    lines: [line(`${plural(facts.value, "load", "loads")} on the board. Move one and watch the desk pick it up.`)],
  };
}

function ask(i: TourInput): TourStep {
  const lines: TourLine[] =
    i.role === "judge"
      ? [
          line("Ask in plain English. Every number comes from the carrier's pay rules, and anything it drafts waits for the carrier's staff."),
          line(`This visit has ${plural(i.on.judgeTurns, "question", "questions")}.`),
        ]
      : [line("Ask in plain English. Every number comes from your pay rules, and anything it drafts waits for your approval.")];
  return { id: "ask", title: "Ask the agent", lines, ask: i.firstQuestion ?? ASK_FALLBACK };
}

const feed = (): TourStep => ({
  id: "feed",
  title: "The live feed",
  lines: [line("Every money step the agent, the desk, the autopilot and people take, in plain English, as it happens.")],
  link: { href: "/activity", label: "Open the live feed" },
  ask: TOUR_ASKS.feed,
});

// The steps in order; a step whose page or switch is off is left out.
// Under the simple Home, one step per block on Home: what was done, what waits, and the ask box.
export function tourSteps(i: TourInput): TourStep[] {
  if (i.on.simpleShape === true) return [working(i), waiting(i), ask(i)];
  const out: (TourStep | null)[] = [
    working(i),
    waiting(i),
    i.payday ? payWeek(i, i.payday) : null,
    i.facts.autopilot ? autopilot(i, i.facts.autopilot) : null,
    i.facts.board ? board(i.facts.board) : null,
    ask(i),
    i.on.activityFeed ? feed() : null,
  ];
  return out.filter((s) => s !== null);
}

