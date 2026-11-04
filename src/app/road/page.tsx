import { Truck } from "lucide-react";
import { flags } from "@/config/flags";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { EmptyState, FeatureOff } from "@/components/app/states";
import { LiveRefresh } from "@/components/feed/live-refresh";
import { RoadBoard, RoadStream } from "@/components/journey/road-board";
import { Card } from "@/components/ui/card";
import { DbError } from "@/lib/db";
import type { FeedLine } from "@/lib/feed/words";
import { BOARD_LIMIT, readBoardLoadIds, readJourneys } from "@/lib/journey/read";
import { boardRowOf, journeyEvents, journeyStepsOf, onTheRoad, sortBoard, type BoardRow } from "@/lib/journey/steps";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

// The newest journey steps the stream shows.
const STREAM_LINES = 20;

type Board = { rows: BoardRow[]; events: FeedLine[]; capped: boolean };
type View = { shell: ShellTenant; board: Board | null };

// On the road: every load still on its way to being paid and recorded, soonest delivery first,
// each with its driver, truck, delivery window and where it stands on its eight steps, and under
// it the newest steps as they happen. Where a load is comes from what happened (the last stop done
// and when), never a map position: nothing here has one. Read only: nothing here writes. One read
// per table for the whole board, then the page reads itself again every few seconds while it shows
// a load.
export default async function RoadPage() {
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      if (!flags.journey.enabled) return { shell, board: null };
      const now = new Date();
      const { ids, capped } = await readBoardLoadIds(q, now, shell.timezone);
      const facts = await readJourneys(q, ids, now);
      const opts = {
        zone: shell.timezone,
        books: { enabled: flags.books.enabled, startDate: flags.books.startDate, maxAttempts: flags.books.maxAttempts },
      };
      const journeys = [...facts.values()].map((f) => ({ facts: f, steps: journeyStepsOf(f, opts) }));
      const onBoard = journeys.filter((j) => onTheRoad(j.facts, j.steps));
      const rows = sortBoard(onBoard.map((j) => boardRowOf(j.facts, j.steps, { zone: shell.timezone, now: now.getTime() })));
      return {
        shell,
        board: { rows, events: journeyEvents(journeys, shell.timezone, STREAM_LINES), capped },
      };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    // A failed read or a row that does not read: the board cannot be shown, never shown as quiet.
    else if (err instanceof DbError || err instanceof RangeError) problem = "unreadable";
    else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const board = view.board;

  return (
    <SignedInPage tenant={view.shell} current="/road" title="On the road">
      <PageHeader
        title="On the road"
        description="Every load on its way to being paid and recorded, soonest delivery first. Read only."
        actions={board && board.rows.length > 0 ? <LiveRefresh pollSeconds={flags.journey.boardPollSeconds} /> : undefined}
      />
      {!board ? (
        <Card>
          <FeatureOff name="On the road" />
        </Card>
      ) : (
        <>
          <Card className="px-4 sm:px-5">
            {board.rows.length === 0 ? (
              <EmptyState
                icon={<Truck aria-hidden />}
                title="No loads on the road."
                body="A load shows here once it has a driver, and stays until its paystub is paid and recorded."
              />
            ) : (
              <RoadBoard rows={board.rows} />
            )}
            {board.capped ? (
              <p className="border-t border-border py-3 text-small text-foreground-2">Showing the newest {BOARD_LIMIT} loads.</p>
            ) : null}
          </Card>
          <section aria-labelledby="road-stream" className="grid gap-2">
            <h2 id="road-stream" className="text-h3 text-foreground">
              Latest steps
            </h2>
            <Card className="px-4 sm:px-5">
              {board.events.length === 0 ? (
                <EmptyState icon={<Truck aria-hidden />} title="No steps yet." body="Each step a load takes shows here as it happens." />
              ) : (
                <RoadStream lines={board.events} />
              )}
            </Card>
          </section>
        </>
      )}
    </SignedInPage>
  );
}
