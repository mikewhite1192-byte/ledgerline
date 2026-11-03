import Link from "next/link";
import { Activity } from "lucide-react";
import { flags } from "@/config/flags";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { EmptyState, FeatureOff } from "@/components/app/states";
import { FeedList } from "@/components/feed/feed-list";
import { LiveRefresh } from "@/components/feed/live-refresh";
import { Card } from "@/components/ui/card";
import { DbError } from "@/lib/db";
import { formatInstant } from "@/lib/format/dates";
import { cursorParam, parseCursor, readFeed, readFeedHeader, type FeedCursor, type FeedHeader } from "@/lib/feed/read";
import { feedLines, type FeedLine } from "@/lib/feed/words";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

type Feed = { lines: FeedLine[]; next: FeedCursor | null; header: FeedHeader };
type View = { shell: ShellTenant; feed: Feed | null };

const LINK = "text-small text-link underline-offset-4 hover:underline";

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
      return { shell, feed: { lines: feedLines(page.rows, shell.timezone), next: page.next, header } };
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
        description="Every step the agent, the desk, the autopilot and people take with money, newest first. Read only."
        actions={feed && first ? <LiveRefresh pollSeconds={flags.activityFeed.pollSeconds} /> : undefined}
      />
      {!feed ? (
        <Card>
          <FeatureOff name="Live feed" />
        </Card>
      ) : (
        <>
          <p className="text-small text-foreground-2">
            {feed.header.deskCheckedAt
              ? `The desk last checked in ${formatInstant(feed.header.deskCheckedAt, view.shell.timezone)}.`
              : "The desk has not checked in yet."}
            {feed.header.paused ? " The autopilot is paused." : ""}
          </p>
          <Card className="px-4 sm:px-5">
            {feed.lines.length === 0 ? (
              <EmptyState
                icon={<Activity aria-hidden />}
                title={first ? "Nothing has happened with money yet." : "No older lines."}
                body={first ? "A step the agent, the desk, the autopilot or a person takes shows here as it happens." : undefined}
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
