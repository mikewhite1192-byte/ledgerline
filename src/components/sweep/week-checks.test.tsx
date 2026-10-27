// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FanoutTree } from "@/lib/sweep/fanout/tree";
import { sampleTrace } from "@/lib/trace/sample";
import { WeekChecks } from "./week-checks";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RUN = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOAD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TURN_A = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";

const tree: FanoutTree = {
  status: "done",
  plan: { summary: "Start with the drivers with the most loads.", turnId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b" },
  skipped: [{ driverId: C, driverCode: "D-003", driverLabel: "Sam Roe", reason: "over_limit" }],
  checks: [
    {
      driverId: A,
      driverCode: "D-001",
      driverLabel: "Pat Lee",
      priority: 1,
      focus: ["no_load_that_day"],
      brief: "A day with no load.",
      status: "done",
      confidence: "high",
      issues: [{ category: "no_load_that_day", sources: [{ table: "loads", id: LOAD }], note: "Paid a day with no load." }],
      turnId: TURN_A,
      costCents: 4,
    },
    {
      driverId: B,
      driverCode: "D-002",
      driverLabel: "Kim Diaz",
      priority: 3,
      focus: [],
      brief: null,
      status: "timed_out",
      confidence: null,
      issues: [],
      turnId: null,
      costCents: 9,
    },
  ],
  reconcile: {
    counts: { engine: 3, agreed: 2, engine_only: 1, spark_only: 1, drivers_checked: 1, drivers_unchecked: 1 },
    summary: "Both checks agree on most of the week.",
    disagreements: [{ driverId: A, driverCode: "D-001", driverLabel: "Pat Lee", category: "no_load_that_day", text: "Only the second check saw this day." }],
    turnId: null,
  },
  finished: true,
};

describe("WeekChecks", () => {
  it("says what the two checks found in the server's counts, and each driver's check in plain words", () => {
    render(<WeekChecks tree={tree} runId={RUN} running={false} />);
    const section = screen.getByRole("region", { name: "How the week was checked" });
    expect(section.textContent).toContain(
      "1 of 2 drivers checked a second time. The second check also found 2 of the 3 problems your pay rules found. It noticed 1 more your pay rules did not; it is under Needs a person.",
    );
    expect(section.textContent).toContain("Muse Wonder: Both checks agree on most of the week.");
    expect(within(screen.getByRole("list", { name: "Where the two checks differ" })).getByText(/Only the second check saw this day/)).toBeTruthy();
    // The driver nodes, not the issue lines nested in them.
    const drivers = Array.from(screen.getByRole("list", { name: "Each driver's check", hidden: true }).children) as HTMLElement[];
    expect(drivers.map((d) => d.textContent)).toEqual([
      expect.stringContaining("High priority · Checked, 1 thing to look at"),
      expect.stringContaining("Low priority · Timed out"),
    ]);
    const link = within(drivers[0]).getByRole("link", { hidden: true });
    expect(link.getAttribute("href")).toContain(LOAD);
    expect(section.textContent).toContain("past this run's limit of drivers: D-003, Sam Roe.");
    // No internal word reaches the page.
    expect(section.textContent?.toLowerCase()).not.toContain("fanout");
  });

  it("reads a driver's steps from the run's own trace route when opened", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ trace: sampleTrace() }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WeekChecks tree={tree} runId={RUN} running={false} />);
    fireEvent.click(screen.getByText(/^Each driver's check/));
    const first = screen.getByRole("list", { name: "Each driver's check" }).children[0] as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: /How this was worked out/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]).toEqual([`/api/sweeps/${RUN}/trace/${TURN_A}`, { cache: "no-store" }]);
  });

  it("says why the second check was skipped or stopped", () => {
    const { unmount } = render(
      <WeekChecks tree={{ ...tree, status: "skipped_daily_cap", checks: [], reconcile: { ...tree.reconcile, counts: null } }} runId={RUN} running={false} />,
    );
    expect(screen.getByRole("note").textContent).toBe("Skipped this run: the day's limit for second checks was reached.");
    expect(screen.queryByText(/^Each driver's check/)).toBeNull();
    unmount();

    render(<WeekChecks tree={{ ...tree, status: "checking", finished: false, reconcile: { ...tree.reconcile, counts: null } }} runId={RUN} running />);
    expect(screen.getByRole("status").textContent).toBe("Checking each driver's week...");
  });

  it("says when the plan step did not answer and when nothing was summarized", () => {
    render(
      <WeekChecks
        tree={{ ...tree, status: "plan_skipped", plan: { summary: null, turnId: null }, reconcile: { ...tree.reconcile, summary: null } }}
        runId={RUN}
        running={false}
      />,
    );
    expect(screen.getByRole("note").textContent).toContain("checked in the usual order");
    expect(screen.getByText("No summary this run.")).toBeTruthy();
  });
});
