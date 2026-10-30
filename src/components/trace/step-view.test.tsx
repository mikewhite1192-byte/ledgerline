// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { recordNamer } from "@/lib/format/labels";
import { recordHref } from "@/lib/records/href";
import { SAMPLE_PROPOSAL_ID, SAMPLE_REASONING_NOTE, SAMPLE_TURN_ID, sampleTrace } from "@/lib/trace/sample";
import { NO_NOTE, turnsOf } from "@/lib/trace/steps";
import type { TurnTrace } from "@/lib/trace/types";
import { HowWorkedOut } from "./how-worked-out";
import { StepView } from "./step-view";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const BLOCKS = ["What it saw", "Its note", "What it did", "What came back"];

async function openPanel(trace: TurnTrace, props: { stepThrough?: boolean; proposalId?: string } = { stepThrough: true }) {
  render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={async () => ({ trace })} {...props} />);
  fireEvent.click(screen.getAllByRole("button", { name: /^How this was worked out/ })[0]);
  await screen.findByRole("heading", { name: "Steps" });
}

async function stepThrough(trace: TurnTrace = sampleTrace()) {
  await openPanel(trace);
  fireEvent.click(screen.getByRole("button", { name: "Step through" }));
  return screen.getByRole("region", { name: "Step through" });
}

const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));

describe("Step through", () => {
  it("is not offered unless the page turns it on", async () => {
    await openPanel(sampleTrace(), {});
    expect(screen.getByRole("list", { name: "Steps, in order" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Step through" })).toBeNull();
  });

  it("is not offered under a card, whose steps are a part of the answer's", async () => {
    await openPanel(sampleTrace(), { stepThrough: true, proposalId: SAMPLE_PROPOSAL_ID });
    expect(screen.queryByRole("button", { name: "Step through" })).toBeNull();
  });

  it("is not offered when no model was called", async () => {
    const trace = { ...sampleTrace(), steps: sampleTrace().steps.filter((s) => s.kind !== "model") };
    await openPanel(trace);
    expect(screen.getByRole("list", { name: "Steps, in order" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Step through" })).toBeNull();
  });

  it("swaps the list for one model call at a time, and back", async () => {
    await openPanel(sampleTrace());
    const toggle = screen.getByRole("button", { name: "Step through" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Step through" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Steps, in order" })).toBeNull();
    // The whole answer's Details give way to each turn's own.
    expect(screen.queryByRole("list", { name: "Details for each step" })).toBeNull();
    // The models used and the totals stay.
    expect(screen.getByRole("list", { name: "Models used" })).toBeTruthy();
    expect(screen.getByText("5 model calls, 2.6 cents in all, 7.4 s of model time")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("region", { name: "Step through" })).toBeNull();
    expect(screen.getByRole("list", { name: "Steps, in order" })).toBeTruthy();
  });

  it("counts the turns and moves with Previous and Next, which stop at the ends", async () => {
    const view = await stepThrough();
    const counter = within(view).getByText("Turn 1 of 4");
    expect(counter.getAttribute("aria-live")).toBe("polite");
    const previous = within(view).getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    const nextButton = within(view).getByRole("button", { name: "Next" }) as HTMLButtonElement;
    // Previous comes first, in reading and tab order.
    expect(previous.compareDocumentPosition(nextButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(previous.disabled).toBe(true);
    expect(nextButton.disabled).toBe(false);
    next();
    expect(within(view).getByText("Turn 2 of 4")).toBeTruthy();
    expect(previous.disabled).toBe(false);
    next();
    next();
    expect(within(view).getByText("Turn 4 of 4")).toBeTruthy();
    expect(nextButton.disabled).toBe(true);
    fireEvent.click(previous);
    expect(within(view).getByText("Turn 3 of 4")).toBeTruthy();
  });

  it("shows four blocks for each turn", async () => {
    const view = await stepThrough();
    for (let i = 0; i < 4; i++) {
      expect(within(view).getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual(BLOCKS);
      if (i < 3) next();
    }
  });

  it("shows the model's note when it returned one, and says so when it did not", async () => {
    const view = await stepThrough();
    expect(within(view).getByText(NO_NOTE)).toBeTruthy();
    next();
    expect(within(view).getByText(SAMPLE_REASONING_NOTE)).toBeTruthy();
    expect(within(view).queryByText(NO_NOTE)).toBeNull();
  });

  it("shows the tools it asked for and what came back, with the records and the size", async () => {
    const view = await stepThrough();
    expect(within(view).getByText("Planned the next step: asked for 1 tool")).toBeTruthy();
    const asked = within(view).getByRole("list", { name: "Tools it asked for" });
    expect([...asked.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Reading pay items"]);
    const back = within(view).getByRole("list", { name: "What came back" });
    expect(within(back).getByText("Reading pay items: passed the safety check")).toBeTruthy();
    expect(within(back).getByText("2 records, 1,240 characters back")).toBeTruthy();
    expect(within(back).getByText("Screened outside text before the agent read it: clean")).toBeTruthy();
    expect(within(back).getAllByRole("link", { name: "Pay item" })[0].getAttribute("href")).toMatch(/^\/records\/pay_items\//);
    next();
    // The second call saw what the first one's tool sent back.
    const earlier = within(view).getByRole("list", { name: "What the earlier steps sent back" });
    expect(earlier.textContent).toBe("Reading pay items: passed the safety check (2 records)");
    expect(within(view).getByText("Blocked")).toBeTruthy();
  });

  it("says the last call wrote the answer", async () => {
    const view = await stepThrough();
    next();
    next();
    next();
    expect(within(view).getByText("Wrote the answer")).toBeTruthy();
    expect(within(view).queryByRole("list", { name: "Tools it asked for" })).toBeNull();
    expect(within(view).getByText("Nothing more: this step wrote the answer.")).toBeTruthy();
  });

  it("says when nothing came back for a call that did not write the answer", async () => {
    const base = sampleTrace();
    const trace = { ...base, steps: [{ ...base.steps[0], state: "failed" }], extraCalls: [], proposals: [] };
    const view = await stepThrough(trace);
    expect(within(view).getByText("Nothing came back for this step.")).toBeTruthy();
  });

  it("lists the summary's parts and opens its text only when asked", async () => {
    const view = await stepThrough();
    expect(within(view).getByText(/^The summary of your records this answer started from, \d+ characters:$/)).toBeTruthy();
    const parts = within(view).getByRole("list", { name: "Parts of the summary" });
    expect([...parts.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Your carrier, its time zone and today's date, 3 lines",
      "Your pay rules, 3 lines",
      "Who or what the question is about, 1 line",
    ]);
    const show = within(view).getByRole("button", { name: "Show the summary" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(view.querySelector("[data-verbatim]")).toBeNull();
    fireEvent.click(show);
    expect(show.getAttribute("aria-expanded")).toBe("true");
    expect(show.textContent).toBe("Hide the summary");
    const text = view.querySelector("[data-verbatim='summary']") as HTMLElement;
    expect(text.textContent).toBe(sampleTrace().contextSummary);
    expect(document.getElementById(show.getAttribute("aria-controls") ?? "")?.contains(text)).toBe(true);
    fireEvent.click(show);
    expect(view.querySelector("[data-verbatim]")).toBeNull();
  });

  it("shows the summary as text, never as markup", async () => {
    const trace = { ...sampleTrace(), contextSummary: "Carrier:\n<b>bold</b> <img src=x onerror=alert(1)>" };
    const view = await stepThrough(trace);
    fireEvent.click(within(view).getByRole("button", { name: "Show the summary" }));
    const text = view.querySelector("[data-verbatim='summary']") as HTMLElement;
    expect(text.textContent).toBe("Carrier:\n<b>bold</b> <img src=x onerror=alert(1)>");
    expect(text.querySelector("b, img")).toBeNull();
  });

  it("says when the summary was not kept for an answer", async () => {
    const view = await stepThrough({ ...sampleTrace(), contextSummary: undefined });
    expect(within(view).getByText("The summary this answer started from was not kept for it.")).toBeTruthy();
    expect(within(view).queryByRole("button", { name: "Show the summary" })).toBeNull();
  });

  it("shows on the first turn what was read before the first call", async () => {
    const base = sampleTrace();
    const trace = {
      ...base,
      steps: [{ ...base.steps[0], seq: 0, kind: "screen", label: "Reading the office's notes", call: null, toolCalls: null }, ...base.steps],
    };
    const view = await stepThrough(trace);
    const before = within(view).getByRole("list", { name: "Read before this step" });
    expect(before.textContent).toBe("Reading the office's notes");
    next();
    expect(within(view).queryByRole("list", { name: "Read before this step" })).toBeNull();
  });

  it("keeps each turn's effort under its own Details", async () => {
    const view = await stepThrough();
    const details = within(view).getByRole("list", { name: "Details for this turn", hidden: true });
    expect(within(details).getAllByText("Asked for low effort", { exact: false }).length).toBeGreaterThan(0);
    expect((details.closest("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("shows nothing for a trace with no turns", () => {
    const { container } = render(
      <StepView
        through={{ summary: null, summaryText: null, turns: [] }}
        hrefFor={recordHref}
        name={recordNamer([])}
        fullSummary
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows only the summary's parts when its text is not to be shown", () => {
    render(<StepView through={turnsOf(sampleTrace())} hrefFor={recordHref} name={recordNamer([])} fullSummary={false} />);
    expect(screen.getByRole("list", { name: "Parts of the summary" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show the summary" })).toBeNull();
    expect(document.querySelector("[data-verbatim]")).toBeNull();
  });
});
