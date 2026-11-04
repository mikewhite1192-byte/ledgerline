import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../db";
import type { FeedCursor, FeedRow } from "./read";

// Today's lines on the simple Home, from fixed feed pages: older pages are read when the newest rows
// make no line, and the reads stop at yesterday, at enough lines, or at the page cap.

const mocks = vi.hoisted(() => ({ readFeed: vi.fn() }));
vi.mock("./read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./read")>()),
  readFeed: mocks.readFeed,
}));
const { DONE_PAGES, DONE_PAGE_ROWS, readDoneToday } = await import("./done-today");

const ZONE = "America/Chicago";
const TODAY = "2026-11-10";
const q = {} as Queryable;

function row(key: string, at: string, over: Partial<FeedRow> = {}): FeedRow {
  return {
    key,
    at,
    event: "desk_done",
    actor: "desk",
    cents: null,
    direction: null,
    title: null,
    driver: null,
    kind: "document",
    code: null,
    reason: null,
    count: null,
    limitCents: null,
    dayLimitCents: null,
    until: null,
    channel: null,
    system: null,
    once: false,
    record: null,
    ...over,
  };
}
// A page of rows that make no line: a person's own move, today (Nov 10 in Chicago).
const noLines = (page: number): FeedRow[] =>
  Array.from({ length: DONE_PAGE_ROWS }, (_, i) =>
    row(`desk:${page}-${i}`, `2026-11-10T2${3 - page}:${String(59 - i).padStart(2, "0")}:00.000000Z`, { actor: "staff" }),
  );
const cursorOf = (rows: FeedRow[]): FeedCursor => ({ at: rows[rows.length - 1].at, key: rows[rows.length - 1].key });

beforeEach(() => mocks.readFeed.mockReset());

describe("readDoneToday", () => {
  it("reads the next page when the newest rows make no line, and finds an older line from today", async () => {
    const first = noLines(0);
    mocks.readFeed
      .mockResolvedValueOnce({ rows: first, next: cursorOf(first) })
      .mockResolvedValueOnce({ rows: [row("desk:old", "2026-11-10T15:10:00.000000Z")], next: null });
    const lines = await readDoneToday(q, ZONE, TODAY);
    expect(lines.map((l) => [l.time, l.words])).toEqual([["9:10 AM", "Read a document."]]);
    expect(mocks.readFeed.mock.calls.map((c) => c[1])).toEqual([
      { limit: DONE_PAGE_ROWS, before: null },
      { limit: DONE_PAGE_ROWS, before: cursorOf(first) },
    ]);
  });

  it("stops once a page reaches yesterday, once it has enough lines, and at the page cap", async () => {
    const yesterday = [row("desk:y", "2026-11-10T05:30:00.000000Z")];
    mocks.readFeed.mockResolvedValueOnce({ rows: yesterday, next: cursorOf(yesterday) });
    expect(await readDoneToday(q, ZONE, TODAY)).toEqual([]);
    expect(mocks.readFeed).toHaveBeenCalledTimes(1);

    mocks.readFeed.mockReset();
    const full = Array.from({ length: 4 }, (_, i) => row(`desk:f${i}`, `2026-11-10T20:0${i}:00.000000Z`));
    mocks.readFeed.mockResolvedValue({ rows: full, next: cursorOf(full) });
    expect(await readDoneToday(q, ZONE, TODAY)).toHaveLength(4);
    expect(mocks.readFeed).toHaveBeenCalledTimes(1);

    mocks.readFeed.mockReset();
    mocks.readFeed.mockImplementation(async () => {
      const page = noLines(0);
      return { rows: page, next: cursorOf(page) };
    });
    expect(await readDoneToday(q, ZONE, TODAY)).toEqual([]);
    expect(mocks.readFeed).toHaveBeenCalledTimes(DONE_PAGES);
  });

  it("fails the whole read when a page cannot be read", async () => {
    const first = noLines(0);
    mocks.readFeed.mockResolvedValueOnce({ rows: first, next: cursorOf(first) }).mockRejectedValueOnce(new Error("timeout"));
    await expect(readDoneToday(q, ZONE, TODAY)).rejects.toThrow("timeout");
  });
});
