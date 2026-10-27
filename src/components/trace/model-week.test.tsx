// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WeekRaw } from "@/lib/trace/types";
import { summarizeModelWeek } from "@/lib/trace/week";
import { ModelWeekView } from "./model-week";

afterEach(cleanup);

const WEEK = { start: "2026-10-26", end: "2026-11-01", zone: "America/Chicago" };
const empty: WeekRaw = { week: WEEK, groups: [], latencies: [], decisions: [], screenings: [], escalations: 0 };

describe("ModelWeekView", () => {
  it("shows the empty state with a way home, and still explains each model", () => {
    render(<ModelWeekView week={summarizeModelWeek(empty)} />);
    expect(screen.getByText("No model calls this week")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
    expect(screen.getByText(/Oct 26 to Nov 1, 2026, in America\/Chicago time/)).toBeTruthy();
    for (const name of ["Muse Spark", "Muse Wonder", "Muse Spark Open"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.getAllByText("No calls this week.")).toHaveLength(3);
    expect(screen.queryByText("Gateway")).toBeNull();
  });

  it("shows each model's calls, spend and typical time, and the checks around them", () => {
    const week = summarizeModelWeek({
      ...empty,
      groups: [
        { target: "spark", model: "muse-spark-1.3", status: "ok", calls: 12, costNanocents: 8_400_000_000, heldNanocents: 0, unsettled: 0 },
        { target: "spark", model: "muse-spark-1.3", status: "reserved", calls: 1, costNanocents: 0, heldNanocents: 900_000_000, unsettled: 1 },
        { target: "wonder", model: "muse-wonder-1.0", status: "ok", calls: 2, costNanocents: 11_600_000_000, heldNanocents: 0, unsettled: 0 },
        { target: "sam", model: "sam-3.1", status: "ok", calls: 1, costNanocents: 250_000_000, heldNanocents: 0, unsettled: 0 },
      ],
      latencies: [{ target: "spark", p50Ms: 1_840 }],
      decisions: [
        { decision: "allowed", count: 9 },
        { decision: "blocked", count: 2 },
      ],
      screenings: [{ verdict: "clean", via: "model", count: 4 }],
      escalations: 1,
    });
    render(<ModelWeekView week={week} budget={{ spentNanocents: 123_400_000_001, capNanocents: 15_000 * 1_000_000_000 }} />);
    expect(screen.queryByText("No model calls this week")).toBeNull();
    const spark = screen.getByRole("heading", { name: "Muse Spark" }).closest("div.min-w-0") as HTMLElement;
    expect(within(spark).getByText("13")).toBeTruthy();
    expect(within(spark).getByText("8.4 cents")).toBeTruthy();
    expect(within(spark).getByText("1.8 s")).toBeTruthy();
    expect(within(spark).getByText("Held for 1 call not settled")).toBeTruthy();
    expect(within(spark).getByText("Muse Spark 1.3")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "SAM 3.1" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Muse Image" })).toBeNull();
    expect(screen.getByText("Demo budget used, across every carrier: $1.24 of $150.00.", { exact: false })).toBeTruthy();
    expect(screen.getByText("Gateway")).toBeTruthy();
    expect(screen.getByText("Screening")).toBeTruthy();
  });

  it("says when no cap is set instead of showing a number", () => {
    render(<ModelWeekView week={summarizeModelWeek(empty)} budget={{ spentNanocents: 0, capNanocents: null }} />);
    expect(screen.getByText(/with no cap set, so every call is refused/)).toBeTruthy();
  });
});
