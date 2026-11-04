import Link from "next/link";
import { Activity } from "lucide-react";
import { flags } from "@/config/flags";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { EmptyState, FeatureOff } from "@/components/app/states";
import { FeedList } from "@/components/feed/feed-list";
import { LiveRefresh } from "@/components/feed/live-refresh";
import { Card } from "@/components/ui/card";
import { DbError, type Queryable } from "@/lib/db";
import { formatInstant } from "@/lib/format/dates";
import { cursorParam, parseCursor, readFeed, readFeedHeader, type FeedCursor, type FeedHeader } from "@/lib/feed/read";
import { feedLines, type FeedLine } from "@/lib/feed/words";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

// The newest pay check: running, or when it finished. null when none has run or the sweep is off.
type PayCheck = { running: boolean; finishedAt: string | null };
type Feed = { lines: FeedLine[]; next: FeedCursor | null; header: FeedHeader; payCheck: PayCheck | null };
type View = { shell: ShellTenant; feed: Feed | null };

const LINK = "text-small text-link underline-offset-4 hover:underline";

async function readPayCheck(q: Queryable): Promise<PayCheck | null> {
  if (!flags.sweepEnabled) return null;
  const rows = await q.query<{ status: string; finished_at: string | null }>(
    `SELECT status, to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at
       FROM sweep_runs ORDER BY started_at DESC, id LIMIT 1`,
  );
  const run = rows[0];
  if (!run) return null;
  return { running: run.status === "running", finishedAt: run.status === "done" ? run.finished_at : null };
}

// The line over the feed: when the desk last checked the books, else what the pay check is doing
// or when it finished, so a page open during a pay check never says nothing has been checked.
function checkedLine(feed: Feed, timeZone: string): string {
  if (feed.header.deskCheckedAt) return `Last checked the books at ${formatInstant(feed.header.deskCheckedAt, timeZone)}.`;
  if (feed.payCheck?.running) return "Checking every driver's pay now.";
  if (feed.payCheck?.finishedAt) return `Checked every driver's pay at ${formatInstant(feed.payCheck.finishedAt, timeZone)}.`;
  return "Has not checked the books yet.";
}

// The live feed: every step the agent, the desk, the autopilot and people took with money, newest
// first, read from the records those steps already leave. Read only: nothing here writes. The
// first page reads itself again every few seconds while it is open; ?before= pages back through
// older lines. The switch off shows the off state and reads nothing else.
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const before = parseCursor((await searchParams).before);
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      if (!flags.activityFeed.enabled) return { shell, feed: null };
      const page = await readFeed(q, { limit: flags.activityFeed.pageSize, before });
      const header = await readFeedHeader(q, Date.now());
      const payCheck = await readPayCheck(q);
      return { shell, feed: { lines: feedLines(page.rows, shell.timezone), next: page.next, header, payCheck } };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    // A failed read or a row that does not read: the feed cannot be shown, never shown as quiet.
    else if (err instanceof DbError || err instanceof RangeError) problem = "unreadable";
    else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const feed = view.feed;
  const first = before === null;

  return (
    <SignedInPage tenant={view.shell} current="/activity" title="Live feed">
      <PageHeader
        title="Live feed"
        description="Everything done with money, newest first. Read only."
        actions={feed && first ? <LiveRefresh pollSeconds={flags.activityFeed.pollSeconds} /> : undefined}
      />
      {!feed ? (
        <Card>
          <FeatureOff name="Live feed" />
        </Card>
      ) : (
        <>
          <p className="text-small text-foreground-2">
            {checkedLine(feed, view.shell.timezone)}
            {feed.header.paused ? " The autopilot is paused." : ""}
          </p>
          <Card className="px-4 sm:px-5">
            {feed.lines.length === 0 ? (
              <EmptyState
                icon={<Activity aria-hidden />}
                title={
                  !first
                    ? "No older lines."
                    : feed.payCheck?.running
                      ? "Checking every driver's pay now."
                      : "Nothing has happened with money yet."
                }
                body={
                  !first
                    ? undefined
                    : feed.payCheck?.running
                      ? "Each fix it drafts shows here as it happens."
                      : "A step the agent, the desk, the autopilot or a person takes shows here as it happens."
                }
              />
            ) : (
              <FeedList lines={feed.lines} markNew={first} />
            )}
          </Card>
          <div className="flex flex-wrap gap-4">
            {!first ? (
              <Link href="/activity" className={LINK}>
                Newest
              </Link>
            ) : null}
            {feed.next ? (
              <Link href={`/activity?before=${encodeURIComponent(cursorParam(feed.next))}`} className={LINK}>
                Older
              </Link>
            ) : null}
          </div>
        </>
      )}
    </SignedInPage>
  );
}
