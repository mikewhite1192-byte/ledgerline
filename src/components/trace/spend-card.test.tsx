// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NANOCENTS_PER_CENT } from "@/lib/ai/prices";
import { jobScope, jobWords, SpendCard, type SpendAlert, type SpendCardProps } from "./spend-card";

afterEach(cleanup);

const CENT = NANOCENTS_PER_CENT;
const ZONE = "America/Chicago";

const base: SpendCardProps = {
  demo: { spentNanocents: 124 * CENT, capNanocents: 15_000 * CENT },
  wonder: { spentNanocents: 45 * CENT, capNanocents: 4_000 * CENT },
  day: { spentNanocents: 87 * CENT, calls: 12 },
  jobCapNanocents: 1_000 * CENT,
  alerts: [],
  timeZone: ZONE,
};

const open: SpendAlert = {
  id: "alert-open",
  traceId: "9f2c41aa-0000-4000-8000-000000000000",
  purpose: "agent_operator_turn",
  spentNanocents: 1_001 * CENT,
  limitNanocents: 1_000 * CENT,
  createdAt: "2026-10-27T11:05:00.000Z",
  clearedAt: null,
  clearedByEmail: null,
};

const cleared: SpendAlert = {
  ...open,
  id: "alert-cleared",
  traceId: null,
  purpose: "screen_untrusted_input",
  clearedAt: "2026-10-27T11:30:00.000Z",
  clearedByEmail: "owner@example.test",
};

describe("SpendCard", () => {
  it("shows the shared budgets, this carrier's day, the hourly allowance and no stopped jobs", () => {
    render(<SpendCard {...base} />);
    expect(screen.getByText("Spent so far this demo: $1.24 of $150.00.")).toBeTruthy();
    expect(screen.getByText("Muse Wonder's share so far: $0.45 of $40.00.")).toBeTruthy();
    expect(screen.getByText("This carrier, last 24 hours: $0.87 across 12 calls.")).toBeTruthy();
    expect(screen.getByText(/Any one job may spend up to \$10\.00 in the last hour, or since it was last cleared if that is more recent\./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Paused jobs" })).toBeTruthy();
    expect(screen.getByText("No job has gone past its hourly budget.")).toBeTruthy();
  });

  it("says plainly when a cap is not set, so calls are refused", () => {
    render(
      <SpendCard
        {...base}
        demo={{ spentNanocents: 0, capNanocents: null }}
        wonder={{ spentNanocents: 0, capNanocents: null }}
        jobCapNanocents={null}
      />,
    );
    expect(
      screen.getByText("Spent so far this demo: $0.00, with no budget set, so every call is refused."),
    ).toBeTruthy();
    expect(screen.getByText(/so every Muse Wonder call is refused\./)).toBeTruthy();
    expect(screen.getByText("No hourly budget is set for a job, so every call is refused.")).toBeTruthy();
  });

  it("lists a stopped job with what it would have spent, and the Clear control for an admin", () => {
    render(<SpendCard {...base} alerts={[open]} clear={(a) => <button type="button">Clear {a.id}</button>} />);
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Chat answer")).toBeTruthy();
    expect(within(row).getByText("Paused")).toBeTruthy();
    expect(
      within(row).getByText("One answer, reference 9f2c41aa. Would have reached $10.01 in an hour, over its $10.00 hourly budget."),
    ).toBeTruthy();
    expect(within(row).getByText(/Paused Oct 27, 2026, 6:05 AM CDT\. Every call of this job is refused/)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Clear alert-open" })).toBeTruthy();
  });

  it("tells anyone but an admin who can clear it, with no control", () => {
    render(<SpendCard {...base} alerts={[open]} />);
    expect(screen.getByText("An admin can clear it.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows who cleared a job and when, with no control on it", () => {
    render(<SpendCard {...base} alerts={[cleared]} clear={() => <button type="button">Clear</button>} />);
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Screening outside text")).toBeTruthy();
    expect(within(row).getByText("Cleared")).toBeTruthy();
    expect(within(row).getByText(/Every call for this job made outside an answer\./)).toBeTruthy();
    expect(within(row).getByText(/Cleared Oct 27, 2026, 6:30 AM CDT by owner@example\.test\./)).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(within(row).queryByText("An admin can clear it.")).toBeNull();
  });
});

describe("job words", () => {
  it("names the jobs it knows, and spells out any other purpose", () => {
    expect(jobWords("audit_proposal")).toBe("Second check");
    expect(jobWords("pay_sweep_review")).toBe("Model calls for pay sweep review");
    expect(jobWords("constructor")).toBe("Model calls for constructor");
    expect(jobScope({ traceId: null })).toBe("Every call for this job made outside an answer");
  });
});
