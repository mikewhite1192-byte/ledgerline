import Link from "next/link";
import { NEEDS_YOU_ANCHOR } from "@/components/app/anchors";
import { Mark } from "@/components/brand/mark";
import { Card } from "@/components/ui/card";
import { formatLocalDate } from "@/lib/format/dates";
import type { Loaded } from "@/lib/home/loaded";
import type { NeedsYouView } from "@/lib/home/needs-you";
import type { TodayIntake } from "@/lib/home/today";
import type { SweepRunView } from "@/lib/sweep/view";
import { localDateOf, type LocalDate } from "@/lib/time/local-date";
import { Unavailable } from "./home-card";

const LINK = "text-small text-link underline-offset-4 hover:underline";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// "3 documents, 1 voice note and 2 driver messages", from the kinds whose pages are on.
function cameIn(intake: TodayIntake, shown: TodayCardProps["shown"]): string {
  const parts = [
    shown.documents ? plural(intake.documents, "document", "documents") : null,
    shown.voiceNotes ? plural(intake.voiceNotes, "voice note", "voice notes") : null,
    shown.messages ? plural(intake.messages, "driver message", "driver messages") : null,
  ].filter((p) => p !== null);
  const total = (shown.documents ? intake.documents : 0) + (shown.voiceNotes ? intake.voiceNotes : 0) +
    (shown.messages ? intake.messages : 0);
  if (total === 0) return "Nothing yet today.";
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `${list} today.`;
}

// The run's carrier-local start day, or null when its time does not read.
function sweptOn(run: SweepRunView, timezone: string): LocalDate | null {
  try {
    return localDateOf(run.startedAt, timezone);
  } catch {
    return null;
  }
}

function sweepLine(run: SweepRunView, today: LocalDate, timezone: string): string {
  if (run.status === "running") return "A sweep of the books is running now.";
  if (run.status === "failed") return "The last sweep stopped before it finished.";
  const found = run.counts.found ?? 0;
  const drafted = run.counts.fixes_drafted ?? 0;
  const what = `found ${plural(found, "problem", "problems")}, drafted ${plural(drafted, "fix", "fixes")}, ${run.approved.toLocaleString("en-US")} approved.`;
  const day = sweptOn(run, timezone);
  if (day === today) return `Swept the books today: ${what}`;
  return day ? `Last sweep, ${formatLocalDate(day)}: ${what}` : `Last sweep: ${what}`;
}

type TodayCardProps = {
  // null while every kind of intake is switched off.
  intake: Loaded<TodayIntake> | null;
  shown: { documents: boolean; voiceNotes: boolean; messages: boolean };
  // null while the sweep is switched off; a value of null means no sweep has run.
  sweep: Loaded<SweepRunView | null> | null;
  needs: NeedsYouView;
  today: LocalDate;
  timezone: string;
};

// The first card on Home: what came in today, what the agent did with it, and what is waiting on
// a person. Fixed lines from the database, no model call on render. No amounts: the figures to
// approve sit in Needs you beside it.
export function TodayCard({ intake, shown, sweep, needs, today, timezone }: TodayCardProps) {
  const waiting = needs.rows.reduce((s, r) => s + r.count, 0);
  const atLeast = needs.rows.some((r) => r.atLeast);
  return (
    <section aria-labelledby="today-title" className="min-w-0">
      <Card className="h-full border-l-4 border-l-primary">
        <div className="flex items-center gap-2.5 px-4 pt-4 sm:px-5">
          <Mark size={24} />
          <h2 id="today-title" className="text-h3 text-foreground">
            Today
          </h2>
        </div>
        <dl className="grid gap-3 px-4 pt-3 pb-4 sm:px-5">
          {intake ? (
            <div className="grid gap-0.5">
              <dt className="text-small text-foreground-2">Came in</dt>
              <dd className="text-body text-foreground">
                {intake.ok ? cameIn(intake.value, shown) : <Unavailable>Could not read what came in today.</Unavailable>}
              </dd>
            </div>
          ) : null}
          {sweep ? (
            <div className="grid gap-0.5">
              <dt className="text-small text-foreground-2">Did</dt>
              <dd className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-body text-foreground">
                {!sweep.ok ? (
                  <Unavailable>Could not read the last sweep.</Unavailable>
                ) : sweep.value === null ? (
                  <span>No sweep of the books has run yet.</span>
                ) : (
                  <>
                    <span>{sweepLine(sweep.value, today, timezone)}</span>
                    <Link href={`/sweep/${sweep.value.id}`} className={LINK}>
                      Open the sweep
                    </Link>
                  </>
                )}
              </dd>
            </div>
          ) : null}
          <div className="grid gap-0.5">
            <dt className="text-small text-foreground-2">Needs your OK</dt>
            <dd className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-body text-foreground">
              {needs.unread ? (
                <Unavailable>Could not check everything that is waiting on you.</Unavailable>
              ) : waiting === 0 ? (
                <span>Nothing needs your OK right now.</span>
              ) : (
                <>
                  <span>
                    {atLeast ? `${plural(waiting, "item", "items")} or more` : plural(waiting, "item", "items")} waiting
                    for your OK.
                  </span>
                  <a href={`#${NEEDS_YOU_ANCHOR}`} className={LINK}>
                    See what needs you
                  </a>
                </>
              )}
            </dd>
          </div>
        </dl>
      </Card>
    </section>
  );
}
