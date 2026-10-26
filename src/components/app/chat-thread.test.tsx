// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatThread, type ChatMessage } from "./chat-thread";

afterEach(cleanup);

const suggestions = [
  { id: "s1", label: "Who has a problem on this week's paystub?" },
  { id: "s2", label: "Who owes us money past 60 days?" },
];

const thread: ChatMessage[] = [
  { id: "q1", role: "user", parts: [{ kind: "text", text: "Can the driver get an advance?" }] },
  {
    id: "a1",
    role: "agent",
    parts: [
      {
        kind: "steps",
        steps: [
          { id: "1", label: "Read 3 loads", state: "done" },
          { id: "2", label: "Fuel feed did not answer", state: "failed" },
          { id: "3", label: "Writing up the proposal", state: "running" },
        ],
      },
      {
        kind: "proposal",
        proposal: {
          id: "p-1",
          title: "Pay a $200.00 advance",
          impact: { cents: 20_000, direction: "out" },
          reasons: [],
          status: "proposed",
        },
      },
    ],
  },
];

describe("ChatThread", () => {
  it("offers the suggestions only before the first message", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <ChatThread messages={[]} suggestions={suggestions} onPick={onPick} composer={{ onSubmit: () => undefined }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: suggestions[1].label }));
    expect(onPick).toHaveBeenCalledWith("s2");

    rerender(<ChatThread messages={thread} suggestions={suggestions} onPick={onPick} composer={{}} />);
    expect(screen.queryByRole("button", { name: suggestions[0].label })).toBeNull();
    expect(screen.getByText("Can the driver get an advance?")).toBeTruthy();
  });

  it("names each step's state and announces the newest step", () => {
    render(<ChatThread messages={thread} composer={{}} />);
    expect(screen.getByText("Read 3 loads").textContent).toContain(", done");
    expect(screen.getByText("Fuel feed did not answer").textContent).toContain(", failed");
    expect(screen.getByText("Writing up the proposal").textContent).toContain(", working");
    const live = screen.getByTestId("step-announcer");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("Writing up the proposal, working");
  });

  it("renders a proposal part as a card", () => {
    render(<ChatThread messages={thread} composer={{}} />);
    expect(screen.getByRole("article", { name: "Pay a $200.00 advance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve $200.00" })).toBeTruthy();
  });
});
