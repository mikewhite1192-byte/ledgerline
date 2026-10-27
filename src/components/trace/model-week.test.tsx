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
    expect(screen.getByText(/Oct 26 to Nov 1, 2026, in Central time\./)).toBeTruthy();
    for (const name of ["Muse Spark", "Muse Wonder", "Muse Spark Open"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.getAllByText("No calls this week.")).toHaveLength(3);
    expect(screen.queryByText("Safety check")).toBeNull();
  });

  it("shows each model's calls, spend and typical time, and the checks around them", () => {
    const week = summarizeModelWeek({
      ...empty,
      groups: [
        { target: "spark", model: "muse-spark-1.3", status: "ok", calls: 12, costNanocents: 8_400_000_000, heldNanocents: 0, unsettled: 0, inputTokens: 0, cachedTokens: 0, savedNanocents: 0 },
        { target: "spark", model: "muse-spark-1.3", status: "reserved", calls: 1, costNanocents: 0, heldNanocents: 900_000_000, unsettled: 1, inputTokens: 0, cachedTokens: 0, savedNanocents: 0 },
        { target: "wonder", model: "muse-wonder-1.0", status: "ok", calls: 2, costNanocents: 11_600_000_000, heldNanocents: 0, unsettled: 0, inputTokens: 0, cachedTokens: 0, savedNanocents: 0 },
        { target: "sam", model: "sam-3.1", status: "ok", calls: 1, costNanocents: 250_000_000, heldNanocents: 0, unsettled: 0, inputTokens: 0, cachedTokens: 0, savedNanocents: 0 },
      ],
      latencies: [{ target: "spark", p50Ms: 1_840 }],
      decisions: [
        { decision: "allowed", count: 9 },
        { decision: "blocked", count: 2 },
      ],
      screenings: [{ verdict: "clean", via: "model", count: 4 }],
      escalations: 1,
    });
    render(<ModelWeekView week={week} />);
    expect(screen.queryByText("No model calls this week")).toBeNull();
    const spark = screen.getByRole("heading", { name: "Muse Spark" }).closest("div.min-w-0") as HTMLElement;
    expect(within(spark).getByText("13")).toBeTruthy();
    expect(within(spark).getByText("8.4 cents")).toBeTruthy();
    expect(within(spark).getByText("1.8 s")).toBeTruthy();
    expect(within(spark).getByText("Held for 1 call not settled")).toBeTruthy();
    expect(within(spark).getByText("Muse Spark 1.3")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "SAM 3.1" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Muse Image" })).toBeNull();
    expect(screen.queryByText(/Demo budget used/)).toBeNull();
    expect(screen.getByText("Safety check")).toBeTruthy();
    expect(screen.getByText("Screening")).toBeTruthy();
  });

  it("shows each model's share of input tokens from the cache and the week's saving, rounded down", () => {
    const week = summarizeModelWeek({
      ...empty,
      groups: [
        { target: "spark", model: "muse-spark-1.3", status: "ok", calls: 4, costNanocents: 2_000_000_000, heldNanocents: 0, unsettled: 0, inputTokens: 10_000, cachedTokens: 7_150, savedNanocents: 7_150 * 110_000 },
        { target: "wonder", model: "muse-wonder-1.0", status: "ok", calls: 1, costNanocents: 5_000_000_000, heldNanocents: 0, unsettled: 0, inputTokens: 900, cachedTokens: 0, savedNanocents: 0 },
      ],
    });
    render(<ModelWeekView week={week} />);
    const spark = screen.getByRole("heading", { name: "Muse Spark" }).closest("div.min-w-0") as HTMLElement;
    expect(within(spark).getByText("From the prompt cache")).toBeTruthy();
    expect(within(spark).getByText("71% of input tokens, saved 0.7 cents at list price")).toBeTruthy();
    const wonder = screen.getByRole("heading", { name: "Muse Wonder" }).closest("div.min-w-0") as HTMLElement;
    expect(within(wonder).getByText("none")).toBeTruthy();
    // 7,150 of 10,900 is 65.6%, shown as 65%; 0.7865 cents saved, shown as 0.7 cents.
    expect(screen.getByText("Prompt cache: 65% of input tokens were cached this week, saving 0.7 cents at list price.")).toBeTruthy();
  });

  it("leaves out the cache lines when no call this week was metered in tokens", () => {
    render(<ModelWeekView week={summarizeModelWeek(empty)} />);
    expect(screen.queryByText(/Prompt cache/)).toBeNull();
    expect(screen.queryByText("From the prompt cache")).toBeNull();
  });
});
