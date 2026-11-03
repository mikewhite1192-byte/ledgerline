import type { Queryable } from "../db";
import { localDateOf, type LocalDate } from "../time/local-date";
import { readFeed, type FeedCursor, type FeedRow } from "./read";
import { doneLines, type DoneLine } from "./words";

// The simple Home's "What I did today" lines. The newest rows can all be ones that make no line (a
// failed try, a skipped step, a person's own move), so this reads the feed a page at a time until it
// has enough lines, reaches a row from before today, or has read DONE_PAGES pages. Each page is one
// bounded read; an error on any page fails the whole read.
export const DONE_PAGE_ROWS = 50;
export const DONE_PAGES = 4;

export async function readDoneToday(
  q: Queryable,
  timeZone: string,
  today: LocalDate,
  max = 4,
): Promise<DoneLine[]> {
  const rows: FeedRow[] = [];
  let before: FeedCursor | null = null;
  for (let page = 0; page < DONE_PAGES; page++) {
    const read = await readFeed(q, { limit: DONE_PAGE_ROWS, before });
    rows.push(...read.rows);
    const last = read.rows[read.rows.length - 1];
    if (read.next === null || last === undefined || localDateOf(last.at, timeZone) !== today) break;
    if (doneLines(rows, timeZone, today, max).length >= max) break;
    before = read.next;
  }
  // All the rows read at once, so a draft on one page still drops when its decision is on a newer one.
  return doneLines(rows, timeZone, today, max);
}
